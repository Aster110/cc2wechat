import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock wechat-api
vi.mock('../wechat-api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

import { WeChatChannel } from '../channel-export.js';
import { sendMessage } from '../wechat-api.js';

describe('WeChatChannel', () => {
  let channel: WeChatChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new WeChatChannel({
      token: 'test-token',
      userId: 'user-123',
      contextToken: 'ctx-456',
      baseUrl: 'https://example.com',
    });
  });

  it('should implement MessageChannel interface', () => {
    expect(channel.id).toBe('wechat:user-123');
    expect(typeof channel.send).toBe('function');
    expect(typeof channel.filter).toBe('function');
  });

  describe('filter', () => {
    it('should accept assistant events', () => {
      expect(channel.filter!({ type: 'assistant', message: {} })).toBe(true);
    });

    it('should accept system events', () => {
      expect(channel.filter!({ type: 'system', message: {} })).toBe(true);
    });

    it('should accept result events', () => {
      expect(channel.filter!({ type: 'result', result: 'hello' })).toBe(true);
    });

    it('should reject user events', () => {
      expect(channel.filter!({ type: 'user', message: {} })).toBe(false);
    });

    it('should reject tool events', () => {
      expect(channel.filter!({ type: 'tool_use' })).toBe(false);
    });
  });

  describe('send', () => {
    it('should send result event text via sendMessage', async () => {
      await channel.send({ type: 'result', result: 'Hello!' });

      expect(sendMessage).toHaveBeenCalledWith(
        'test-token',
        'user-123',
        'Hello!',
        'ctx-456',
        'https://example.com',
      );
    });

    it('should send assistant event with string content', async () => {
      await channel.send({
        type: 'assistant',
        message: { content: 'Hi there' },
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'test-token',
        'user-123',
        'Hi there',
        'ctx-456',
        'https://example.com',
      );
    });

    it('should send assistant event with block content', async () => {
      await channel.send({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' },
          ],
        },
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'test-token',
        'user-123',
        'Part 1\nPart 2',
        'ctx-456',
        'https://example.com',
      );
    });

    it('should not send when no text content', async () => {
      await channel.send({ type: 'assistant', message: {} });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should not send for non-result non-text events', async () => {
      await channel.send({ type: 'result', result: 42 });
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
