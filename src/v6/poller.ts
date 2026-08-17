import { createHash } from 'node:crypto';

import type { WeixinMessage } from '../types.js';
import type { AccountData } from '../store.js';
import { getUpdates, sendMessage } from '../wechat-api.js';
import { loadSyncBuf as defaultLoadSyncBuf, saveSyncBuf as defaultSaveSyncBuf } from '../store.js';
import { extractText, log, logError } from '../utils.js';
import { downloadMediaItems } from '../v5/receiver/media.js';

import type { AgentAdapter, IncomingMessage, Scheduler, SessionStore, TurnTiming } from './contracts.js';
import { deriveConversationId } from './session-store.js';
import { tryHandleCommand } from './commands.js';
import { writeReplyRoute } from './reply-context.js';
import type { TurnResult } from './orchestrator.js';

// ---- 轮询常量:与 v5 逐条对齐,生产两台机器跑了几个月的口径,别动 ----
const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;
const DEFAULT_LONG_POLL_MS = 35_000;

const DEDUPE_CAPACITY = 200;
const IDLE_SWEEP_INTERVAL_MS = 10 * 60_000;
// 复杂 Agent 任务没有稳定的墙钟上限。默认不机械中止；
// 仍可用 CC2WECHAT_TURN_TIMEOUT_MS 显式配置运维安全阀，0 = 禁用。
const DEFAULT_TURN_TIMEOUT_MS = 0;
const DEFAULT_SESSION_TTL_MS = 43_200_000; // 12h

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function turnTimeoutMs(): number {
  return envMs('CC2WECHAT_TURN_TIMEOUT_MS', DEFAULT_TURN_TIMEOUT_MS);
}

