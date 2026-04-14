import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { sendMessage, uploadAndSendMedia, sendTyping, getConfig } from '../../wechat-api.js';
import type { AccountData } from '../../store.js';
import type { MessageSender } from '../interfaces/index.js';

export function createWeChatSender(account: AccountData): MessageSender {
  return {
    async sendText(to: string, text: string, contextToken: string): Promise<void> {
      await sendMessage(account.token, to, text, contextToken, account.baseUrl);
    },
    async sendMedia(to: string, filePath: string, contextToken: string): Promise<void> {
      await uploadAndSendMedia({
        token: account.token,
        toUser: to,
        contextToken,
        filePath,
        baseUrl: account.baseUrl,
      });
    },
  };
}

export async function sendTypingIndicator(
  account: AccountData,
  userId: string,
  contextToken: string,
): Promise<void> {
  try {
    const cfg = await getConfig(account.token, userId, contextToken, account.baseUrl);
    if (cfg.typing_ticket) {
      await sendTyping(account.token, userId, cfg.typing_ticket, 1, account.baseUrl).catch(() => {});
    }
  } catch {
    // non-critical
  }
}

export function contextPathForUser(userId: string): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
  return `/tmp/cc2wechat-ctx-${hash}.json`;
}

export function writeReplyContext(
  account: AccountData,
  userId: string,
  contextToken: string,
): string {
  const filePath = contextPathForUser(userId);
  fs.writeFileSync(filePath, JSON.stringify({
    token: account.token,
    baseUrl: account.baseUrl,
    userId,
    contextToken,
  }));
  return filePath;
}
