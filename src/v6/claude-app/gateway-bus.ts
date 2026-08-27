import type http from 'node:http';

import { log, logError } from '../../utils.js';

/**
 * 网关总线 —— daemon 与「网关会话」之间那根线。
 *
 * 网关是 app 里的一个普通 cc 会话,靠 `Monitor({command:"curl -N …/claude-app/events",
 * persistent:true})` 挂在这个 SSE 上。它每收到一个事件只干一件事(一个 send_message
 * 或一个 list_sessions)然后回一个执 —— **非确定性压到最小,回程完全走 daemon 的确定性代码**。
 *
 * 三条设计约束,每条都有来由:
 * 1. **一个事件只投给一个网关连接**。同时挂两个 = 同一条微信消息注入两次 = 用户收两条回复。
 * 2. **job 没 ack 就一直在册**,网关重连时补投。app 的 WarmLifecycle 会在空闲 900s 放倒
 *    引擎,网关连带 Monitor 一起死;人一句"值班"重挂之后,这轮不该白丢。
 * 3. **心跳事件顶空闲计时**。默认 8 分钟一发(< 900s),每发一次网关就多活一个 turn。
 *    ⚠️ 待实测确认:Monitor 事件到底算不算"活动"、能不能重置 WarmLifecycle 计时。
 *    若不算,把间隔压到 <15min 的模型 turn 保活(见 docs/claude-app/GATEWAY.md)。
 *
 * 端点(挂在 v6 health server 的同一个端口上,只听 127.0.0.1):
 *   GET  /claude-app/events     SSE,网关的班岗
 *   POST /claude-app/ack        {jobId, ok, error?}
 *   POST /claude-app/resolve    {jobId, cwd, localId|null}
 *   GET  /claude-app/status     运维快照
 *   POST /claude-app/test-send  测试注入口(不连微信走全链)
 */

export type GatewayEvent =
  | { type: 'hello'; protocol: number; at: number; heartbeatMs: number }
  | { type: 'inject'; jobId: string; localId: string; text: string; at: number }
  | { type: 'resolve'; jobId: string; cwd: string; at: number }
  | { type: 'heartbeat'; seq: number; at: number };

export const GATEWAY_PROTOCOL = 1;

export interface InjectJob {
  jobId: string;
  localId: string;
  text: string;
}

export interface ResolveJob {
  jobId: string;
  cwd: string;
}

export interface DispatchOptions {
  ackTimeoutMs?: number;
  /** 没有网关在线时,愿意等多久让它上线(默认 0 = 立刻失败) */
  connectWaitMs?: number;
  signal?: AbortSignal;
}

export type AckResult = { ok: true; ms: number } | { ok: false; code: string; error: string };
export type ResolveResult = { ok: true; localId: string | null } | { ok: false; code: string; error: string };

export interface TestSendPayload {
  text: string;
  conversationId?: string;
  name?: string;
  timeoutMs?: number;
}

export type TestSendHandler = (payload: TestSendPayload) => Promise<{ ok: boolean; text?: string; error?: string; events?: unknown[] }>;

export interface GatewayBusOptions {
  /** 回执超时,默认 120s(网关那个 turn 本身要跑模型) */
  ackTimeoutMs?: number;
  /** 心跳间隔,默认 8min */
  heartbeatMs?: number;
  now?: () => number;
}

const DEFAULT_ACK_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 8 * 60_000;
const MAX_BODY_BYTES = 256 * 1024;

interface Pending {
  kind: 'inject' | 'resolve';
  event: GatewayEvent;
  sentAt: number;
  delivered: boolean;
  settle: (r: AckResult | ResolveResult) => void;
}

interface Conn {
  id: number;
  res: http.ServerResponse;
}

export interface HttpAttachable {
  attachHttp(server: http.Server, hooks?: { onTestSend?: TestSendHandler }): void;
}

/** 给 main.ts 用的鸭子类型判断:agent 想挂 HTTP 就自己实现 attachHttp */
export function isHttpAttachable(a: unknown): a is HttpAttachable {
  return !!a && typeof (a as HttpAttachable).attachHttp === 'function';
}

export class GatewayBus {
  private conns: Conn[] = [];
  private nextConnId = 1;
  private pending = new Map<string, Pending>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatSeq = 0;
  private closed = false;
  private testSend: TestSendHandler | null = null;

  private totalInjected = 0;
  private totalAcked = 0;
  private totalFailed = 0;
  private lastAckMs = -1;
  private lastEventAt = 0;
  private lastConnectedAt = 0;
  private lastDisconnectedAt = 0;

  private readonly ackTimeoutMs: number;
  readonly heartbeatMs: number;
  private readonly now: () => number;

