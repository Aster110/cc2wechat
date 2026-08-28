import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { ConversationService, genericConversationId } from '../../../v6/channels/conversation-service.js';
import { deriveConversationId } from '../../../v6/session-store.js';

/**
 * 会话主权测试。
 *
 * 头号硬约束:微信路径必须**字节级**等于现网 deriveConversationId(accountId, userId)。
 * 差一个字节 = 全体用户的 sessions-<accountId>.json 集体失忆。
 */

describe('ConversationService — 微信兼容映射(现网零迁移)', () => {
  it('channel=wechat 时与现网 deriveConversationId 逐字节相同', () => {
    const svc = new ConversationService({ wechatAccountId: 'acc-1' });
    for (const userId of ['user-1', 'wxid_abc123', '', '带中文的 用户 id', 'a'.repeat(200)]) {
      const viaService = svc.idFor({ channel: 'wechat', endpointId: userId });
      const viaLegacy = deriveConversationId('acc-1', userId);
      expect(viaService).toBe(viaLegacy);
    }
  });

  it('对拍现网规则本身:sha256(`${accountId}\\n${userId}`) 前 32 hex', () => {
    const svc = new ConversationService({ wechatAccountId: 'acc-1' });
    const expected = createHash('sha256').update('acc-1\nuser-1').digest('hex').slice(0, 32);
    expect(svc.idFor({ channel: 'wechat', endpointId: 'user-1' })).toBe(expected);
    expect(expected).toHaveLength(32);
  });

  it('微信路径忽略 threadKey —— 现网没有这个维度,加进去就变 id 了', () => {
    const svc = new ConversationService({ wechatAccountId: 'acc-1' });
    expect(svc.idFor({ channel: 'wechat', endpointId: 'user-1', threadKey: 'whatever' })).toBe(
      deriveConversationId('acc-1', 'user-1'),
    );
  });

  it('换 accountId 就是另一个人的会话', () => {
    const a = new ConversationService({ wechatAccountId: 'acc-1' });
    const b = new ConversationService({ wechatAccountId: 'acc-2' });
    expect(a.idFor({ channel: 'wechat', endpointId: 'user-1' })).not.toBe(
      b.idFor({ channel: 'wechat', endpointId: 'user-1' }),
    );
  });

  it('没给 wechatAccountId 就没有兼容映射,退回通用规则(不许悄悄编一个 accountId)', () => {
    const svc = new ConversationService();
    expect(svc.idFor({ channel: 'wechat', endpointId: 'user-1' })).toBe(
      genericConversationId('wechat', 'user-1'),
    );
  });
});

describe('ConversationService — 通用规则', () => {
  it('sha256(`${channel}\\n${endpointId}\\n${threadKey ?? \'\'}`) 前 32 hex', () => {
    const svc = new ConversationService();
    const expected = createHash('sha256').update('web\ndefault\n').digest('hex').slice(0, 32);
    expect(svc.idFor({ channel: 'web', endpointId: 'default' })).toBe(expected);
  });

  it('稳定:同样输入永远同一个 id', () => {
    const svc = new ConversationService();
    const a = svc.idFor({ channel: 'web', endpointId: 'e1', threadKey: 't1' });
    const b = svc.idFor({ channel: 'web', endpointId: 'e1', threadKey: 't1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('channel / endpointId / threadKey 任一不同 → 不同会话', () => {
    const svc = new ConversationService();
    const base = svc.idFor({ channel: 'web', endpointId: 'e1', threadKey: 't1' });
    expect(svc.idFor({ channel: 'mesh', endpointId: 'e1', threadKey: 't1' })).not.toBe(base);
    expect(svc.idFor({ channel: 'web', endpointId: 'e2', threadKey: 't1' })).not.toBe(base);
    expect(svc.idFor({ channel: 'web', endpointId: 'e1', threadKey: 't2' })).not.toBe(base);
    expect(svc.idFor({ channel: 'web', endpointId: 'e1' })).not.toBe(base);
  });

  it('分隔符不许被内容伪造:("a\\nb", "") 与 ("a", "b") 不能撞', () => {
    const svc = new ConversationService();
    expect(svc.idFor({ channel: 'web', endpointId: 'a\nb' })).not.toBe(
      svc.idFor({ channel: 'web', endpointId: 'a', threadKey: 'b' }),
    );
  });
});

describe('ConversationService — 自定义映射(tmux-brain 那类多对一)', () => {
  it('register 能让一个通道的所有 endpoint 落到同一个会话', () => {
    const svc = new ConversationService({ wechatAccountId: 'acc-1' });
    svc.register('mesh', () => 'brain');

    expect(svc.idFor({ channel: 'mesh', endpointId: 'node-a' })).toBe('brain');
    expect(svc.idFor({ channel: 'mesh', endpointId: 'node-b' })).toBe('brain');
    // 别的通道不受影响
    expect(svc.idFor({ channel: 'wechat', endpointId: 'user-1' })).toBe(deriveConversationId('acc-1', 'user-1'));
  });

  it('register 覆盖微信兼容映射是显式行为(不会被误触发)', () => {
    const svc = new ConversationService({ wechatAccountId: 'acc-1' });
    expect(svc.idFor({ channel: 'wechat', endpointId: 'u' })).toBe(deriveConversationId('acc-1', 'u'));
    svc.register('wechat', () => 'override');
    expect(svc.idFor({ channel: 'wechat', endpointId: 'u' })).toBe('override');
  });
});
