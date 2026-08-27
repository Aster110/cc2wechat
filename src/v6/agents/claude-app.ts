import type http from 'node:http';
import { randomUUID } from 'node:crypto';

import { log, logError } from '../../utils.js';
import type { AgentAdapter, AgentEvent, AgentHealth, AgentRequest } from '../contracts.js';
import { CcRegistry } from '../claude-app/cc-registry.js';
import { GatewayBus, type AckResult, type InjectJob, type ResolveJob, type ResolveResult, type TestSendHandler } from '../claude-app/gateway-bus.js';
import { InboxRegistry } from '../claude-app/inbox-registry.js';
import { TranscriptWatcher, jobMarker, type TranscriptBaseline, type WatchOptions, type WatchResult } from '../claude-app/transcript-watcher.js';
import { CodexAppServerAgent } from './codex-app-server.js';

/**
 * claude-app 后端 —— 微信消息驱动 **Claude desktop app 会话**。
 *
 * 一轮的样子(架构 11 §2):
 *   Core → run() → 记 transcript 基线 → GatewayBus 发 inject 事件
 *        → 网关会话一个 turn 一个 send_message → 收件箱会话被秒级唤醒并回复
 *        → TranscriptWatcher 零 token 读回 → final
 *
 * 三条不变量:
 * - **网关 LLM 每消息只干一件事**,回程完全是 daemon 的确定性代码。
 * - **每收件箱独占 cwd**:既是路由键,也是权限沙箱边界,也是 transcript slug 隔离。
 * - **收件箱只能人工播种**(预研 §3:零确认创建五路全封死),daemon 只认领不创建。
 *
 * 降级:通道级故障(网关不在线 / 一个收件箱都没有)走 codex,日志明示;
 * 单轮故障(注入被拒 / 回程超时)如实报错,不偷偷换后端答话 ——
 * 用户以为在跟 A 说话,结果 B 答了,比报错更糟。
 */

// ---------------------------------------------------------------------------
// 依赖接口(全部可注入,测试不碰真实世界)
// ---------------------------------------------------------------------------

export interface BusLike {
  gatewayConnected(): boolean;
  dispatchInject(job: InjectJob, opts?: { ackTimeoutMs?: number; connectWaitMs?: number; signal?: AbortSignal }): Promise<AckResult>;
  dispatchResolve(job: ResolveJob, opts?: { ackTimeoutMs?: number; connectWaitMs?: number; signal?: AbortSignal }): Promise<ResolveResult>;
  stats(): Record<string, unknown>;
  startHeartbeat(intervalMs?: number): void;
  stopHeartbeat(): void;
  close(): void;
  attach(server: http.Server): void;
  setTestSend(handler: TestSendHandler | null): void;
}

export interface WatcherLike {
  baseline(cwd: string): TranscriptBaseline;
  watch(opts: WatchOptions): Promise<WatchResult>;
}