  constructor(opts: GatewayBusOptions = {}) {
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- 对外 --------------------------------------------------------------

  setTestSend(handler: TestSendHandler | null): void {
    this.testSend = handler;
  }

  gatewayConnected(): boolean {
    return this.conns.length > 0;
  }

  stats(): Record<string, unknown> {
    return {
      connected: this.gatewayConnected(),
      connections: this.conns.length,
      pending: this.pending.size,
      totalInjected: this.totalInjected,
      totalAcked: this.totalAcked,
      totalFailed: this.totalFailed,
      lastAckMs: this.lastAckMs,
      lastEventAt: this.lastEventAt,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      heartbeatMs: this.heartbeatMs,
      heartbeatSeq: this.heartbeatSeq,
      testSend: this.testSend != null,
    };
  }

  async dispatchInject(job: InjectJob, opts: DispatchOptions = {}): Promise<AckResult> {
    return (await this.dispatch('inject', job.jobId, { type: 'inject', jobId: job.jobId, localId: job.localId, text: job.text, at: this.now() }, opts)) as AckResult;
  }

  async dispatchResolve(job: ResolveJob, opts: DispatchOptions = {}): Promise<ResolveResult> {
    return (await this.dispatch('resolve', job.jobId, { type: 'resolve', jobId: job.jobId, cwd: job.cwd, at: this.now() }, opts)) as ResolveResult;
  }

  /** 发一个心跳,返回 seq */
  pulse(): number {
    this.heartbeatSeq += 1;
    this.broadcast({ type: 'heartbeat', seq: this.heartbeatSeq, at: this.now() });
    return this.heartbeatSeq;
  }

  startHeartbeat(intervalMs = this.heartbeatMs): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.pulse(), intervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    for (const [, p] of [...this.pending]) {
      p.settle({ ok: false, code: 'claude-app-bus-closed', error: '总线已关闭(daemon 停机)' });
    }
    this.pending.clear();
    for (const c of this.conns.splice(0)) {
      try {
        c.res.end();
      } catch {
        /* 已经断了 */
      }
    }
  }