export function sessionTtlMs(): number {
  return envMs('CC2WECHAT_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS);
}

// ---------------------------------------------------------------------------
// 每轮观测
// ---------------------------------------------------------------------------

export interface TurnRing {
  push(timing: TurnTiming): void;
  list(): TurnTiming[];
}

/** /health 里"最近 N 轮"的来源。内存里放 20 条,没有磁盘成本。 */
export class TurnRingBuffer implements TurnRing {
  private items: TurnTiming[] = [];
  constructor(private capacity = 20) {}

  push(timing: TurnTiming): void {
    this.items.push(timing);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  list(): TurnTiming[] {
    return [...this.items];
  }
}

// ---------------------------------------------------------------------------
// 派发
// ---------------------------------------------------------------------------

export interface DispatcherDeps {
  account: AccountData;
  accountName?: string;
  cwd: string;
  agent: AgentAdapter;
  scheduler: Scheduler;
  /** noteUser 是 FileSessionStore 的补充能力(legacy 迁移用),没有也能跑 */
  store: SessionStore & { noteUser?(conversationId: string, userId: string): void };
  orchestrator: { runTurn(msg: IncomingMessage, signal: AbortSignal): Promise<TurnResult> };
  turns: TurnRing;
  /** ctx 路由文件的家目录,测试注入用 */
  home?: string;
  dedupeCapacity?: number;
}

function dedupeKey(msg: WeixinMessage): string {
  if (msg.message_id != null) return `id:${msg.message_id}`;
  // 平台没给可靠 id 时的兜底:同一个人 + 同一时刻 + 同样内容 = 同一条
  const body = createHash('sha256').update(JSON.stringify(msg.item_list ?? [])).digest('hex').slice(0, 16);
  return `fb:${msg.from_user_id ?? ''}|${msg.create_time_ms ?? 0}|${body}`;
}

export class MessageDispatcher {
  private seen = new Set<string>();
  private readonly capacity: number;

  constructor(private deps: DispatcherDeps) {
    this.capacity = deps.dedupeCapacity ?? DEDUPE_CAPACITY;
  }

  async handle(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== 1) return;

    const key = dedupeKey(msg);
    if (this.seen.has(key)) {
      log(`skip duplicate message ${key}`);
      return;
    }
    this.remember(key);

    const { account, agent, scheduler, store, orchestrator, turns, cwd, home } = this.deps;
    const userId = msg.from_user_id ?? '';
    const contextToken = msg.context_token ?? '';
    const conversationId = deriveConversationId(account.accountId, userId);
    store.noteUser?.(conversationId, userId);

    const reply = (text: string): Promise<void> =>
      sendMessage(account.token, userId, text, contextToken, account.baseUrl);

    const mediaMap = await downloadMediaItems(msg, account);
    const text = extractText(msg, mediaMap);
    const mediaPaths = [...mediaMap.values()];

    log(`<- ${userId.slice(0, 10)}...: ${text.slice(0, 50)}`);

    // 抢占通道:控制命令**在入队之前**处理。
    // 排在长任务后面的 /stop 等于没有 /stop —— v5 就是这个毛病。
    const handled = await tryHandleCommand(text, { conversationId, reply, scheduler, store, agent }).catch((err) => {
      logError(`command failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    });
    if (handled) return;

    try {
      // port 决定 reply-cli 去哪个 accounts-<port>.json 查 token,
      // 账号记录里没写就退回本进程的端口(daemon 自己的门牌号)
      const port = account.port ?? Number(process.env.CC2WECHAT_PORT ?? 18081);
      writeReplyRoute({ userId, contextToken, port, accountId: account.accountId }, home);
    } catch (err) {
      logError(`write reply route failed: ${String(err)}`);
    }

    const incoming: IncomingMessage = {
      id: key,
      userId,
      conversationId,
      text,
      mediaPaths,
      contextToken,
      receivedAt: Date.now(),
    };

    const enqueuedAt = Date.now();
    const result = scheduler.enqueue(conversationId, async (signal) => {
      const queueMs = Date.now() - enqueuedAt;
      const startedAt = Date.now();
      const timeoutMs = turnTimeoutMs();
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              logError(`turn timeout after ${timeoutMs}ms, aborting conv=${conversationId.slice(0, 8)}`);
              scheduler.abort(conversationId);
            }, timeoutMs)
          : null;

      let outcome: TurnTiming['outcome'] = 'error';
      let firstEventMs = -1;
      try {
        const turn = await orchestrator.runTurn(incoming, signal);
        outcome = turn.outcome;
        firstEventMs = turn.firstEventMs;
      } catch (err) {
        logError(`runTurn failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const timing: TurnTiming = {
        conversationId,
        agent: agent.name,
        queueMs,
        firstEventMs,
        totalMs: Date.now() - startedAt,
        outcome,
        endedAt: Date.now(),
      };
      turns.push(timing);
      log(
        `[turn] conv=${conversationId.slice(0, 8)} agent=${agent.name} queue=${timing.queueMs}ms ` +
          `first=${timing.firstEventMs}ms total=${timing.totalMs}ms outcome=${timing.outcome}`,
      );

      if (timedOut) {
        await reply(
          `这轮超过 ${Math.round(timeoutMs / 60_000)} 分钟没跑完，已中止。把任务拆小一点再试。`,
        ).catch(() => {});
      }
    });

    if (result === 'rejected') {
      const depth = scheduler.depth(conversationId);
      await reply(`⏳ 前面还有 ${depth} 条在排队，这条先不处理了，稍后再发`).catch(() => {});
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > this.capacity) {
      // Set 保插入序,删最老的那个
      const oldest = this.seen.values().next().value as string | undefined;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// 空闲会话清理
// ---------------------------------------------------------------------------

/** 每 10 分钟扫一次:过期的绑定连同 agent 侧的池一起放掉 */
export function startIdleSweeper(deps: Pick<DispatcherDeps, 'store' | 'agent'>): () => void {
  const ttl = sessionTtlMs();
  if (ttl <= 0) return () => {};

  const timer = setInterval(() => {
    let expired: string[] = [];
    try {
      expired = deps.store.expireIdle(ttl);
    } catch (err) {
      logError(`expireIdle failed: ${String(err)}`);
      return;
    }
    for (const id of expired) {
      log(`session idle-expired: ${id.slice(0, 8)}`);
      void deps.agent.reset(id).catch(() => {});
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// 长轮询主循环
// ---------------------------------------------------------------------------

export interface PollLoopDeps extends DispatcherDeps {
  /** 优雅停机 / 测试收口 */
  stopSignal?: AbortSignal;
  loadSyncBuf?: (accountId: string) => string;
  saveSyncBuf?: (accountId: string, buf: string) => void;
  retryDelayMs?: number;
}

export async function pollLoop(deps: PollLoopDeps): Promise<void> {
  const { account, stopSignal } = deps;
  const loadBuf = deps.loadSyncBuf ?? defaultLoadSyncBuf;
  const saveBuf = deps.saveSyncBuf ?? defaultSaveSyncBuf;
  const retryDelay = deps.retryDelayMs ?? RETRY_DELAY_MS;

  let buf = loadBuf(account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = DEFAULT_LONG_POLL_MS;

  const dispatcher = new MessageDispatcher(deps);
  log(`Polling started for account ${account.accountId}`);

  while (!stopSignal?.aborted) {
    try {
      const resp = await getUpdates(account.token, buf, account.baseUrl, nextTimeoutMs);

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
          await sleep(retryDelay);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        saveBuf(account.accountId, resp.get_updates_buf);
        buf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        // 不 await:派发交给 scheduler 后台跑,循环立刻回去长轮询。
        // 一旦这里等后端,微信端就看不到机器人的连接,显示"暂时无法连接"。
        void dispatcher.handle(msg).catch((err) => {
          logError(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      consecutiveFailures++;
      const errMsg =
        err instanceof Error
          ? `${err.message}${err.cause ? ` | cause: ${String(err.cause)}` : ''}${err.stack ? `\n${err.stack.split('\n').slice(1, 3).join('\n')}` : ''}`
          : String(err);
      logError(`Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errMsg}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS);
      } else {
        await sleep(retryDelay);
      }
    }
  }
}
