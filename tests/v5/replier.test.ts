import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Replier 分片 + Markdown 清理测试
 */

// ---- 内联接口 ----

interface MessageContext {
  text: string;
  mediaFiles: string[];
  userId: string;
  sessionId: string;
  contextToken: string;
  rawMessage: unknown;
  account: unknown;
  cwd: string;
}

interface MessageSender {
  sendText(to: string, text: string, contextToken: string): Promise<void>;
  sendMedia(to: string, filePath: string, contextToken: string): Promise<void>;
}

// ---- Replier 简化实现 ----

class Replier {
  constructor(
    private sender: MessageSender,
    private opts: { maxChunkSize: number; stripMarkdown: boolean } = { maxChunkSize: 3900, stripMarkdown: true },
  ) {}

  async reply(ctx: MessageContext, text: string): Promise<void> {
    let processed = text;
    if (this.opts.stripMarkdown) {
      processed = this.stripMarkdown(processed);
    }

    const chunks = this.split(processed, this.opts.maxChunkSize);
    for (const chunk of chunks) {
      await this.sender.sendText(ctx.userId, chunk, ctx.contextToken);
    }
  }

  async replyMedia(ctx: MessageContext, filePath: string): Promise<void> {
    await this.sender.sendMedia(ctx.userId, filePath, ctx.contextToken);
  }

  private stripMarkdown(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, (match) => {
        // Remove ``` wrappers but keep content
        return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      })
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '');
  }

  private split(text: string, maxSize: number): string[] {
    if (text.length <= maxSize) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxSize) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', maxSize);
      if (splitAt <= 0) splitAt = maxSize;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
  }
}

// ---- Helpers ----

function makeCtx(overrides?: Partial<MessageContext>): MessageContext {
  return {
    text: 'hello',
    mediaFiles: [],
    userId: 'user-1',
    sessionId: 'sess-1',
    contextToken: 'ctx-tok',
    rawMessage: {},
    account: {},
    cwd: '/tmp',
    ...overrides,
  };
}

// ---- Tests ----

describe('Replier', () => {
  let mockSender: {
    sendText: ReturnType<typeof vi.fn>;
    sendMedia: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMedia: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('reply — short text', () => {
    it('sends text in a single call when under maxChunkSize', async () => {
      const replier = new Replier(mockSender, { maxChunkSize: 3900, stripMarkdown: false });
      const shortText = 'Hello, this is a short message.';

      await replier.reply(makeCtx(), shortText);

      expect(mockSender.sendText).toHaveBeenCalledTimes(1);
      expect(mockSender.sendText).toHaveBeenCalledWith('user-1', shortText, 'ctx-tok');
    });
  });

  describe('reply — long text chunking', () => {
    it('splits 8000-char text into 2-3 chunks', async () => {
      const replier = new Replier(mockSender, { maxChunkSize: 3900, stripMarkdown: false });
      // Create 8000 char text with newlines every 100 chars
      const lines = Array.from({ length: 80 }, (_, i) => `Line ${i}: ${'x'.repeat(90)}`);
      const longText = lines.join('\n');
      expect(longText.length).toBeGreaterThan(7000);

      await replier.reply(makeCtx(), longText);

      const callCount = mockSender.sendText.mock.calls.length;
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(callCount).toBeLessThanOrEqual(3);

      // All chunks should be within max size
      for (const call of mockSender.sendText.mock.calls) {
        expect(call[1].length).toBeLessThanOrEqual(3900);
      }
    });

    it('reassembled chunks equal original text (no data loss)', async () => {
      const replier = new Replier(mockSender, { maxChunkSize: 100, stripMarkdown: false });
      const text = Array.from({ length: 10 }, (_, i) => `Part ${i}`).join('\n');

      await replier.reply(makeCtx(), text);

      const reassembled = mockSender.sendText.mock.calls.map((c: unknown[]) => c[1]).join('\n');
      expect(reassembled).toBe(text);
    });
  });

  describe('reply — markdown stripping', () => {
    it('removes ** bold markers', async () => {
      const replier = new Replier(mockSender, { maxChunkSize: 3900, stripMarkdown: true });

      await replier.reply(makeCtx(), 'This is **bold** text');

      expect(mockSender.sendText).toHaveBeenCalledWith('user-1', 'This is bold text', 'ctx-tok');
    });

    it('removes # heading markers', async () => {
      const replier = new Replier(mockSender, { maxChunkSize: 3900, stripMarkdown: true });

      await replier.reply(makeCtx(), '# Title\n## Subtitle\nContent');

      const sent = mockSender.sendText.mock.calls[0][1] as string;
      expect(sent).not.toContain('#');
      expect(sent).toContain('Title');
      expect(sent).toContain('Subtitle');
      expect(sent).toContain('Content');
    });

    it('removes ``` code fences but keeps code content', async () => {
      const replier = new Replier(mockSender, { maxChunkSize: 3900, stripMarkdown: true });

      await replier.reply(makeCtx(), '```javascript\nconsole.log("hi")\n```');

      const sent = mockSender.sendText.mock.calls[0][1] as string;
      expect(sent).not.toContain('```');
      expect(sent).toContain('console.log("hi")');
    });

    it('does not strip markdown when stripMarkdown is false', async () => {
      const replier = new Replier(mockSender, { maxChunkSize: 3900, stripMarkdown: false });

      await replier.reply(makeCtx(), '**bold** and # heading');

      expect(mockSender.sendText).toHaveBeenCalledWith('user-1', '**bold** and # heading', 'ctx-tok');
    });
  });

  describe('replyMedia', () => {
    it('calls sender.sendMedia with correct arguments', async () => {
      const replier = new Replier(mockSender);

      await replier.replyMedia(makeCtx(), '/tmp/photo.png');

      expect(mockSender.sendMedia).toHaveBeenCalledTimes(1);
      expect(mockSender.sendMedia).toHaveBeenCalledWith('user-1', '/tmp/photo.png', 'ctx-tok');
    });
  });
});
