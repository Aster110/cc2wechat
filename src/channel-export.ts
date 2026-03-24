import type { MessageChannel, SSEEvent } from '@aster110/cc-core';
import { sendMessage } from './wechat-api.js';

export interface WeChatChannelOptions {
  token: string;
  userId: string;
  contextToken: string;
  baseUrl?: string;
}

/**
 * WeChat MessageChannel implementation for mycc integration
 */
export class WeChatChannel implements MessageChannel {
  id: string;
  private token: string;
  private userId: string;
  private contextToken: string;
  private baseUrl?: string;

  constructor(options: WeChatChannelOptions) {
    this.id = `wechat:${options.userId}`;
    this.token = options.token;
    this.userId = options.userId;
    this.contextToken = options.contextToken;
    this.baseUrl = options.baseUrl;
  }

  /**
   * Only forward assistant/system text results to WeChat
   */
  filter(event: SSEEvent): boolean {
    const type = event.type as string | undefined;
    if (type === 'assistant' || type === 'system' || type === 'result') {
      return true;
    }
    return false;
  }

  /**
   * Send SSE event content as WeChat text message
   */
  async send(event: SSEEvent): Promise<void> {
    let text = '';

    if (event.type === 'result' && typeof event.result === 'string') {
      text = event.result;
    } else if (event.type === 'assistant' || event.type === 'system') {
      const message = event.message as { content?: unknown } | undefined;
      if (typeof message?.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message?.content)) {
        text = (message!.content as Array<{ type?: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text!)
          .join('\n');
      }
    }

    if (!text) return;

    await sendMessage(this.token, this.userId, text, this.contextToken, this.baseUrl);
  }
}
