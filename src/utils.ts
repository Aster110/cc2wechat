import { createHash } from 'node:crypto';
import type { WeixinMessage } from './types.js';
import { MessageItemType } from './types.js';

export function userIdToSessionUUID(userId: string): string {
  const hash = createHash('md5').update(`cc2wechat:${userId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Extract text from a WeChat message.
 *
 * @param msg - WeChat message
 * @param mediaPaths - map of item index → downloaded file path (from downloadMediaItems)
 */
export function extractText(msg: WeixinMessage, mediaPaths?: Map<number, string>): string {
  const parts: string[] = [];
  const items = msg.item_list ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const downloadedPath = mediaPaths?.get(i);
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MessageItemType.IMAGE) {
      parts.push(downloadedPath ? `[Image: ${downloadedPath}]` : '[Image]');
    } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(`[Voice] ${item.voice_item.text}`);
    } else if (item.type === MessageItemType.FILE && item.file_item?.file_name) {
      parts.push(downloadedPath
        ? `[File: ${downloadedPath}]`
        : `[File: ${item.file_item.file_name}]`);
    } else if (item.type === MessageItemType.VIDEO) {
      parts.push(downloadedPath ? `[Video: ${downloadedPath}]` : '[Video]');
    }
  }
  return parts.join('\n') || '[Empty message]';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function log(msg: string): void {
  console.log(`[cc2wechat ${ts()}] ${msg}`);
}

export function logError(msg: string): void {
  console.error(`[cc2wechat ${ts()}] ${msg}`);
}
