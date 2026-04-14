import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SendMessageReq, SendTypingReq } from '../../types.js';
import {
  apiFetch,
  buildBaseInfo,
  buildHeaders,
  CDN_BASE_URL,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_CONFIG_TIMEOUT_MS,
  decodeAesKey,
  decryptAesEcb,
  encryptAesEcb,
} from '../shared/wechat-api-core.js';

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
      message_type: 2,
      message_state: 2,
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

export async function uploadAndSendMedia(params: {
  token: string;
  toUser: string;
  contextToken: string;
  filePath: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
}): Promise<void> {
  const { token, toUser, contextToken, filePath, baseUrl, cdnBaseUrl } = params;

  const fileData = fs.readFileSync(filePath);
  const rawsize = fileData.length;
  const rawfilemd5 = crypto.createHash('md5').update(fileData).digest('hex');

  const aeskey = crypto.randomBytes(16);
  const mediaType = detectMediaType(filePath);

  const ciphertext = encryptAesEcb(fileData, aeskey);
  const ciphertextSize = ciphertext.length;

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

const MEDIA_DIR = '/tmp/cc2wechat-media';

export async function downloadMedia(params: {
  token: string;
  encryptQueryParam: string;
  aesKey: string;
  outputFileName: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
}): Promise<string> {
  const { token, encryptQueryParam, aesKey, outputFileName, cdnBaseUrl } = params;

  await fsp.mkdir(MEDIA_DIR, { recursive: true });

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

    const key = decodeAesKey(aesKey);
    const plaintext = decryptAesEcb(encryptedData, key);

    const outputPath = path.join(MEDIA_DIR, outputFileName);
    await fsp.writeFile(outputPath, plaintext);

    return outputPath;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
