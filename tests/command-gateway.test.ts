import { describe, it, expect } from 'vitest';
import { CommandGateway, createDefaultGateway } from '../src/v5/core/command-gateway.js';
import type { CommandContext } from '../src/v5/core/command-gateway.js';

function createMockContext(text: string): CommandContext & { replies: string[] } {
  const replies: string[] = [];
  const closedUsers: string[] = [];
  const createdUsers: string[] = [];
  return {
    userId: 'user-1',
    contextToken: 'token-1',
    text,
    delivery: {} as any,
    replies,
    reply: async (t: string) => { replies.push(t); },
    closeSession: async (uid: string) => { closedUsers.push(uid); },
    createNewSession: async (uid: string) => { createdUsers.push(uid); },
  };
}

describe('CommandGateway', () => {
  describe('tryHandle', () => {
    it('returns false for non-command text', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('hello world');
      expect(await gw.tryHandle(ctx)).toBe(false);
    });

    it('handles /new command', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('/new');
      expect(await gw.tryHandle(ctx)).toBe(true);
      expect(ctx.replies[0]).toContain('新对话');
    });

    it('handles /exit command', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('/exit');
      expect(await gw.tryHandle(ctx)).toBe(true);
      expect(ctx.replies[0]).toContain('已关闭');
    });

    it('handles Chinese alias 退出', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('退出');
      expect(await gw.tryHandle(ctx)).toBe(true);
    });

    it('handles Chinese alias 结束', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('结束');
      expect(await gw.tryHandle(ctx)).toBe(true);
    });

    it('handles /help command', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('/help');
      expect(await gw.tryHandle(ctx)).toBe(true);
      expect(ctx.replies[0]).toContain('/new');
      expect(ctx.replies[0]).toContain('/exit');
      expect(ctx.replies[0]).toContain('/help');
    });

    it('handles 帮助 command', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('帮助');
      expect(await gw.tryHandle(ctx)).toBe(true);
    });

    it('is case-insensitive', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('/NEW');
      expect(await gw.tryHandle(ctx)).toBe(true);
    });

    it('trims whitespace', async () => {
      const gw = createDefaultGateway();
      const ctx = createMockContext('  /help  ');
      expect(await gw.tryHandle(ctx)).toBe(true);
    });
  });

  describe('register', () => {
    it('registers custom commands', async () => {
      const gw = new CommandGateway();
      const handled: string[] = [];
      gw.register(['/test', '/t'], {
        description: 'test command',
        handler: async (ctx) => { handled.push(ctx.text); },
      });
      const ctx = createMockContext('/test');
      expect(await gw.tryHandle(ctx)).toBe(true);
      expect(handled).toHaveLength(1);
    });
  });
});
