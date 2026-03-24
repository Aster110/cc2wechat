import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  BaseInfo,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from './types.js';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
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

// ---------------------------------------------------------------------------
// CDN Upload & Media Send
// ---------------------------------------------------------------------------

/** AES-128-ECB encrypt (PKCS7 padding). */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Compute AES-ECB ciphertext size (PKCS7 padding). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** Determine media type from file extension: 1=IMAGE, 2=VIDEO, 3=FILE. */
function detectMediaType(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) return 1;
  if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) return 2;
  return 3;
}

interface GetUploadUrlResp {
  upload_param?: string;
  filekey?: string;
}

/**
 * Upload a local file to WeChat CDN and send it as a media message.
 */
export async function uploadAndSendMedia(params: {
  token: string;
  toUser: string;
  contextToken: string;
  filePath: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
}): Promise<void> {
  const { token, toUser, contextToken, filePath, baseUrl, cdnBaseUrl } = params;

  // 1. Read file, compute rawsize + MD5
  const fileData = fs.readFileSync(filePath);
  const rawsize = fileData.length;
  const rawfilemd5 = crypto.createHash('md5').update(fileData).digest('hex');

  // 2. Generate random AES key (16 bytes)
  const aeskey = crypto.randomBytes(16);

  // 3. Detect media type
  const mediaType = detectMediaType(filePath);

  // 4. Encrypt
  const ciphertext = encryptAesEcb(fileData, aeskey);
  const ciphertextSize = ciphertext.length;

  // 5. Get upload URL
  const filekey = `wcc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(filePath)}`;

  const uploadUrlBody = JSON.stringify({
    filekey,
    media_type: mediaType,
    to_user_id: toUser,
    rawsize,
    rawfilemd5,
    filesize: ciphertextSize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
    base_info: buildBaseInfo(),
  });

  const uploadUrlRaw = await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: uploadUrlBody,
    token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'getUploadUrl',
  });
  const uploadUrlResp = JSON.parse(uploadUrlRaw) as GetUploadUrlResp;
  const uploadParam = uploadUrlResp.upload_param;
  const serverFilekey = uploadUrlResp.filekey || filekey;
  if (!uploadParam) {
    throw new Error('getUploadUrl did not return upload_param');
  }

  // 6. Upload to CDN
  const cdn = cdnBaseUrl ?? CDN_BASE_URL;
  const uploadUrl = `${cdn}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(serverFilekey)}`;

  const headers = buildHeaders(token);
  headers['Content-Type'] = 'application/octet-stream';
  headers['Content-Length'] = String(ciphertextSize);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: new Uint8Array(ciphertext),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CDN upload failed: ${res.status} ${body}`);
    }

    const downloadParam = res.headers.get('x-encrypted-param');
    if (!downloadParam) {
      throw new Error('CDN upload did not return x-encrypted-param header');
    }

    // 7. Build media item and send message
    const aesKeyBase64 = Buffer.from(aeskey.toString('hex')).toString('base64');
    const mediaInfo = {
      encrypt_query_param: downloadParam,
      aes_key: aesKeyBase64,
      encrypt_type: 1,
    };

    let mediaItem: Record<string, unknown>;
    if (mediaType === 1) {
      mediaItem = { type: 2, image_item: { media: mediaInfo, mid_size: ciphertextSize } };
    } else if (mediaType === 2) {
      mediaItem = { type: 5, video_item: { media: mediaInfo, video_size: ciphertextSize } };
    } else {
      mediaItem = {
        type: 4,
        file_item: {
          media: mediaInfo,
          file_name: path.basename(filePath),
          len: String(rawsize),
          md5: rawfilemd5,
        },
      };
    }

    const msgBody = {
      msg: {
        from_user_id: '',
        to_user_id: toUser,
        client_id: `wcc-${Date.now()}`,
        message_type: 2,
        message_state: 2,
        item_list: [mediaItem],
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    };

    await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      body: JSON.stringify(msgBody),
      token,
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: 'sendMediaMessage',
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CDN Download & Media Receive
// ---------------------------------------------------------------------------

const MEDIA_DIR = '/tmp/cc2wechat-media';

/** AES-128-ECB decrypt (reverse of encryptAesEcb). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Decode the aes_key from message format back to raw 16-byte key.
 *
 * Upload encodes as: base64(hex_string_of_16_bytes)
 * So we: base64-decode → hex string → Buffer.from(hex)
 */
export function decodeAesKey(aesKeyField: string): Buffer {
  const hexStr = Buffer.from(aesKeyField, 'base64').toString('utf-8');
  return Buffer.from(hexStr, 'hex');
}

/**
 * Download and decrypt a media file from WeChat CDN.
 *
 * @returns absolute path of the saved file
 */
export async function downloadMedia(params: {
  token: string;
  encryptQueryParam: string;
  aesKey: string;
  outputFileName: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
}): Promise<string> {
  const { token, encryptQueryParam, aesKey, outputFileName, cdnBaseUrl } = params;

  // Ensure output dir
  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  // 1. Download encrypted data from CDN
  const cdn = cdnBaseUrl ?? CDN_BASE_URL;
  const downloadUrl = `${cdn}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;

  const headers = buildHeaders(token);
  headers['Content-Type'] = 'application/octet-stream';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(downloadUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CDN download failed: ${res.status} ${body}`);
    }

    const encryptedData = Buffer.from(await res.arrayBuffer());

    // 2. Decrypt
    const key = decodeAesKey(aesKey);
    const plaintext = decryptAesEcb(encryptedData, key);

    // 3. Write to file
    const outputPath = path.join(MEDIA_DIR, outputFileName);
    await fsp.writeFile(outputPath, plaintext);

    return outputPath;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
