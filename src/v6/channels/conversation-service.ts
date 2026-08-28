import { createHash } from 'node:crypto';

import { deriveConversationId } from '../session-store.js';
import type { ChannelMessage } from './contracts.js';

/**
 * 会话主权的唯一所在。
 *
 * (channel, endpointId, threadKey?) → conversationId。壳不许自己造会话 id,
 * Agent 只认 conversationId —— 中间这一层就是"谁在跟谁说话"的最终解释权。
 *
 * **微信兼容映射是硬约束**:channel='wechat' 时必须与现网
 * `deriveConversationId(accountId, userId)` 字节级相同,否则升一次版
 * 全体用户的 sessions-<accountId>.json 集体失忆。
 */

export type ConversationRule = (endpointId: string, threadKey?: string) => string;

export interface ConversationServiceOptions {
  /** 微信兼容映射需要的账号 id。没有 wechat 通道时可以不给 */
  wechatAccountId?: string;
}

/** 通用规则:sha256(`${channel}\n${endpointId}\n${threadKey ?? ''}`) 前 32 hex */
export function genericConversationId(channel: string, endpointId: string, threadKey?: string): string {
  return createHash('sha256')
    .update(`${channel}\n${endpointId}\n${threadKey ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

export class ConversationService {
  private rules = new Map<string, ConversationRule>();

  constructor(opts: ConversationServiceOptions = {}) {
    if (opts.wechatAccountId) {
      const accountId = opts.wechatAccountId;
      // 现网规则原样搬:threadKey 一律忽略 —— 微信侧根本没有这个维度,
      // 掺进去就换了一套 id。
      this.rules.set('wechat', (endpointId) => deriveConversationId(accountId, endpointId));
    }
  }

  /**
   * 注册自定义映射。
   * 用途之一:s1 的 tmux-brain —— 多个 endpoint 全落到同一个 conversationId。
   */
  register(channel: string, rule: ConversationRule): void {
    this.rules.set(channel, rule);
  }

  idFor(msg: Pick<ChannelMessage, 'channel' | 'endpointId'> & Pick<Partial<ChannelMessage>, 'threadKey'>): string {
    const rule = this.rules.get(msg.channel);
    if (rule) return rule(msg.endpointId, msg.threadKey);
    return genericConversationId(msg.channel, msg.endpointId, msg.threadKey);
  }
}