  /**
   * 挂到已有的 http server 上:先问 bus,不归它管的原样交回原处理器。
   * 这样 v6 health server 一行不用改。
   */
  attach(server: http.Server): void {
    const prev = server.listeners('request') as Array<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (this.handleRequest(req, res)) return;
      for (const h of prev) h.call(server, req, res);
    });
  }

  /** 处理了返回 true;不归自己管返回 false */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/claude-app/')) return false;

    switch (url) {
      case '/claude-app/events':
        if (req.method !== 'GET') return this.methodNotAllowed(res);
        this.openSse(req, res);
        return true;

      case '/claude-app/ack':
        if (req.method !== 'POST') return this.methodNotAllowed(res);
        this.readJson(req, res, (body) => this.onAck(body, res));
        return true;

      case '/claude-app/resolve':
        if (req.method !== 'POST') return this.methodNotAllowed(res);
        this.readJson(req, res, (body) => this.onResolve(body, res));
        return true;

      case '/claude-app/status':
        if (req.method !== 'GET') return this.methodNotAllowed(res);
        this.json(res, 200, this.stats());
        return true;

      case '/claude-app/test-send':
        if (req.method !== 'POST') return this.methodNotAllowed(res);
        this.readJson(req, res, (body) => this.onTestSend(body, res));
        return true;

      default:
        this.json(res, 404, { ok: false, error: `未知端点 ${url}` });
        return true;
    }
  }

  // ---- SSE ---------------------------------------------------------------

  private openSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 反代把 SSE 攒起来一起发的话,心跳就没有意义了
      'X-Accel-Buffering': 'no',
    });
    const conn: Conn = { id: this.nextConnId++, res };
    this.conns.push(conn);
    this.lastConnectedAt = this.now();
    log(`[claude-app] 网关上线 conn=${conn.id}(在线 ${this.conns.length})`);

    this.writeTo(conn, { type: 'hello', protocol: GATEWAY_PROTOCOL, at: this.now(), heartbeatMs: this.heartbeatMs });

    const drop = (): void => {
      const i = this.conns.indexOf(conn);
      if (i < 0) return;
      this.conns.splice(i, 1);
      this.lastDisconnectedAt = this.now();
      logError(`[claude-app] 网关掉线 conn=${conn.id}(还剩 ${this.conns.length});重挂话术见 docs/claude-app/GATEWAY.md`);
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);

    // 重连补投:没 ack 的活还在,别让这一轮白丢
    for (const [, p] of this.pending) {
      if (p.delivered) continue;
      this.deliver(p);
    }
    // 已经投过但网关刚换了一根线的,也补一次(jobId 是去重键,网关照契约幂等处理)
    for (const [, p] of this.pending) {
      if (!p.delivered) continue;
      this.writeTo(conn, p.event);
    }
  }

  private broadcast(event: GatewayEvent): void {
    this.lastEventAt = this.now();
    for (const c of [...this.conns]) this.writeTo(c, event);
  }

  private writeTo(conn: Conn, event: GatewayEvent): void {
    try {
      conn.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logError(`[claude-app] 写 SSE 失败 conn=${conn.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 派发 --------------------------------------------------------------

  private async dispatch(
    kind: 'inject' | 'resolve',
    jobId: string,
    event: GatewayEvent,
    opts: DispatchOptions,
  ): Promise<AckResult | ResolveResult> {
    if (this.closed) return { ok: false, code: 'claude-app-bus-closed', error: '总线已关闭' };
    if (opts.signal?.aborted) return { ok: false, code: 'claude-app-aborted', error: '这轮被取消了' };

    const connectWaitMs = opts.connectWaitMs ?? 0;
    if (!this.gatewayConnected() && connectWaitMs > 0) {
      await this.waitForGateway(connectWaitMs, opts.signal);
    }
    if (!this.gatewayConnected()) {
      this.totalFailed += 1;
      return {
        ok: false,
        code: 'claude-app-gateway-offline',
        error: '网关会话不在线(SSE 没有连接)——需要有人在 app 里重挂值班,见 docs/claude-app/GATEWAY.md',
      };
    }

    const timeoutMs = opts.ackTimeoutMs ?? this.ackTimeoutMs;

    return new Promise<AckResult | ResolveResult>((resolve) => {
      let done = false;
      const finish = (r: AckResult | ResolveResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(jobId);
        resolve(r);
      };

      const timer = setTimeout(() => {
        this.totalFailed += 1;
        finish({
          ok: false,
          code: 'claude-app-ack-timeout',
          error: `网关 ${timeoutMs}ms 没有回执(${kind} ${jobId})`,
        });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const onAbort = (): void => finish({ ok: false, code: 'claude-app-aborted', error: '这轮被取消了' });
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const p: Pending = { kind, event, sentAt: this.now(), delivered: false, settle: finish };
      this.pending.set(jobId, p);
      if (kind === 'inject') this.totalInjected += 1;
      this.deliver(p);
    });
  }

  /** 只投给一个连接:多网关同时挂着时,投最新那根线 */
  private deliver(p: Pending): void {
    const conn = this.conns[this.conns.length - 1];
    if (!conn) return;
    p.delivered = true;
    this.lastEventAt = this.now();
    this.writeTo(conn, p.event);
  }

  private waitForGateway(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const deadline = this.now() + ms;
      const timer = setInterval(() => {
        if (this.gatewayConnected() || this.now() >= deadline || signal?.aborted) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  // ---- 回执 --------------------------------------------------------------

  private onAck(body: Record<string, unknown>, res: http.ServerResponse): void {
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    if (!jobId) {
      this.json(res, 400, { ok: false, error: '缺 jobId' });
      return;
    }
    const p = this.pending.get(jobId);
    if (!p) {
      // 网关重挂后可能补发旧回执 —— 不是致命错误,如实回一句就行
      this.json(res, 200, { ok: false, error: `没有在等 jobId=${jobId} 的回执(可能已超时)` });
      return;
    }
    const ms = this.now() - p.sentAt;
    if (body.ok === true) {
      this.totalAcked += 1;
      this.lastAckMs = ms;
      p.settle({ ok: true, ms });
    } else {
      this.totalFailed += 1;
      p.settle({
        ok: false,
        code: 'claude-app-inject-failed',
        error: typeof body.error === 'string' && body.error ? body.error : '网关回执:失败(没给原因)',
      });
    }
    this.json(res, 200, { ok: true });
  }

  private onResolve(body: Record<string, unknown>, res: http.ServerResponse): void {
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    if (!jobId) {
      this.json(res, 400, { ok: false, error: '缺 jobId' });
      return;
    }
    const p = this.pending.get(jobId);
    if (!p) {
      this.json(res, 200, { ok: false, error: `没有在等 jobId=${jobId} 的回报` });
      return;
    }
    const localId = typeof body.localId === 'string' && body.localId ? body.localId : null;
    this.lastAckMs = this.now() - p.sentAt;
    p.settle({ ok: true, localId });
    this.json(res, 200, { ok: true });
  }

  private onTestSend(body: Record<string, unknown>, res: http.ServerResponse): void {
    if (!this.testSend) {
      this.json(res, 503, { ok: false, error: 'test-send 没有接上处理器(需要 claude-app 后端在跑,或被 CC2WECHAT_CLAUDE_APP_TEST_SEND=0 关掉了)' });
      return;
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) {
      this.json(res, 400, { ok: false, error: '缺 text' });
      return;
    }
    const payload: TestSendPayload = {
      text,
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    };
    void this.testSend(payload)
      .then((r) => this.json(res, 200, r))
      .catch((err) => this.json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) }));
  }

  // ---- HTTP 小工具 -------------------------------------------------------

  private methodNotAllowed(res: http.ServerResponse): boolean {
    this.json(res, 405, { ok: false, error: 'method not allowed' });
    return true;
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    try {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    } catch {
      /* 连接没了 */
    }
  }

  private readJson(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    then: (body: Record<string, unknown>) => void,
  ): void {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        this.json(res, 413, { ok: false, error: 'body 太大' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        this.json(res, 400, { ok: false, error: 'body 不是合法 JSON' });
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        this.json(res, 400, { ok: false, error: 'body 必须是 JSON 对象' });
        return;
      }
      then(parsed as Record<string, unknown>);
    });
    req.on('error', () => this.json(res, 400, { ok: false, error: '读 body 失败' }));
  }
}
