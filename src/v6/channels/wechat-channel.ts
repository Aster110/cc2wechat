import { createHash } from 'node:crypto';

import type { AccountData } from '../../store.js';
import type { WeixinMessage } from '../../types.js';
import { getUpdates, sendMessage, sendTyping, getConfig } from '../../wechat-api.js';
import { loadSyncBuf as defaultLoadSyncBuf, saveSyncBuf as defaultSaveSyncBuf } from '../../store.js';
import { extractText, log, logError } from '../../utils.js';
import { downloadMediaItems } from '../../v5/receiver/media.js';
import { Replier } from '../../v5/sender/replier.js';
import { createWeChatSender } from '../../v5/sender/wechat-sender.js';
import type { MessageContext } from '../../v5/interfaces/index.js';

import { writeReplyRoute } from '../reply-context.js';
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelMessage,
  ChannelReply,
  ChannelStartContext,
  ChannelTurnAware,
} from './contracts.js';

/**
 * 微信通道 —— 把 poller.ts 的长轮询与 orchestrator.ts 里的微信专属 UX 原地搬进壳里。
 *
 * 下面这些常量与分支是**疤组织**,每一条对应一次真实事故,搬家可以、改语义不行:
 * - errcode/ret = -14 是"会话过期",要暂停 5 分钟且**不计入连败**(它不是网络问题,
 *   重试只会更快把自己撞死)
 * - 连败 3 次退避 30s,否则 2s 重试;`longpolling_timeout_ms` 跟服务端走
 * - 收信循环**绝不 await 派发** —— 一旦这里等后端,微信端就看不到机器人的连接,
 *   直接显示"暂时无法连接"
 * - typing 的 ticket 必须 getConfig 拿(空 ticket 发了等于没发),15s 续一次,
 *   结束发 status 2 —— 否则用户一直看到"正在输入"
 *
 * Core 眼里这只是个 ChannelAdapter:它不知道什么是 accountId、contextToken、typing。
 */

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;
const DEFAULT_LONG_POLL_MS = 35_000;
/** "正在输入"心跳间隔。微信端的 typing 状态会自己过期,慢后端(codex 一轮几分钟)必须续。 */
const TYPING_HEARTBEAT_MS = 15_000;

export const WECHAT_CHANNEL_NAME = 'wechat';

export interface WeChatChannelOptions {
  account: AccountData;
  /** ctx 路由文件的家目录,测试注入用 */
  home?: string;
  loadSyncBuf?: (accountId: string) => string;
  saveSyncBuf?: (accountId: string, buf: string) => void;
  retryDelayMs?: number;
  reply?: { maxChunkSize?: number; stripMarkdown?: boolean };
}

/**
 * 超过这个时间还没答完,先给用户一句"还在处理",免得他以为掉线了。
 *
 * 默认 60s:codex 这类后端一轮动辄半分钟起步,阈值定太低会**每条都触发**,
 * 那就不是信号而是噪音了("正在输入"心跳才是常态提示)。
 * `CC2WECHAT_ACK_MS=0` 彻底关掉。
 */
