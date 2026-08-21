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
import { promises as fsPromises } from 'node:fs';
import { basename } from 'node:path';

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

/**
 * 发送一条消息。`kind` 缺省 `text`（老调用方一字不改）。
 *
 * 真源（waku-core `routes/v1/chat.py`）：
 * - image：`{kind:'image', image_asset_id, image_width?, image_height?}`
 * - video：`{kind:'video', payload:{asset_id, poster_asset_id?, width?, height?, duration_ms?}}`
 * - voice：`{kind:'voice', payload:{asset_id, duration_ms}}` —— duration_ms **必填**
 * - playable_card：`{kind:'playable_card', content_id, launch_ctx?}` —— 内容必须 live 且
 *   visibility ∈ {public, friends}，private 会 404 `content_not_found`
 */
export interface SendMessageInput {
  clientMsgId: string;
  kind?: 'text' | 'image' | 'video' | 'voice' | 'playable_card';
  body?: string;
  imageAssetId?: string;
  imageWidth?: number;
  imageHeight?: number;
  payload?: Record<string, unknown>;
  contentId?: string;
  launchCtx?: Record<string, string>;
}

export interface UploadedAsset {
  assetId: string;
  publicUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
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
  /**
   * multipart 上传一个本机文件 → asset。路由按身份分家：
   * bridge 身份走 `/agent-bridges/me/assets`，session（真账号）走 `/assets`。
   * 415（mime 不收）/ 413（太大）是**永久**失败，429 带 Retry-After 是可重试。
   */
  uploadAsset(filePath: string, mime: string): Promise<UploadedAsset>;
}

export interface WakuChatClientOptions {
  apiBase: string;
  tokens: Pick<BridgeTokenProvider, 'current' | 'invalidate' | 'mode'>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 上传要读盘 + 传大文件，与普通 REST 不是一个量级的时限。 */
  uploadTimeoutMs?: number;
}

export const WAKU_CHAT_REQUEST_TIMEOUT_MS = 15_000;
export const WAKU_CHAT_UPLOAD_TIMEOUT_MS = 180_000;
export const WAKU_CHAT_BODY_MAX_CHARS = 4000;
/** bridge 身份的上传口。 */
export const BRIDGE_ASSET_UPLOAD_PATH = '/agent-bridges/me/assets';
/** session（真账号）身份的上传口。 */
export const SESSION_ASSET_UPLOAD_PATH = '/assets';

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

/** SendMessageInput → 线上 body。kind 决定哪些字段上车，多余字段一个都不发。 */
export function sendBody(input: SendMessageInput): Record<string, unknown> {
  const kind = input.kind ?? 'text';
  const base: Record<string, unknown> = { client_msg_id: input.clientMsgId, kind };
  if (kind === 'text') {
    base['body'] = input.body ?? '';
    return base;
  }
  if (input.body !== undefined && input.body.length > 0) base['body'] = input.body;
  if (kind === 'image') {
    base['image_asset_id'] = input.imageAssetId;
    if (input.imageWidth !== undefined) base['image_width'] = input.imageWidth;
    if (input.imageHeight !== undefined) base['image_height'] = input.imageHeight;
    return base;
  }
  if (kind === 'video' || kind === 'voice') {
    base['payload'] = input.payload ?? {};
    return base;
  }
  base['content_id'] = input.contentId;
  if (input.launchCtx !== undefined) base['launch_ctx'] = input.launchCtx;
  return base;
}

export function createWakuChatClient(options: WakuChatClientOptions): WakuChatClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? WAKU_CHAT_REQUEST_TIMEOUT_MS;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? WAKU_CHAT_UPLOAD_TIMEOUT_MS;

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

  /** multipart 上传。与 `call` 共用鉴权/错误分类，但**不共用** JSON 头与超时。 */
  async function upload(route: string, filePath: string, mime: string): Promise<Record<string, unknown>> {
    let bytes: Buffer;
    try {
      bytes = await fsPromises.readFile(filePath);
    } catch {
      throw new WakuApiError({ kind: 'http', status: null, code: 'attachment_unreadable', message: `cannot read ${basename(filePath)}` });
    }

    let retriedAuth = false;
    for (;;) {
      let token: string;
      try {
        token = await options.tokens.current();
      } catch (error) {
        const code = typeof (error as { code?: unknown } | undefined)?.code === 'string' ? (error as { code: string }).code : 'credential_unavailable';
        throw new WakuApiError({ kind: 'auth', status: null, code, message: 'credentials are unavailable' });
      }

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), basename(filePath));

      let response: Response;
      try {
        response = await fetchImpl(`${apiBase}${route}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          body: form,
          signal: AbortSignal.timeout(uploadTimeoutMs),
        });
      } catch (error) {
        throw new WakuApiError({
          kind: 'network',
          status: null,
          code: 'network',
          message: `POST ${route} failed before a response arrived (${error instanceof Error ? error.name : 'error'})`,
        });
      }

      const text = await response.text().catch(() => '');
      let parsed: unknown = null;
      try {
        parsed = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        parsed = null;
      }
      const record = asRecord(parsed);

      if (response.ok) {
        if (record === null) {
          throw new WakuApiError({ kind: 'http', status: response.status, code: 'bad_response', message: `POST ${route} returned a non-JSON body` });
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
        message: `POST ${route} failed with HTTP ${response.status} (${codeOf(response.status, record)})`,
        retryAfterMs: retryAfterMsOf(response.headers, record),
      });
    }
  }

  return {
    async sendMessage(conversationId, input) {
      const payload = await call(
        'POST',
        `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
        sendBody(input),
      );
      const message = asRecord(payload['message']);
      const messageId = typeof message?.['id'] === 'string' ? message['id'] : '';
      return { messageId, created: payload['created'] === true };
    },

    async uploadAsset(filePath, mime) {
      const route = options.tokens.mode === 'bridge' ? BRIDGE_ASSET_UPLOAD_PATH : SESSION_ASSET_UPLOAD_PATH;
      const payload = await upload(route, filePath, mime);
      // 平台在两条路由上分别叫 asset_id / id：两个都认，缺了才算失败。
      const assetId =
        typeof payload['asset_id'] === 'string' && payload['asset_id'].length > 0
          ? payload['asset_id']
          : typeof payload['id'] === 'string' && payload['id'].length > 0
            ? payload['id']
            : null;
      if (assetId === null) {
        throw new WakuApiError({ kind: 'http', status: 200, code: 'bad_response', message: `POST ${route} did not return an asset id` });
      }
      return {
        assetId,
        publicUrl: typeof payload['public_url'] === 'string' ? payload['public_url'] : null,
        mimeType: typeof payload['mime_type'] === 'string' ? payload['mime_type'] : null,
        sizeBytes: typeof payload['size_bytes'] === 'number' ? payload['size_bytes'] : null,
      };
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
