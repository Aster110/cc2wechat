import { createHash } from 'node:crypto';
import type { WeixinMessage } from './types.js';
import { MessageItemType } from './types.js';

export function userIdToSessionUUID(userId: string): string {
  const hash = createHash('md5').update(`cc2wechat:${userId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function extractText(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MessageItemType.IMAGE) {
      parts.push('[Image]');
    } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(`[Voice] ${item.voice_item.text}`);
    } else if (item.type === MessageItemType.FILE && item.file_item?.file_name) {
      parts.push(`[File: ${item.file_item.file_name}]`);
    } else if (item.type === MessageItemType.VIDEO) {
      parts.push('[Video]');
    }
  }
  return parts.join('\n') || '[Empty message]';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
