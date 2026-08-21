/**
 * Waku 聊天域 / agent-bridge 的 REST 薄客户端。这是 waku-dm 通道**唯一**接触平台 DTO 的地方：
 * adapter 只看得到归一后的结果与分类过的 `WakuApiError`，看不到 `detail.code` 的拼法、Retry-After header。
 *
 * 真源（waku-core）：
 * - `POST /chat/conversations/{id}/messages` `{client_msg_id(≤128), kind:'text', body(≤4000)}`
 *   → `{message: {...}, created: bool}`；`UNIQUE(sender, client_msg_id)` ⇒ 重投幂等。
 * - `POST /chat/conversations/{id}/read` `{conv_seq}` → `{read_cursor}`。
 * - `POST /agent-bridges/me/heartbeat` `{agent_state, queued, running, capabilities}` → `{accepted, server_time, bridge:{id,status,…}}`。
 * - `GET /agent-bridges/me` → `{bridge, persona, owner}`。
 * - 错误体 `{"detail": {"code": ..., "message": ...}}`（也可能是字符串 detail：401 `invalid or expired token`）。
 *
 * 401 只刷新一次：`tokens.invalidate()` 后同请求重放，仍 401 就是真的没权限，交给上层退避。
 * 写请求的网络失败是 `network`（可能已落库），上层映射成 `unknown` 回执而不是盲重发换 id。
 */
import type { BridgeTokenProvider } from './credential-provider.js';

export type WakuApiErrorKind = 'network' | 'http' | 'auth';

export class WakuApiError extends Error {
  readonly kind: WakuApiErrorKind;
  readonly status: number | null;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(input: { kind: WakuApiErrorKind; status?: number | null; code: string; message: string; retryAfterMs?: number | null }) {
    super(input.message);
    this.name = 'WakuApiError';
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

export function isWakuApiError(error: unknown): error is WakuApiError {
  return error instanceof WakuApiError;
}

export interface SendMessageInput {
  clientMsgId: string;
  body: string;
}

export interface HeartbeatInput {
  agentState: 'online' | 'busy' | 'degraded' | 'offline';
  queued: number;
  running: number;
  capabilities: Record<string, string>;
}

export interface WakuChatClient {
  sendMessage(conversationId: string, input: SendMessageInput): Promise<{ messageId: string; created: boolean }>;
  markRead(conversationId: string, convSeq: number): Promise<void>;
  heartbeat(input: HeartbeatInput): Promise<{ accepted: boolean; bridgeStatus: string | null }>;
  me(): Promise<{ bridgeId: string | null; personaUserId: string | null; ownerUserId: string | null }>;
}

export interface WakuChatClientOptions {
  apiBase: string;
  tokens: Pick<BridgeTokenProvider, 'current' | 'invalidate'>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const WAKU_CHAT_REQUEST_TIMEOUT_MS = 15_000;
export const WAKU_CHAT_BODY_MAX_CHARS = 4000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function retryAfterMsOf(headers: Headers, body: Record<string, unknown> | null): number | null {
  const header = headers.get('Retry-After');
  if (header !== null && /^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  const detail = asRecord(body?.['detail']);
  const fromBody = detail?.['retry_after_sec'];
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return fromBody * 1000;
  return null;
}

function codeOf(status: number, body: Record<string, unknown> | null): string {
  const detail = body?.['detail'];
  const detailRecord = asRecord(detail);
  const code = detailRecord?.['code'];
  if (typeof code === 'string' && code.length > 0) return code;
  if (status === 401) return 'unauthenticated';
  if (status === 422) return 'validation_failed';
  return `http_${status}`;
}

export function createWakuChatClient(options: WakuChatClientOptions): WakuChatClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? WAKU_CHAT_REQUEST_TIMEOUT_MS;

  async function call(
    method: 'GET' | 'POST',
    route: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let retriedAuth = false;
    for (;;) {
      let token: string;
      try {
        token = await options.tokens.current();
      } catch (error) {
        const code = typeof (error as { code?: unknown } | undefined)?.code === 'string' ? (error as { code: string }).code : 'credential_unavailable';
        throw new WakuApiError({ kind: 'auth', status: null, code, message: 'credentials are unavailable' });
      }

      let response: Response;
      try {
        response = await fetchImpl(`${apiBase}${route}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new WakuApiError({
          kind: 'network',
          status: null,
          code: 'network',
          message: `${method} ${route} failed before a response arrived (${error instanceof Error ? error.name : 'error'})`,
        });
      }

      let text = '';
      try {
        text = await response.text();
      } catch {
        throw new WakuApiError({ kind: 'network', status: response.status, code: 'network', message: `${method} ${route} returned an unreadable body` });
      }
      let parsed: unknown = null;
      try {
        parsed = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        parsed = null;
      }
      const record = asRecord(parsed);

      if (response.ok) {
        if (record === null) {
          throw new WakuApiError({ kind: 'http', status: response.status, code: 'bad_response', message: `${method} ${route} returned a non-JSON body` });
        }
        return record;
      }

      if (response.status === 401 && !retriedAuth) {
        retriedAuth = true;
        options.tokens.invalidate();
        continue;
      }

      throw new WakuApiError({
        kind: response.status === 401 ? 'auth' : 'http',
        status: response.status,
        code: codeOf(response.status, record),
        message: `${method} ${route} failed with HTTP ${response.status} (${codeOf(response.status, record)})`,
        retryAfterMs: retryAfterMsOf(response.headers, record),
      });
    }
  }

  return {
    async sendMessage(conversationId, input) {
      const payload = await call('POST', `/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
        client_msg_id: input.clientMsgId,
        kind: 'text',
        body: input.body,
      });
      const message = asRecord(payload['message']);
      const messageId = typeof message?.['id'] === 'string' ? message['id'] : '';
      return { messageId, created: payload['created'] === true };
    },

    async markRead(conversationId, convSeq) {
      await call('POST', `/chat/conversations/${encodeURIComponent(conversationId)}/read`, { conv_seq: convSeq });
    },

    async heartbeat(input) {
      const payload = await call('POST', '/agent-bridges/me/heartbeat', {
        agent_state: input.agentState,
        queued: input.queued,
        running: input.running,
        capabilities: input.capabilities,
      });
      const bridge = asRecord(payload['bridge']);
      const status = bridge?.['status'];
      return { accepted: payload['accepted'] === true, bridgeStatus: typeof status === 'string' ? status : null };
    },

    async me() {
      const payload = await call('GET', '/agent-bridges/me');
      const bridge = asRecord(payload['bridge']);
      const persona = asRecord(payload['persona']);
      const owner = asRecord(payload['owner']);
      return {
        bridgeId: typeof bridge?.['id'] === 'string' ? bridge['id'] : null,
        personaUserId: typeof persona?.['user_id'] === 'string' ? persona['user_id'] : null,
        ownerUserId: typeof owner?.['user_id'] === 'string' ? owner['user_id'] : null,
      };
    },
  };
}
