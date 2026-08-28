import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { log, logError } from '../../utils.js';
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelReply,
  ChannelStartContext,
} from './contracts.js';

/**
 * Web 薄通道 —— 契约的反向验证渠道。
 *
 * 它存在的理由不是"我们需要网页版",而是:**只有第二个真实渠道能证明
 * Channel 契约不是照着微信描出来的**。接入成本 = 这一个文件,core/ 零改动。
 *
 * 挂在 v6 health server 那个 http.Server 上(先例:claude-app 的 attachHttp),
 * 那台 server **只听 127.0.0.1** —— 要远程用就自己开 SSH 隧道,别往公网上放。
 *
 * 端点:
 *   POST /web/msg     {text, endpointId?} → 产出一条 ChannelMessage
 *   GET  /web/events  SSE,该通道的回复流(event: reply)
 *
 * 安全默认关:没配 token 两个端点一律 403 —— 这是个能替你跟 agent 说话的口子,
 * 默认开着等于把 shell 挂在环回上等人来串门。
 */

const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;

export const WEB_CHANNEL_NAME = 'web';

/** token 来源:env CC2WECHAT_WEB_TOKEN > ~/.cc2wechat/web-token。都没有 = 通道关闭 */
export function readWebToken(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  const fromEnv = (env.CC2WECHAT_WEB_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = fs.readFileSync(path.join(home, '.cc2wechat', 'web-token'), 'utf-8').trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

export interface WebChannelOptions {
  /** 显式给 token(含 null = 明确关闭);不给这个键就按 env / 文件查 */
  token?: string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
}

interface Conn {
  id: number;
  res: http.ServerResponse;
}

export class WebChannel implements ChannelAdapter {
  readonly name = WEB_CHANNEL_NAME;
  readonly descriptor = { sourceLabel: '[web]' };

  private readonly token: string | null;
  private readonly heartbeatMs: number;
  private conns: Conn[] = [];
  private nextConnId = 1;
  private nextMsgId = 1;
  private ctx: ChannelStartContext | null = null;
  private attached = false;
  private stopped = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastOkAt = 0;

  constructor(opts: WebChannelOptions = {}) {
    this.token = opts.token !== undefined ? opts.token : readWebToken(opts.env ?? process.env, opts.home);
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  // ---- ChannelAdapter ----------------------------------------------------

  async start(ctx: ChannelStartContext): Promise<void> {
    this.ctx = ctx;
    if (!this.token) {
      log(
        '[web] 没有配 token,/web/msg 与 /web/events 一律 403。' +
          '要开的话:设 CC2WECHAT_WEB_TOKEN,或把 token 写进 ~/.cc2wechat/web-token',
      );
      return;
    }
    log(`[web] 通道就绪:POST /web/msg · GET /web/events(需 Bearer token${this.attached ? '' : ',等待 attach'})`);
  }

  async send(_endpointId: string, reply: ChannelReply): Promise<void> {
    // 浏览器没开着不算故障:没人听就是没人听,这里不该抛
    this.broadcast('reply', { endpointId: _endpointId, text: reply.text, mediaFiles: reply.mediaFiles });
  }

  health(): ChannelHealth {
    if (this.stopped) return { ok: false, detail: '已停止' };
    if (!this.token) return { ok: false, detail: '未配置 token(CC2WECHAT_WEB_TOKEN 或 ~/.cc2wechat/web-token),端点全关' };
    if (!this.attached) return { ok: false, detail: '未挂到 http server 上' };
    return { ok: true, detail: `${this.conns.length} 个 SSE 连接`, lastOkAt: this.lastOkAt || undefined };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const c of this.conns.splice(0)) {
      try {
        c.res.end();
      } catch {
        /* 已经断了 */
      }
    }
  }

  // ---- HTTP --------------------------------------------------------------

  /**
   * 挂到已有的 http server 上:先问自己,不归自己管的原样交回原处理器。
   * 这样 v6 health server 一行不用改(与 GatewayBus.attach 同款)。
   */
  attach(server: http.Server): void {
    const prev = server.listeners('request') as Array<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (this.handleRequest(req, res)) return;
      for (const h of prev) h.call(server, req, res);
    });
    this.attached = true;
  }

  /** 处理了返回 true;不归自己管返回 false */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/web/')) return false;

    if (this.stopped) {
      this.json(res, 503, { ok: false, error: 'web 通道已停止' });
      return true;
    }
    if (!this.token) {
      this.json(res, 403, {
        ok: false,
        error: 'web 通道未启用:没有配置 token(CC2WECHAT_WEB_TOKEN 或 ~/.cc2wechat/web-token)',
      });
      return true;
    }
    if (!this.authorized(req)) {
      this.json(res, 401, { ok: false, error: '需要 Authorization: Bearer <token>' });
      return true;
    }

    switch (url) {
      case '/web/msg':
        if (req.method !== 'POST') {
          this.json(res, 405, { ok: false, error: 'method not allowed(用 POST)' });
          return true;
        }
        this.readJson(req, res, (body) => this.onMessage(body, res));
        return true;

      case '/web/events':
        if (req.method !== 'GET') {
          this.json(res, 405, { ok: false, error: 'method not allowed(用 GET)' });
          return true;
        }
        this.openSse(req, res);
        return true;

      default:
        this.json(res, 404, { ok: false, error: `未知端点 ${url}` });
        return true;
    }
  }

  // ---- 内部 --------------------------------------------------------------

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return false;
    return safeEqual(m[1]!.trim(), this.token ?? '');
  }

  private onMessage(body: Record<string, unknown>, res: http.ServerResponse): void {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) {
      this.json(res, 400, { ok: false, error: '缺 text' });
      return;
    }
    const endpointId = typeof body.endpointId === 'string' && body.endpointId ? body.endpointId : 'default';
    const threadKey = typeof body.threadKey === 'string' && body.threadKey ? body.threadKey : undefined;
    const id = `web-${this.nextMsgId++}-${Date.now()}`;

    this.lastOkAt = Date.now();
    this.ctx?.deliver({
      id,
      channel: this.name,
      endpointId,
      threadKey,
      text,
      mediaPaths: [],
      receivedAt: Date.now(),
    });
    this.json(res, 200, { ok: true, id });
  }

  private openSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 反代把 SSE 攒起来一起发的话,这条流就废了
      'X-Accel-Buffering': 'no',
    });
    const conn: Conn = { id: this.nextConnId++, res };
    this.conns.push(conn);
    this.lastOkAt = Date.now();
    log(`[web] SSE 上线 conn=${conn.id}(在线 ${this.conns.length})`);
    // 先探一口气,让客户端立刻知道连上了
    this.writeTo(conn, ': ping\n\n');
    this.ensureHeartbeat();

    const drop = (): void => {
      const i = this.conns.indexOf(conn);
      if (i < 0) return;
      this.conns.splice(i, 1);
      log(`[web] SSE 掉线 conn=${conn.id}(还剩 ${this.conns.length})`);
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    // 注释行心跳:中间件/浏览器都不会把长时间静默的连接留着
    this.heartbeatTimer = setInterval(() => {
      for (const c of [...this.conns]) this.writeTo(c, ': ping\n\n');
    }, this.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of [...this.conns]) this.writeTo(c, frame);
  }

  private writeTo(conn: Conn, chunk: string): void {
    try {
      conn.res.write(chunk);
    } catch (err) {
      logError(`[web] 写 SSE 失败 conn=${conn.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

/** 定长比较:长度不同时也走一遍,别用 !== 提前返回给出计时信号 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ba.length !== bb.length) {
    // 长度本身就泄露了一点信息,但至少别在内容上再泄露:拿自己跟自己比一遍再返回 false
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