function slowAckMs(): number {
  const raw = process.env.CC2WECHAT_ACK_MS;
  if (raw == null || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/** 平台没给可靠 id 时的兜底:同一个人 + 同一时刻 + 同样内容 = 同一条 */
function messageId(msg: WeixinMessage): string {
  if (msg.message_id != null) return `id:${msg.message_id}`;
  const body = createHash('sha256').update(JSON.stringify(msg.item_list ?? [])).digest('hex').slice(0, 16);
  return `fb:${msg.from_user_id ?? ''}|${msg.create_time_ms ?? 0}|${body}`;
}

export class WeChatChannel implements ChannelAdapter, ChannelTurnAware {
  readonly name = WECHAT_CHANNEL_NAME;
  readonly descriptor = { sourceLabel: '[微信]' };

  private readonly account: AccountData;
  private readonly home?: string;
  private readonly loadBuf: (accountId: string) => string;
  private readonly saveBuf: (accountId: string, buf: string) => void;
  private readonly retryDelay: number;
  private readonly replier: Replier;

  /** endpointId(= 微信 userId)→ 最近一次的 context_token。发送与 typing 都要它 */
  private contextTokens = new Map<string, string>();

  private stopping = new AbortController();
  private loopDone: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  private lastOkAt = 0;
  /** 退避用:到阈值就清零重数(与现网逐条对齐) */
  private consecutiveFailures = 0;
  /** 观测用:只有真正成功才清零 —— 否则退避一次就把"一直在失败"洗成"健康" */
  private failStreak = 0;
  private sessionExpired = false;
  private lastError = '';

  constructor(opts: WeChatChannelOptions) {
    this.account = opts.account;
    this.home = opts.home;
    this.loadBuf = opts.loadSyncBuf ?? defaultLoadSyncBuf;
    this.saveBuf = opts.saveSyncBuf ?? defaultSaveSyncBuf;
    this.retryDelay = opts.retryDelayMs ?? RETRY_DELAY_MS;
    this.replier = new Replier(createWeChatSender(this.account), {
      maxChunkSize: opts.reply?.maxChunkSize ?? 3900,
      stripMarkdown: opts.reply?.stripMarkdown ?? true,
    });
  }

  // ---- ChannelAdapter ----------------------------------------------------

  async start(ctx: ChannelStartContext): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 立刻 resolve:收信循环在后台跑。start() 里 await 整个生命周期
    // 会把 bootstrap 挂死(其他通道永远挂不上)。
    this.loopDone = this.loop(ctx).catch((err) => {
      logError(`wechat poll loop crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async send(endpointId: string, reply: ChannelReply): Promise<void> {
    const ctx = this.messageContext(endpointId);
    await this.replier.reply(ctx, reply.text);
    for (const file of reply.mediaFiles ?? []) {
      await this.replier.replyMedia(ctx, file);
    }
  }

  health(): ChannelHealth {
    if (this.stopped) return { ok: false, detail: '已停止', lastOkAt: this.lastOkAt || undefined };
    if (!this.started) return { ok: false, detail: '未启动' };
    if (this.sessionExpired) {
      return { ok: false, detail: `会话过期(errcode ${SESSION_EXPIRED_ERRCODE}),暂停中`, lastOkAt: this.lastOkAt || undefined };
    }
    if (this.failStreak >= MAX_CONSECUTIVE_FAILURES) {
      return {
        ok: false,
        detail: `连续失败 ${this.failStreak} 次:${this.lastError}`,
        lastOkAt: this.lastOkAt || undefined,
      };
    }
    if (this.lastOkAt === 0) return { ok: false, detail: '尚未跑通第一次长轮询' };
    return { ok: true, lastOkAt: this.lastOkAt };
  }

  /**
   * 停机。
   *
   * **不等在飞的那次长轮询** —— getUpdates 收不了 AbortSignal,等它最坏要 35 秒,
   * 而 systemd/launchd 给的窗口只有 10 秒。abort 之后循环再也不会派发任何东西
   * (下面 loop 里 await 回来第一件事就是查这个信号),留一个即将 resolve 的 fetch
   * 不影响正确性。sleep 是可打断的,所以退避/暂停中的循环会立刻自己收摊。
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping.abort();
  }

  // ---- ChannelTurnAware --------------------------------------------------

  /**
   * 一轮的微信 UX:typing 心跳 + 慢提示。
   * Core 不知道这些东西存在,它只负责在 turn 开始时调一下、结束时调返回的函数。
   */
  beginTurn(msg: ChannelMessage): () => void {
    const userId = msg.endpointId;
    const contextToken = this.contextTokens.get(userId) ?? '';
    const stopTyping = this.startTypingHeartbeat(userId, contextToken);

    const ackMs = slowAckMs();
    const slowAck =
      ackMs > 0
        ? setTimeout(() => {
            sendMessage(this.account.token, userId, '收到，正在处理…', contextToken, this.account.baseUrl).catch(() => {});
          }, ackMs)
        : null;

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (slowAck) clearTimeout(slowAck);
      stopTyping();
    };
  }

  // ---- 内部:收信 --------------------------------------------------------

  private async loop(ctx: ChannelStartContext): Promise<void> {
    const { account } = this;
    let buf = this.loadBuf(account.accountId);
    let nextTimeoutMs = DEFAULT_LONG_POLL_MS;

    log(`Polling started for account ${account.accountId}`);

    while (!this.stopping.signal.aborted) {
      try {
        const resp = await getUpdates(account.token, buf, account.baseUrl, nextTimeoutMs);
        // 停机信号可能在这次长轮询在飞的时候到:到了就一条都不许再派发
        if (this.stopping.signal.aborted) return;

        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          const isSessionExpired =
            resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

          if (isSessionExpired) {
            log(`Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing ${Math.ceil(SESSION_PAUSE_MS / 60_000)} min`);
            // -14 不是网络抖动,是凭证问题:清零连败,老老实实躺 5 分钟
            this.consecutiveFailures = 0;
            this.sessionExpired = true;
            await this.sleep(SESSION_PAUSE_MS);
            continue;
          }

          this.consecutiveFailures++;
          this.failStreak++;
          this.lastError = `ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`.trim();
          logError(
            `getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          );
          await this.backoff();
          continue;
        }

        this.consecutiveFailures = 0;
        this.failStreak = 0;
        this.sessionExpired = false;
        this.lastOkAt = Date.now();

        if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
          this.saveBuf(account.accountId, resp.get_updates_buf);
          buf = resp.get_updates_buf;
        }

        for (const msg of resp.msgs ?? []) {
          // 不 await:媒体下载与派发交给后台,循环立刻回去长轮询。
          // 一旦这里等,微信端就看不到机器人的连接,显示"暂时无法连接"。
          void this.intake(msg, ctx).catch((err) => {
            logError(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        this.consecutiveFailures++;
        this.failStreak++;
        const errMsg =
          err instanceof Error
            ? `${err.message}${err.cause ? ` | cause: ${String(err.cause)}` : ''}${err.stack ? `\n${err.stack.split('\n').slice(1, 3).join('\n')}` : ''}`
            : String(err);
        this.lastError = err instanceof Error ? err.message : String(err);
        logError(`Poll error (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errMsg}`);
        await this.backoff();
      }
    }
  }

  private async backoff(): Promise<void> {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.consecutiveFailures = 0;
      await this.sleep(BACKOFF_DELAY_MS);
    } else {
      await this.sleep(this.retryDelay);
    }
  }

  /** 一条原始微信消息 → 标准 ChannelMessage → 交给 Core */
  private async intake(msg: WeixinMessage, ctx: ChannelStartContext): Promise<void> {
    if (msg.message_type !== 1) return;

    const id = messageId(msg);
    // 重传风暴不该变成媒体下载风暴:Core 早见过就别下了。
    // Core 仍是去重的唯一权威(这里只是省一次昂贵动作)。
    if (ctx.isDuplicate?.(id)) {
      log(`skip duplicate message ${id}`);
      return;
    }

    const userId = msg.from_user_id ?? '';
    const contextToken = msg.context_token ?? '';
    this.contextTokens.set(userId, contextToken);

    const mediaMap = await downloadMediaItems(msg, this.account);
    const text = extractText(msg, mediaMap);
    const mediaPaths = [...mediaMap.values()];

    try {
      // port 决定 reply-cli 去哪个 accounts-<port>.json 查 token,
      // 账号记录里没写就退回本进程的端口(daemon 自己的门牌号)
      const port = this.account.port ?? Number(process.env.CC2WECHAT_PORT ?? 18081);
      writeReplyRoute({ userId, contextToken, port, accountId: this.account.accountId }, this.home);
    } catch (err) {
      logError(`write reply route failed: ${String(err)}`);
    }

    ctx.deliver({
      id,
      channel: this.name,
      endpointId: userId,
      text,
      mediaPaths,
      receivedAt: Date.now(),
    });
  }

  // ---- 内部:发送侧 ------------------------------------------------------

  private messageContext(endpointId: string): MessageContext {
    return {
      text: '',
      mediaFiles: [],
      userId: endpointId,
      sessionId: '',
      contextToken: this.contextTokens.get(endpointId) ?? '',
      rawMessage: null,
      account: this.account,
      cwd: '',
    };
  }

  /**
   * 持续发"正在输入",直到返回的 stop() 被调用。
   * ticket 必须从 getConfig 拿 —— 空 ticket 发了等于没发(v5 早期就踩在这)。
   */
  private startTypingHeartbeat(userId: string, contextToken: string): () => void {
    const { account } = this;
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
        return; // 拿不到 ticket 就安静放弃,不影响正事
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

  /** 可被 stop() 提前叫醒 —— 否则停机要等满 5 分钟的 -14 暂停 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stopping.signal;
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
