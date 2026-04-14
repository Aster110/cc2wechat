export {
  aesEcbPaddedSize,
  decodeAesKey,
  decryptAesEcb,
  encryptAesEcb,
} from './v5/shared/wechat-api-core.js';
export { getConfig, getUpdates } from './v5/receiver/wechat-receiver.js';
export {
  downloadMedia,
  sendMessage,
  sendTyping,
  uploadAndSendMedia,
} from './v5/sender/wechat-api-sender.js';

import { ensureTrailingSlash } from './v5/shared/wechat-api-core.js';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

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
