import { describe, it, expect, vi } from 'vitest';
import { Replier } from '../src/v5/sender/replier.js';
import type { MessageSender, MessageContext } from '../src/v5/interfaces/index.js';

function createMockSender(): MessageSender & { calls: Array<{ to: string; text: string; token: string }> } {
  const calls: Array<{ to: string; text: string; token: string }> = [];
  return {
    calls,
    async sendText(to: string, text: string, contextToken: string) {
      calls.push({ to, text, token: contextToken });
    },
    async sendMedia() {},
  };
}

function createCtx(overrides?: Partial<MessageContext>): MessageContext {
  return {
    text: 'test',
    mediaFiles: [],
    userId: 'user-1',
    sessionId: 'session-1',
    contextToken: 'ctx-token',
    rawMessage: {},
    account: {},
    cwd: '/tmp',
    ...overrides,
  };
}

describe('Replier', () => {
  describe('reply', () => {
    it('sends text to the correct user with context token', async () => {
      const sender = createMockSender();
      const replier = new Replier(sender);
      const ctx = createCtx();

      await replier.reply(ctx, 'Hello');

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].to).toBe('user-1');
      expect(sender.calls[0].text).toBe('Hello');
      expect(sender.calls[0].token).toBe('ctx-token');
    });

    it('strips markdown when enabled', async () => {
      const sender = createMockSender();
      const replier = new Replier(sender, { maxChunkSize: 3900, stripMarkdown: true });
      const ctx = createCtx();

      await replier.reply(ctx, '**bold** and [link](http://example.com)');

      expect(sender.calls[0].text).toBe('bold and link');
    });

    it('preserves markdown when disabled', async () => {
      const sender = createMockSender();
      const replier = new Replier(sender, { maxChunkSize: 3900, stripMarkdown: false });
      const ctx = createCtx();

      await replier.reply(ctx, '**bold**');

      expect(sender.calls[0].text).toBe('**bold**');
    });

    it('splits long text into multiple chunks', async () => {
      const sender = createMockSender();
      const replier = new Replier(sender, { maxChunkSize: 50, stripMarkdown: false });
      const ctx = createCtx();

      const longText = 'Line one of the message\nLine two of the message\nLine three of the message here';
      await replier.reply(ctx, longText);

      expect(sender.calls.length).toBeGreaterThan(1);
      // All chunks together should contain all content
      const combined = sender.calls.map(c => c.text).join('\n');
      expect(combined).toContain('Line one');
      expect(combined).toContain('Line three');
    });

    it('does not split short text', async () => {
      const sender = createMockSender();
      const replier = new Replier(sender, { maxChunkSize: 3900, stripMarkdown: false });
      const ctx = createCtx();

      await replier.reply(ctx, 'Short message');

      expect(sender.calls).toHaveLength(1);
    });
  });
});