export interface ClaudeAppAgentOptions {
  env?: NodeJS.ProcessEnv;
  accountId?: string;
  /** 台账目录,缺省 ~/.cc2wechat */
  dataDir?: string;
  bus?: BusLike;
  watcher?: WatcherLike;
  inboxes?: InboxRegistry;
  registry?: CcRegistry;
  /** 通道级故障时的降级后端;显式给 null = 不降级(如实报错) */
  fallback?: AgentAdapter | null;
  now?: () => number;
  newJobId?: () => string;
  /** 网关不在线时愿意等多久让它重挂 */
  gatewayWaitMs?: number;
  turnTimeoutMs?: number;
  /** 回程轮询的旋钮(轮询间隔 / settle 窗口 / 静默兜底 / 等引擎)。缺省用 watcher 自己的默认值。 */
  watchTuning?: Partial<Pick<WatchOptions, 'pollMs' | 'settleMs' | 'silenceMs' | 'engineWaitMs'>>;
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export interface EnvelopeInput {
  name: string;
  jobId: string;
  at: number;
  text: string;
  mediaPaths?: string[];
  reset?: boolean;
}

/**
 * 注入信封:`[微信|<name>|job:<jobId>|<ts>] <原文>`
 *
 * jobId 一身三用:transcript 锚点、网关回执的去重键、日志里串起一轮的线索。
 * ts 用 ISO 是为了跨时区/跨天不含糊(收件箱里的人也看得懂)。
 */
export function buildEnvelope(input: EnvelopeInput): string {
  // Core 已经加过 "[微信] " 前缀,这里不叠第二层
  const body = input.text.replace(/^\[微信\]\s*/, '');
  const head = `[微信|${input.name}|${jobMarker(input.jobId)}|${new Date(input.at).toISOString()}] ${body}`;
  const lines = [head];
  if (input.reset) {
    lines.push('【新话题】上面的历史不用管了，从这条开始重新聊。');
  }
  for (const p of input.mediaPaths ?? []) {
    lines.push(`[附件] ${p}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export class ClaudeAppAgent implements AgentAdapter {
  readonly name = 'claude-app';
  readonly persistent = true;

  private readonly env: NodeJS.ProcessEnv;
  private readonly bus: BusLike;
  private readonly watcher: WatcherLike;
  private readonly inboxes: InboxRegistry;
  private readonly now: () => number;
  private readonly newJobId: () => string;
  private readonly gatewayWaitMs: number;
  private readonly turnTimeoutMs: number;
  private readonly watchTuning: Partial<Pick<WatchOptions, 'pollMs' | 'settleMs' | 'silenceMs' | 'engineWaitMs'>>;
  private readonly fallbackEnabled: boolean;
  private fallbackAgent: AgentAdapter | null;

  constructor(opts: ClaudeAppAgentOptions = {}) {
    this.env = opts.env ?? process.env;
    const registry = opts.registry ?? new CcRegistry();
    this.bus = opts.bus ?? new GatewayBus({});
    this.watcher = opts.watcher ?? new TranscriptWatcher({ registry });
    this.inboxes =
      opts.inboxes ?? new InboxRegistry({ accountId: opts.accountId ?? 'default', dir: opts.dataDir });
    this.now = opts.now ?? (() => Date.now());
    this.newJobId = opts.newJobId ?? (() => randomUUID().replace(/-/g, '').slice(0, 12));
    this.gatewayWaitMs = opts.gatewayWaitMs ?? Number(this.env.CC2WECHAT_CLAUDE_APP_GATEWAY_WAIT_MS ?? 5_000);
    this.turnTimeoutMs = opts.turnTimeoutMs ?? Number(this.env.CC2WECHAT_CLAUDE_APP_TURN_TIMEOUT_MS ?? 180_000);
    this.watchTuning = opts.watchTuning ?? {};

    // fallback 显式传 null = 不要降级;不传 = 懒造一个 codex
    this.fallbackEnabled =
      opts.fallback !== null && (this.env.CC2WECHAT_CLAUDE_APP_FALLBACK ?? '').toLowerCase() !== 'off';
    this.fallbackAgent = opts.fallback ?? null;
  }

  // ---- 对外契约 ----------------------------------------------------------

  async *run(req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (signal.aborted) return;

    const inbox = this.inboxes.claim(req.conversationId);
    if (!inbox) {
      const message =
        '没有可用的收件箱会话。先跑一次 `cc2wechat claude-app seed --name <名字>` 播种' +
        '(深链开目录 + 人敲一条首条消息),详见 docs/claude-app/SEEDING.md';
      if (this.canFallback()) {
        logError(`[claude-app] ${message} —— 本轮降级到 ${this.fallback().name}`);
        yield* this.fallback().run(req, signal);
        return;
      }
      yield { type: 'error', code: 'claude-app-no-inbox', message, retryable: false };
      return;
    }

    // localId:台账 → SessionStore 的旧绑定 → 问网关
    let localId = inbox.localId;
    let localIdIsNew = false;
    if (!localId && req.binding?.agentType === this.name && req.binding.providerSessionId) {
      localId = req.binding.providerSessionId;
      this.inboxes.bindLocalId(inbox.name, localId);
      log(`[claude-app] ${inbox.name} 的 localId 从 SessionStore 捡回:${localId}`);
    }
    if (!localId) {
      const jobId = this.newJobId();
      const r = await this.bus.dispatchResolve(
        { jobId, cwd: inbox.cwd },
        { connectWaitMs: this.gatewayWaitMs, signal },
      );
      if (signal.aborted) return;
      if (!r.ok) {
        if (r.code === 'claude-app-gateway-offline' && this.canFallback()) {
          logError(`[claude-app] 网关不在线,本轮降级到 ${this.fallback().name}:${r.error}`);
          yield* this.fallback().run(req, signal);
          return;
        }
        yield { type: 'error', code: r.code, message: r.error, retryable: true };
        return;
      }
      if (!r.localId) {
        yield {
          type: 'error',
          code: 'claude-app-unresolved-inbox',
          message: `网关在 ${inbox.cwd} 找不到会话 —— 这个收件箱可能还没播种完(深链开了但没人敲首条消息)`,
          retryable: false,
        };
        return;
      }
      localId = r.localId;
      localIdIsNew = true;
      this.inboxes.bindLocalId(inbox.name, localId);
    }

    yield { type: 'started', providerSessionId: localId };
    if (localIdIsNew || req.binding?.providerSessionId !== localId) {
      // 让 SessionStore 记住这个句柄:台账万一丢了还能从这儿捡回来
      yield { type: 'sessionChanged', providerSessionId: localId };
    }

    const jobId = this.newJobId();
    const reset = this.inboxes.takeReset(inbox.name);
    const text = buildEnvelope({
      name: inbox.name,
      jobId,
      at: this.now(),
      text: req.text,
      mediaPaths: req.mediaPaths,
      reset,
    });

    // 基线必须在注入**之前**记:秒回的一轮会在我们还没开始看的时候就写完
    const baseline = this.watcher.baseline(inbox.cwd);

    const ack = await this.bus.dispatchInject({ jobId, localId, text }, { connectWaitMs: this.gatewayWaitMs, signal });
    if (signal.aborted) return;
    if (!ack.ok) {
      if (ack.code === 'claude-app-gateway-offline' && this.canFallback()) {
        logError(`[claude-app] 网关不在线,本轮降级到 ${this.fallback().name}:${ack.error}`);
        yield* this.fallback().run(req, signal);
        return;
      }
      if (ack.code === 'claude-app-aborted') return;
      if (ack.code === 'claude-app-inject-failed') {
        // 会话句柄可能已经作废,清掉让下一轮重解析
        this.inboxes.clearLocalId(inbox.name);
      }
      yield { type: 'error', code: ack.code, message: ack.error, retryable: true };
      return;
    }

    const progress: string[] = [];
    const result = await this.watcher.watch({
      ...this.watchTuning,
      cwd: inbox.cwd,
      marker: jobMarker(jobId),
      baseline,
      signal,
      timeoutMs: this.turnTimeoutMs,
      onProgress: (t) => progress.push(t),
    });
    for (const p of progress) yield { type: 'progress', text: p };

    if (result.ok) {
      if (result.doneBy === 'silence') {
        // 兜底路径要留痕:主判据(end_turn)哪天失效,这行日志就是第一现场
        yield { type: 'progress', text: '完成判据走了兜底(doneBy=silence),app 可能改了 transcript 格式' };
      }
      yield { type: 'final', text: result.text };
      return;
    }

    // 被 /stop 打断的一轮不回话 —— 回执由命令层发
    if (result.code === 'claude-app-aborted') return;
    yield { type: 'error', code: result.code, message: result.error, retryable: true };
  }

  /** /new:收件箱永续,只挂一个"下一条带新话题标记"的旗子 */
  async reset(conversationId: string): Promise<void> {
    this.inboxes.bumpGeneration(conversationId);
    if (this.fallbackAgent) await this.fallbackAgent.reset(conversationId);
  }

  async health(): Promise<AgentHealth> {
    const inboxes = this.inboxes.list();
    if (inboxes.length === 0) {
      return { ok: false, detail: '一个收件箱都没播种:cc2wechat claude-app seed --name <名字>' };
    }
    const bound = inboxes.filter((i) => i.conversationId != null).length;
    if (!this.bus.gatewayConnected()) {
      return {
        ok: false,
        detail: `网关会话不在线(SSE 无连接);去 app 里重挂值班,话术见 docs/claude-app/GATEWAY.md。收件箱 ${bound}/${inboxes.length} 已绑定`,
      };
    }
    const lastAckMs = this.bus.stats().lastAckMs;
    return {
      ok: true,
      detail: `网关在线,收件箱 ${bound}/${inboxes.length} 已绑定,上次注入回执 ${String(lastAckMs)}ms`,
    };
  }

  async shutdown(): Promise<void> {
    this.bus.close();
    if (this.fallbackAgent) await this.fallbackAgent.shutdown();
  }

  // ---- HTTP 接线 ---------------------------------------------------------

  /**
   * 挂到 v6 health server 上(main.ts 调)。顺手开心跳,并接上 test-send。
   *
   * test-send 是**不连微信**驱动整条 claude-app 链的入口:
   * 真 SSE → 真 send_message → 真收件箱 → 真 watcher。真 E2E 靠它。
   * 端口只听 127.0.0.1;不想要就 CC2WECHAT_CLAUDE_APP_TEST_SEND=0。
   */
  attachHttp(server: http.Server, hooks: { onTestSend?: TestSendHandler } = {}): void {
    this.bus.attach(server);
    this.bus.startHeartbeat();

    const disabled = (this.env.CC2WECHAT_CLAUDE_APP_TEST_SEND ?? '').trim() === '0';
    if (disabled) {
      this.bus.setTestSend(null);
      return;
    }
    this.bus.setTestSend(hooks.onTestSend ?? ((payload) => this.runTestSend(payload)));
    log('[claude-app] test-send 已开(POST 127.0.0.1:<port>/claude-app/test-send);关掉:CC2WECHAT_CLAUDE_APP_TEST_SEND=0');
  }

  private async runTestSend(payload: { text: string; conversationId?: string; name?: string }): Promise<{
    ok: boolean;
    text?: string;
    error?: string;
    events: AgentEvent[];
  }> {
    const conversationId = payload.conversationId ?? 'claude-app-test-send';
    const events: AgentEvent[] = [];
    const ac = new AbortController();
    for await (const e of this.run(
      { conversationId, text: payload.text, mediaPaths: [], cwd: process.cwd(), binding: null },
      ac.signal,
    )) {
      events.push(e);
    }
    const final = [...events].reverse().find((e) => e.type === 'final');
    if (final && final.type === 'final') return { ok: true, text: final.text, events };
    const err = [...events].reverse().find((e) => e.type === 'error');
    return {
      ok: false,
      error: err && err.type === 'error' ? `${err.code}: ${err.message}` : '这轮没有任何输出',
      events,
    };
  }

  // ---- 内部 -------------------------------------------------------------

  private canFallback(): boolean {
    return this.fallbackEnabled;
  }

  private fallback(): AgentAdapter {
    if (!this.fallbackAgent) this.fallbackAgent = new CodexAppServerAgent({ env: this.env });
    return this.fallbackAgent;
  }
}
