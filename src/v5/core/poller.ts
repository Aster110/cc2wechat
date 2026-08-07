import type { WeixinMessage } from '../../types.js';
import type { AccountData } from '../../store.js';
import { getUpdates, sendMessage, sendTyping, getConfig } from '../../wechat-api.js';
import { loadSyncBuf, saveSyncBuf } from '../../store.js';
import { extractText, userIdToSessionUUID, log, logError } from '../../utils.js';

import { downloadMediaItems } from '../receiver/media.js';
import { writeReplyContext } from '../sender/wechat-sender.js';
import type { Router } from './router.js';
import type { CommandGateway } from './command-gateway.js';
import type { Delivery, AIBackend, MessageContext } from '../interfaces/index.js';

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;
/** "正在输入"心跳间隔。微信端的 typing 状态会自己过期，慢后端（codex 一轮几分钟）必须续。 */
const TYPING_HEARTBEAT_MS = 15_000;
/**
 * 超过这个时间还没答完，先给用户一句"还在处理"，免得他以为掉线了。
 *
 * 默认 60s：codex 这类后端一轮动辄半分钟起步，阈值定太低会**每条都触发**，
 * 那就不是信号而是噪音了（"正在输入"心跳才是常态提示）。
 * `CC2WECHAT_ACK_MS=0` 彻底关掉。
 */
function slowAckMs(): number {
  const raw = process.env.CC2WECHAT_ACK_MS;
  if (raw == null || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 持续发"正在输入"，直到返回的 stop() 被调用。
 * 注意 ticket 必须从 getConfig 拿——空 ticket 发了等于没发（v5 早期就踩在这）。
 */
function startTypingHeartbeat(
  account: AccountData,
  userId: string,
  contextToken: string,
): () => void {
  let stopped = false;
  let ticket = '';
  let timer: NodeJS.Timeout | null = null;

  const ping = (status: 1 | 2): void => {
    if (!ticket) return;
    sendTyping(account.token, userId, ticket, status, account.baseUrl).catch(() => {});
  };

  void (async () => {
    try {
      const cfg = await getConfig(account.token, userId, contextToken, account.baseUrl);
      ticket = cfg.typing_ticket ?? '';
    } catch {
      return; // 拿不到 ticket 就安静放弃，不影响正事
    }
    if (stopped || !ticket) return;
    ping(1);
    timer = setInterval(() => ping(1), TYPING_HEARTBEAT_MS);
  })();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    ping(2);
  };
}

export interface ProcessMessageDeps {
  account: AccountData;
  router: Router;
  delivery: Delivery;
  backend: AIBackend;
  gateway: CommandGateway;
  cwd: string;
  accountName?: string;
}

export async function processMessage(msg: WeixinMessage, deps: ProcessMessageDeps): Promise<void> {
  if (msg.message_type !== 1) return;

  const { account, router, delivery, backend, gateway, cwd, accountName } = deps;

  const mediaPaths = await downloadMediaItems(msg, account);
  const text = extractText(msg, mediaPaths);
  const userId = msg.from_user_id ?? '';
  const contextToken = msg.context_token ?? '';

  log(`<- ${userId.slice(0, 10)}...: ${text.slice(0, 50)}`);

  const handled = await gateway.tryHandle({
    userId, contextToken, text,
    delivery,
    reply: (t) => sendMessage(account.token, userId, t, contextToken, account.baseUrl),
    closeSession: (uid) => delivery.closeSession(uid),
    createNewSession: (uid) => delivery.createSession(uid, backend, cwd),
  });
  if (handled) return;

  writeReplyContext(account, userId, contextToken);

  const stopTyping = startTypingHeartbeat(account, userId, contextToken);
  const ackMs = slowAckMs();
  const slowAck = ackMs > 0
    ? setTimeout(() => {
        sendMessage(account.token, userId, '收到，正在处理…', contextToken, account.baseUrl).catch(() => {});
      }, ackMs)
    : null;

  const ctx: MessageContext & { mediaPaths: Map<number, string> } = {
    text,
    mediaFiles: [...mediaPaths.values()],
    mediaPaths,
    userId,
    sessionId: userIdToSessionUUID(userId),
    contextToken,
    rawMessage: msg,
    account,
    cwd,
    accountName: accountName ?? undefined,
  };

  try {
    await router.handle(ctx);
  } finally {
    if (slowAck) clearTimeout(slowAck);
    stopTyping();
  }
}

/**
 * 每个用户一条串行队列：同一个人的消息保持先来后到，
 * 但**不阻塞轮询循环**——否则后端跑几分钟期间不去长轮询，
 * 微信端看不到机器人的连接，就显示"暂时无法连接"。
 */
class UserQueues {
  private chains = new Map<string, Promise<void>>();

  enqueue(userId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => logError(`processMessage failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.chains.get(userId) === next) this.chains.delete(userId);
      });
    this.chains.set(userId, next);
  }

  get depth(): number {
    return this.chains.size;
  }
}

export async function pollLoop(
  account: AccountData,
  router: Router,
  cwd: string,
  delivery: Delivery,
  backend: AIBackend,
  gateway: CommandGateway,
  accountName?: string,
): Promise<void> {
  let buf = loadSyncBuf(account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  log(`Polling started for account ${account.accountId}`);

  const deps: ProcessMessageDeps = { account, router, delivery, backend, gateway, cwd, accountName };
  const queues = new UserQueues();

  while (true) {
    try {
      const resp = await getUpdates(account.token, buf, account.baseUrl, nextTimeoutMs);

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          log(`Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing ${Math.ceil(SESSION_PAUSE_MS / 60_000)} min`);
          consecutiveFailures = 0;
          await sleep(SESSION_PAUSE_MS);
          continue;
        }

        consecutiveFailures++;
        logError(
          `getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        saveSyncBuf(account.accountId, resp.get_updates_buf);
        buf = resp.get_updates_buf;
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        // 不 await：交给用户队列后台跑，循环立刻回去长轮询
        queues.enqueue(msg.from_user_id ?? '', () => processMessage(msg, deps));
      }
    } catch (err) {
      consecutiveFailures++;
      const errMsg = err instanceof Error
        ? `${err.message}${err.cause ? ` | cause: ${String(err.cause)}` : ''}${err.stack ? `\n${err.stack.split('\n').slice(1, 3).join('\n')}` : ''}`
        : String(err);
      logError(
        `Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errMsg}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS);
      } else {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}
