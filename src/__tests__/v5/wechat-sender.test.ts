import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

vi.mock('../../wechat-api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  uploadAndSendMedia: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn(),
}));

import {
  createWeChatSender,
  contextPathForUser,
  writeReplyContext,
  sendTypingIndicator,
} from '../../v5/sender/wechat-sender.js';
import {
  sendMessage,
  uploadAndSendMedia,
  sendTyping,
  getConfig,
} from '../../wechat-api.js';
import type { AccountData } from '../../store.js';

const account: AccountData = {
  accountId: 'acc-1',
  token: 'tok',
  baseUrl: 'https://example.com',
  savedAt: '2026-01-01',
  port: 18081,
} as AccountData;

describe('createWeChatSender', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sendText forwards to wechat-api.sendMessage', async () => {
    const sender = createWeChatSender(account);
    await sender.sendText('user-1', 'hello', 'ctx-1');
    expect(sendMessage).toHaveBeenCalledWith('tok', 'user-1', 'hello', 'ctx-1', 'https://example.com');
  });

  it('sendMedia forwards to wechat-api.uploadAndSendMedia', async () => {
    const sender = createWeChatSender(account);
    await sender.sendMedia('user-1', '/tmp/pic.jpg', 'ctx-1');
    expect(uploadAndSendMedia).toHaveBeenCalledWith({
      token: 'tok',
      toUser: 'user-1',
      contextToken: 'ctx-1',
      filePath: '/tmp/pic.jpg',
      baseUrl: 'https://example.com',
    });
  });
});

describe('contextPathForUser', () => {
  it('produces deterministic md5-based hash path', () => {
    const p1 = contextPathForUser('user-1');
    const p2 = contextPathForUser('user-1');
    const expectedHash = createHash('md5').update('user-1').digest('hex').slice(0, 8);
    expect(p1).toBe(p2);
    expect(p1).toBe(`/tmp/cc2wechat-ctx-${expectedHash}.json`);
  });

  it('produces different paths for different users', () => {
    expect(contextPathForUser('a')).not.toBe(contextPathForUser('b'));
  });
});

describe('writeReplyContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a JSON context file and returns its path', () => {
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const p = writeReplyContext(account, 'user-1', 'ctx-1');
    expect(p).toBe(contextPathForUser('user-1'));
    expect(spy).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBody] = spy.mock.calls[0];
    expect(writtenPath).toBe(p);
    expect(JSON.parse(writtenBody as string)).toEqual({
      token: 'tok',
      baseUrl: 'https://example.com',
      userId: 'user-1',
      contextToken: 'ctx-1',
    });
    spy.mockRestore();
  });
});

describe('sendTypingIndicator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends typing when config returns ticket', async () => {
    (getConfig as any).mockResolvedValue({ typing_ticket: 'ticket-1' });
    await sendTypingIndicator(account, 'user-1', 'ctx-1');
    expect(sendTyping).toHaveBeenCalledWith('tok', 'user-1', 'ticket-1', 1, 'https://example.com');
  });

  it('swallows errors (non-critical)', async () => {
    (getConfig as any).mockRejectedValue(new Error('boom'));
    await expect(sendTypingIndicator(account, 'user-1', 'ctx-1')).resolves.toBeUndefined();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it('does not throw when typing_ticket is missing', async () => {
    (getConfig as any).mockResolvedValue({});
    await expect(sendTypingIndicator(account, 'user-1', 'ctx-1')).resolves.toBeUndefined();
    expect(sendTyping).not.toHaveBeenCalled();
  });
});
