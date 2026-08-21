/**
 * FakeBridgeServer：Waku 平台侧「agent bridge」接口的内存实现（测试用，**不是**被测代码）。
 *
 * 逐条对齐契约 `AGENT_BRIDGE_CONTRACT.md` §2 与 waku-core 真源，而不是猜：
 * - `GET /users/me/events`：SSE 帧 `id: <user_seq>\nevent: <name>\ndata: <单行 JSON>\n\n`
 *   （`routes/v1/users._sse_frame`），首行 `: replay-mode=filtered|delta` 注释，空闲时每秒一行
 *   `: keepalive`，`Last-Event-ID` 非数字按 0 兜底。
 * - `POST /agent-bridges/token`：`{credential}` → `{access_token, token_type, expires_in, expires_at,
 *   bridge_id, persona_user_id, owner_user_id}`；失败一律 401 `agent_bridge_unauthenticated`，
 *   bridge disabled → 403 `agent_bridge_disabled`。
 * - `POST /chat/conversations/{id}/messages`：`UNIQUE(sender, client_msg_id)` 幂等（created=false）；
 *   错误体 `{"detail": {"code": ..., "message": ...}}`，`not_friends` 403、`not_found` 404。
 * - `POST /chat/conversations/{id}/read`：`{conv_seq}`。
 * - `POST /agent-bridges/me/heartbeat` / `GET /agent-bridges/me`。
 * - `POST /cli/auth/refresh`：`{refresh_token}` → 旋转 `{session_token, refresh_token}`（session 模式）。
 *
 * 它是真 `node:http` 服务器：被测的 SSE 客户端必须用真 fetch + ReadableStream 读它，
 * 断流 / 挂起 / 401 这些传输层行为才是真的。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, Json>;
  at: number;
}

export interface FakeChatMessage {
  id: string;
  conversation_id: string;
  conversation_kind: 'dm' | 'group';
  conv_seq: number;
  sender_user_id: string;
  kind: string;
  body: string | null;
  card: Json;
  image: Json;
  payload: Json;
  mentions: Json;
  client_msg_id: string;
  created_at: string;
  recalled_at: string | null;
  source?: 'human' | 'agent_bridge';
}

export interface SseConnection {
  lastEventId: string | null;
  authorization: string | null;
  openedAt: number;
}

export type SendFault =
  | { status: number; code?: string; retryAfterSec?: number; message?: string }
  | { network: true; applyWrite?: boolean };

export interface FakeBridgeServerOptions {
  personaUserId: string;
  ownerUserId: string;
  bridgeId?: string;
  credential?: string;
  now?: () => number;
  /** bridge JWT 寿命（秒）。 */
  tokenTtlSec?: number;
  keepaliveMs?: number;
}

type SseMode = 'normal' | 'hang' | 'hang-headers';

interface IssuedToken {
  token: string;
  sub: string;
  exp: number;
  aud: string;
  revoked: boolean;
}

interface Frame {
  seq: number;
  event: string;
  data: string;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** 形状像 JWT（三段、base64url payload），不签名——客户端只解析不校验。 */
function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

/** 真后端 `json.dumps(..., default=str)` 会把 datetime 变成 `YYYY-MM-DD HH:MM:SS.ffffff+00:00`。 */
export function pythonTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString(); // 2026-08-21T03:06:55.123Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000+00:00`;
}

export class FakeBridgeServer {
  readonly personaUserId: string;
  readonly ownerUserId: string;
  readonly bridgeId: string;
  readonly credential: string;

  readonly requests: RecordedRequest[] = [];
  readonly sseConnections: SseConnection[] = [];
  readonly messages: Array<{ conversationId: string; clientMsgId: string; body: string; senderUserId: string; id: string; convSeq: number }> = [];
  readonly reads: Array<{ conversationId: string; convSeq: number; by: string }> = [];
  readonly heartbeats: Array<Record<string, Json>> = [];

  tokenCalls = 0;
  refreshCalls = 0;
  bridgeStatus: 'active' | 'disabled' = 'active';
  credentialRevoked = false;
  sseMode: SseMode = 'normal';

  private readonly now: () => number;
  private readonly tokenTtlSec: number;
  private readonly keepaliveMs: number;
  private server: http.Server | null = null;
  private port = 0;

  private readonly tokens = new Map<string, IssuedToken>();
  private readonly frames: Frame[] = [];
  private nextSeq = 0;
  private readonly live = new Set<http.ServerResponse>();
  private readonly conversations = new Map<string, { kind: 'dm' | 'group'; members: Set<string>; nextSeq: number; friends: boolean }>();
  private readonly sendFaults: SendFault[] = [];
  private readonly sseFaults: number[] = [];
  private readonly tokenFaults: number[] = [];
  private readonly refreshTokens = new Map<string, { userId: string; used: boolean }>();
  private msgCounter = 0;

