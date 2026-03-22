import crypto from 'node:crypto';
import type {
  BaseInfo,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from './types.js';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.0';

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  return headers;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Common POST wrapper with timeout + abort.
 */
async function apiFetch(params: {
  baseUrl?: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl ?? BASE_URL);
  const url = new URL(params.endpoint, base);
  const headers = buildHeaders(params.token, params.body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// QR Login
// ---------------------------------------------------------------------------

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

const QR_LONG_POLL_TIMEOUT_MS = 35_000;

export async function getQRCode(baseUrl?: string, botType = '3'): Promise<QRCodeResponse> {
  const base = ensureTrailingSlash(baseUrl ?? BASE_URL);
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Failed to fetch QR code: ${res.status} ${res.statusText} ${body}`);
  }
  return (await res.json()) as QRCodeResponse;
}

export async function pollQRStatus(qrcode: string, baseUrl?: string): Promise<QRStatusResponse> {
  const base = ensureTrailingSlash(baseUrl ?? BASE_URL);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`QR status poll failed: ${res.status} ${body}`);
    }
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Message APIs
// ---------------------------------------------------------------------------

export async function getUpdates(
  token: string,
  buf: string,
  baseUrl?: string,
  timeoutMs?: number,
): Promise<GetUpdatesResp> {
  const timeout = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: buf ?? '',
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs: timeout,
      label: 'getUpdates',
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

export async function sendMessage(
  token: string,
  to: string,
  text: string,
  contextToken: string,
  baseUrl?: string,
): Promise<void> {
  const body: SendMessageReq = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: `wechat-cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken,
    },
  };
  await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
    token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
  });
}

export async function sendTyping(
  token: string,
  userId: string,
  ticket: string,
  status = 1,
  baseUrl?: string,
): Promise<void> {
  const body: SendTypingReq = {
    ilink_user_id: userId,
    typing_ticket: ticket,
    status,
  };
  await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
    token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'sendTyping',
  });
}

export async function getConfig(
  token: string,
  userId: string,
  contextToken?: string,
  baseUrl?: string,
): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getConfig',
  });
  return JSON.parse(rawText) as GetConfigResp;
}
