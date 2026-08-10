import crypto from 'node:crypto';
import type { BaseInfo } from '../../types.js';
import { assertNoBodyError } from '../../v6/wechat/errcode.js';

export const BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const CHANNEL_VERSION = '1.0.0';

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
export const DEFAULT_API_TIMEOUT_MS = 15_000;
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

export function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

export function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  return headers;
}

export function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export async function apiFetch(params: {
  baseUrl?: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
  /**
   * 微信永远回 HTTP 200,失败信息藏在 body 的 ret/errcode 里。
   * 发送类接口开这个,别把"没发出去"当成功。
   * getUpdates 不能开 —— poller 靠这些错误码做暂停与退避。
   */
  failOnBodyError?: boolean;
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
    if (params.failOnBodyError) assertNoBodyError(params.label, rawText);
    return rawText;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decodeAesKey(aesKeyField: string): Buffer {
  const hexStr = Buffer.from(aesKeyField, 'base64').toString('utf-8');
  return Buffer.from(hexStr, 'hex');
}