  constructor(options: FakeBridgeServerOptions) {
    this.personaUserId = options.personaUserId;
    this.ownerUserId = options.ownerUserId;
    this.bridgeId = options.bridgeId ?? 'abr_fake0001';
    this.credential = options.credential ?? 'abc_fake_credential_plaintext_0123456789abcdef';
    this.now = options.now ?? (() => Date.now());
    this.tokenTtlSec = options.tokenTtlSec ?? 3600;
    this.keepaliveMs = options.keepaliveMs ?? 1000;
  }

  // ── 生命周期 ───────────────────────────────────────────────────

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.dropConnections();
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // http.Server.close 等 keep-alive 连接自然结束；强制收掉。
      server.closeAllConnections?.();
    });
  }

  get apiBase(): string {
    return `http://127.0.0.1:${this.port}/api/v1`;
  }

  // ── 种子 / 观测 ────────────────────────────────────────────────

  seedDm(conversationId: string, peerUserId: string, options: { friends?: boolean } = {}): void {
    this.conversations.set(conversationId, {
      kind: 'dm',
      members: new Set([this.personaUserId, peerUserId]),
      nextSeq: 0,
      friends: options.friends ?? true,
    });
  }

  seedGroup(conversationId: string, memberIds: string[]): void {
    this.conversations.set(conversationId, {
      kind: 'group',
      members: new Set([this.personaUserId, ...memberIds]),
      nextSeq: 0,
      friends: true,
    });
  }

  setFriends(conversationId: string, friends: boolean): void {
    const conv = this.conversations.get(conversationId);
    if (conv) conv.friends = friends;
  }

  /** session 模式：登记一枚可用的 refresh_token（对应某个用户）。 */
  seedRefreshToken(refreshToken: string, userId: string): void {
    this.refreshTokens.set(refreshToken, { userId, used: false });
  }

  /** 直接签发一枚 session token（用来写测试用 auth.json）。 */
  issueSessionToken(userId: string, ttlSec = 3600): string {
    return this.issue(userId, 'vi-anthropic-managed-session', ttlSec);
  }

  issuedTokens(): string[] {
    return [...this.tokens.keys()];
  }

  revokeToken(token: string): void {
    const issued = this.tokens.get(token);
    if (issued) issued.revoked = true;
  }

  revokeAllTokens(): void {
    for (const issued of this.tokens.values()) issued.revoked = true;
  }

  failNextSend(fault: SendFault): void {
    this.sendFaults.push(fault);
  }

  failNextSse(status: number, times = 1): void {
    for (let i = 0; i < times; i += 1) this.sseFaults.push(status);
  }

  failNextTokenExchange(status: number, times = 1): void {
    for (let i = 0; i < times; i += 1) this.tokenFaults.push(status);
  }

  requestsTo(pathPrefix: string, method?: string): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.path.startsWith(pathPrefix) && (method === undefined || r.method === method),
    );
  }

  get liveConnectionCount(): number {
    return this.live.size;
  }

  // ── 推帧 ──────────────────────────────────────────────────────

  /** 追加一帧（任意事件名）并推给所有在线连接；返回 user_seq。 */
  emit(event: string, payload: Record<string, Json>): number {
    this.nextSeq += 1;
    const frame: Frame = { seq: this.nextSeq, event, data: JSON.stringify(payload) };
    this.frames.push(frame);
    this.broadcast(this.render(frame));
    return frame.seq;
  }

  /** 直接推原始字节（构造畸形帧 / 多行 data 等）。 */
  emitRaw(text: string): void {
    this.broadcast(text);
  }

  /** 模拟「有人给马甲发了一条私信」：按 chat_service.message_wire_payload 造 payload 并推帧。 */
  emitChatMessage(input: {
    conversationId: string;
    senderUserId: string;
    body?: string | null;
    kind?: string;
    createdAtMs?: number;
    recalled?: boolean;
    source?: 'human' | 'agent_bridge';
    conversationKind?: 'dm' | 'group';
    id?: string;
    clientMsgId?: string;
    omitConversationKind?: boolean;
  }): { seq: number; message: FakeChatMessage } {
    const conv = this.conversations.get(input.conversationId);
    const convSeq = conv ? ++conv.nextSeq : 1;
    this.msgCounter += 1;
    const createdAt = input.createdAtMs ?? this.now();
    const message: FakeChatMessage = {
      id: input.id ?? `cmsg_${String(this.msgCounter).padStart(6, '0')}`,
      conversation_id: input.conversationId,
      conversation_kind: input.conversationKind ?? conv?.kind ?? 'dm',
      conv_seq: convSeq,
      sender_user_id: input.senderUserId,
      kind: input.kind ?? 'text',
      body: input.body === undefined ? `hello ${this.msgCounter}` : input.body,
      card: null,
      image: null,
      payload: null,
      mentions: null,
      client_msg_id: input.clientMsgId ?? `client_${this.msgCounter}`,
      created_at: pythonTimestamp(createdAt),
      recalled_at: input.recalled ? pythonTimestamp(createdAt + 1000) : null,
    };
    if (input.source !== undefined) message.source = input.source;
    const payload: Record<string, Json> = { ...(message as unknown as Record<string, Json>) };
    if (input.omitConversationKind) delete payload['conversation_kind'];
    const seq = this.emit('chat.message', payload);
    return { seq, message };
  }

  /** 掐断所有在线 SSE 连接（客户端看到 EOF / 连接重置）。 */
  dropConnections(): void {
    for (const response of this.live) {
      try {
        response.destroy();
      } catch {
        /* already gone */
      }
    }
    this.live.clear();
  }

  // ── 内部：HTTP ────────────────────────────────────────────────

  private jtiCounter = 0;

  private issue(sub: string, aud: string, ttlSec: number, extra: Record<string, unknown> = {}): string {
    const exp = Math.floor(this.now() / 1000) + ttlSec;
    // jti 保证同一秒内换出来的两枚 token 字符串不同（真后端也是每次现签的）。
    this.jtiCounter += 1;
    const token = fakeJwt({ iss: 'fake', aud, sub, iat: Math.floor(this.now() / 1000), exp, jti: `jti_${this.jtiCounter}`, ...extra });
    this.tokens.set(token, { token, sub, exp, aud, revoked: false });
    return token;
  }

  private authenticate(headers: Record<string, string>): IssuedToken | null {
    const raw = headers['authorization'] ?? '';
    const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : '';
    const issued = this.tokens.get(token);
    if (!issued || issued.revoked) return null;
    if (issued.exp <= Math.floor(this.now() / 1000)) return null;
    return issued;
  }

  private async readBody(request: http.IncomingMessage): Promise<Record<string, Json>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, Json>)
        : {};
    } catch {
      return {};
    }
  }

  private json(response: http.ServerResponse, status: number, body: Json, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      ...headers,
    });
    response.end(text);
  }

  private detail(response: http.ServerResponse, status: number, code: string, message = code, headers: Record<string, string> = {}): void {
    this.json(response, status, { detail: { code, message } }, headers);
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(',');
    }
    const body = method === 'GET' ? {} : await this.readBody(request);
    this.requests.push({ method, path, headers, body, at: this.now() });

    const prefix = '/api/v1';
    if (!path.startsWith(prefix)) {
      this.json(response, 404, { detail: 'Not Found' });
      return;
    }
    const route = path.slice(prefix.length);

    if (method === 'POST' && route === '/agent-bridges/token') {
      this.handleTokenExchange(body, response);
      return;
    }
    if (method === 'POST' && route === '/cli/auth/refresh') {
      this.handleRefresh(body, response);
      return;
    }

    if (method === 'GET' && route === '/users/me/events') {
      this.handleSse(headers, url, response);
      return;
    }

    const identity = this.authenticate(headers);
    if (identity === null) {
      this.json(response, 401, { detail: 'invalid or expired token' });
      return;
    }

    if (method === 'GET' && route === '/agent-bridges/me') {
      if (identity.aud !== 'vi-agent-bridge') {
        this.detail(response, 403, 'forbidden');
        return;
      }
      this.json(response, 200, {
        bridge: { id: this.bridgeId, status: this.bridgeStatus, friend_policy: 'owner_only', name: 'Codex', persona_user_id: this.personaUserId, owner_user_id: this.ownerUserId },
        persona: { user_id: this.personaUserId, handle: 'ai_codex', display_name: 'Codex' },
        owner: { user_id: this.ownerUserId, display_name: 'aster' },
      });
      return;
    }

    if (method === 'POST' && route === '/agent-bridges/me/heartbeat') {
      if (identity.aud !== 'vi-agent-bridge') {
        this.detail(response, 403, 'forbidden');
        return;
      }
      this.heartbeats.push(body);
      this.json(response, 200, {
        accepted: true,
        server_time: new Date(this.now()).toISOString(),
        bridge: { id: this.bridgeId, status: this.bridgeStatus, friend_policy: 'owner_only', name: 'Codex' },
      });
      return;
    }

    const sendMatch = /^\/chat\/conversations\/([^/]+)\/messages$/.exec(route);
    if (method === 'POST' && sendMatch) {
      await this.handleSend(decodeURIComponent(sendMatch[1]), identity, body, response);
      return;
    }

    const readMatch = /^\/chat\/conversations\/([^/]+)\/read$/.exec(route);
    if (method === 'POST' && readMatch) {
      const conversationId = decodeURIComponent(readMatch[1]);
      const conv = this.conversations.get(conversationId);
      if (!conv || !conv.members.has(identity.sub)) {
        this.detail(response, 403, 'not_member', 'not a conversation member');
        return;
      }
      const convSeq = typeof body['conv_seq'] === 'number' ? body['conv_seq'] : 0;
      this.reads.push({ conversationId, convSeq, by: identity.sub });
      this.json(response, 200, { read_cursor: convSeq });
      return;
    }

    this.json(response, 404, { detail: 'Not Found' });
  }

  private handleTokenExchange(body: Record<string, Json>, response: http.ServerResponse): void {
    this.tokenCalls += 1;
    const fault = this.tokenFaults.shift();
    if (fault !== undefined) {
      this.detail(response, fault, fault === 401 ? 'agent_bridge_unauthenticated' : `http_${fault}`);
      return;
    }
    const credential = body['credential'];
    if (typeof credential !== 'string' || credential !== this.credential || this.credentialRevoked) {
      this.detail(response, 401, 'agent_bridge_unauthenticated');
      return;
    }
    if (this.bridgeStatus === 'disabled') {
      this.detail(response, 403, 'agent_bridge_disabled');
      return;
    }
    const token = this.issue(this.personaUserId, 'vi-agent-bridge', this.tokenTtlSec, { bid: this.bridgeId, scopes: ['bridge'] });
    this.json(response, 200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.tokenTtlSec,
      expires_at: new Date(this.now() + this.tokenTtlSec * 1000).toISOString(),
      bridge_id: this.bridgeId,
      persona_user_id: this.personaUserId,
      owner_user_id: this.ownerUserId,
    });
  }

  private handleRefresh(body: Record<string, Json>, response: http.ServerResponse): void {
    this.refreshCalls += 1;
    const refreshToken = body['refresh_token'];
    const row = typeof refreshToken === 'string' ? this.refreshTokens.get(refreshToken) : undefined;
    if (!row || row.used) {
      this.detail(response, 401, 'invalid_refresh_token');
      return;
    }
    row.used = true;
    const rotated = `rt_${this.refreshTokens.size + 1}_${Math.random().toString(36).slice(2, 10)}`;
    this.refreshTokens.set(rotated, { userId: row.userId, used: false });
    const sessionToken = this.issue(row.userId, 'vi-anthropic-managed-session', this.tokenTtlSec);
    this.json(response, 200, { session_token: sessionToken, refresh_token: rotated });
  }

  private async handleSend(
    conversationId: string,
    identity: IssuedToken,
    body: Record<string, Json>,
    response: http.ServerResponse,
  ): Promise<void> {
    const fault = this.sendFaults.shift();
    if (fault && 'network' in fault) {
      if (fault.applyWrite) this.applySend(conversationId, identity, body);
      // 服务端不回任何字节：客户端看到的是连接被掐
      response.destroy();
      return;
    }
    if (fault && 'status' in fault) {
      const headers: Record<string, string> = {};
      if (fault.retryAfterSec !== undefined) headers['Retry-After'] = String(fault.retryAfterSec);
      this.detail(response, fault.status, fault.code ?? `http_${fault.status}`, fault.message ?? fault.code ?? 'fault', headers);
      return;
    }

    const clientMsgId = body['client_msg_id'];
    if (typeof clientMsgId !== 'string' || clientMsgId.length === 0 || clientMsgId.length > 128) {
      this.json(response, 422, { detail: [{ loc: ['body', 'client_msg_id'], msg: 'length' }] });
      return;
    }
    const text = body['body'];
    if (typeof text === 'string' && text.length > 4000) {
      this.json(response, 422, { detail: [{ loc: ['body', 'body'], msg: 'ensure this value has at most 4000 characters' }] });
      return;
    }
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      this.detail(response, 404, 'not_found', 'conversation not found');
      return;
    }
    if (!conv.members.has(identity.sub)) {
      this.detail(response, 403, 'not_member', 'not a conversation member');
      return;
    }
    if (conv.kind === 'dm' && !conv.friends) {
      this.detail(response, 403, 'not_friends', 'dm requires mutual follow');
      return;
    }
    if ((body['kind'] ?? 'text') !== 'text' || typeof text !== 'string' || text.trim().length === 0) {
      this.detail(response, 400, 'invalid', 'empty body');
      return;
    }
    const result = this.applySend(conversationId, identity, body);
    this.json(response, 200, {
      message: {
        id: result.id,
        conversation_id: conversationId,
        conversation_kind: conv.kind,
        conv_seq: result.convSeq,
        sender_user_id: identity.sub,
        kind: 'text',
        body: text,
        client_msg_id: clientMsgId,
        created_at: new Date(this.now()).toISOString(),
        source: identity.aud === 'vi-agent-bridge' ? 'agent_bridge' : 'human',
      },
      created: result.created,
    });
  }

  private applySend(
    conversationId: string,
    identity: IssuedToken,
    body: Record<string, Json>,
  ): { id: string; convSeq: number; created: boolean } {
    const clientMsgId = String(body['client_msg_id'] ?? '');
    const existing = this.messages.find(
      (m) => m.senderUserId === identity.sub && m.clientMsgId === clientMsgId,
    );
    if (existing) return { id: existing.id, convSeq: existing.convSeq, created: false };
    const conv = this.conversations.get(conversationId);
    const convSeq = conv ? ++conv.nextSeq : 0;
    this.msgCounter += 1;
    const id = `cmsg_out_${String(this.msgCounter).padStart(6, '0')}`;
    this.messages.push({
      conversationId,
      clientMsgId,
      body: String(body['body'] ?? ''),
      senderUserId: identity.sub,
      id,
      convSeq,
    });
    return { id, convSeq, created: true };
  }

  // ── 内部：SSE ─────────────────────────────────────────────────

  private render(frame: Frame): string {
    return `id: ${frame.seq}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`;
  }

  private broadcast(text: string): void {
    for (const response of this.live) {
      try {
        response.write(text);
      } catch {
        this.live.delete(response);
      }
    }
  }

  private handleSse(headers: Record<string, string>, url: URL, response: http.ServerResponse): void {
    const rawLast = headers['last-event-id'] ?? null;
    // 每一次连接尝试都登记（含被 401/5xx 打回的）：测试要数"重连了几次"。
    this.sseConnections.push({
      lastEventId: rawLast,
      authorization: headers['authorization'] ?? null,
      openedAt: this.now(),
    });

    const fault = this.sseFaults.shift();
    if (fault !== undefined) {
      this.json(response, fault, { detail: fault === 401 ? 'invalid or expired token' : `fault ${fault}` });
      return;
    }
    const identity = this.authenticate(headers);
    if (identity === null) {
      this.json(response, 401, { detail: 'invalid or expired token' });
      return;
    }

    let cursor = 0;
    if (rawLast !== null) {
      const parsed = Number.parseInt(rawLast, 10);
      cursor = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    } else {
      const q = url.searchParams.get('cursor');
      if (q !== null) cursor = Math.max(0, Number.parseInt(q, 10) || 0);
    }

    if (this.sseMode === 'hang-headers') {
      // 连响应头都不给：客户端的 fetch 挂在那里
      response.socket?.setTimeout(0);
      this.live.add(response);
      response.on('close', () => this.live.delete(response));
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    this.live.add(response);
    response.on('close', () => this.live.delete(response));

    if (this.sseMode === 'hang') return;

    response.write(cursor === 0 ? ': replay-mode=filtered\n\n' : ': replay-mode=delta\n\n');
    for (const frame of this.frames) {
      if (frame.seq > cursor) response.write(this.render(frame));
    }

    const keepalive = setInterval(() => {
      if (!this.live.has(response)) {
        clearInterval(keepalive);
        return;
      }
      try {
        response.write(': keepalive\n\n');
      } catch {
        clearInterval(keepalive);
      }
    }, this.keepaliveMs);
    response.on('close', () => clearInterval(keepalive));
  }
}

/** 等到条件成立（轮询微小间隔），超时即抛——SSE 测试里没有可注入的时钟，用它代替 sleep 猜时间。 */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out${options.label ? `: ${options.label}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 记录式日志：四件套断言用。 */
export class RecordingLogger {
  readonly lines: Array<{ level: 'info' | 'error'; message: string }> = [];

  info = (message: string): void => {
    this.lines.push({ level: 'info', message });
  };

  error = (message: string): void => {
    this.lines.push({ level: 'error', message });
  };

  find(pattern: RegExp | string): string[] {
    return this.lines
      .map((line) => line.message)
      .filter((message) => (typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message)));
  }

  all(): string {
    return this.lines.map((line) => `${line.level}: ${line.message}`).join('\n');
  }
}
