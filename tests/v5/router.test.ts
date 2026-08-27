import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Router 流程测试
 * 验证 delivery.deliver → replier.reply 的编排逻辑
 */

// ---- 内联接口 ----

interface ProcessResult {
  text: string;
  mediaFiles?: string[];
  selfReplied?: boolean;
}

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

// ---- 简化 Router 实现（核心编排逻辑）----

class Router {
  constructor(
    private delivery: { deliver: (ctx: MessageContext, backend: unknown) => Promise<ProcessResult> },
    private backend: unknown,
    private replier: { reply: (ctx: MessageContext, text: string) => Promise<void>; replyMedia: (ctx: MessageContext, filePath: string) => Promise<void> },
  ) {}

  async handle(ctx: MessageContext): Promise<void> {
    try {
      const result = await this.delivery.deliver(ctx, this.backend);

      if (!result.selfReplied && result.text) {
        await this.replier.reply(ctx, result.text);
      }
      if (result.mediaFiles?.length) {
        for (const file of result.mediaFiles) {
          await this.replier.replyMedia(ctx, file);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.replier.reply(ctx, `[Error] ${message}`);
    }
  }
}

// ---- Helpers ----

function makeCtx(overrides?: Partial<MessageContext>): MessageContext {
  return {
    text: 'hello',
    mediaFiles: [],
    userId: 'user-1',
    sessionId: 'sess-1',
    contextToken: 'ctx',
    rawMessage: {},
    account: {},
    cwd: '/tmp',
    ...overrides,
  };
}

// ---- Tests ----

describe('Router', () => {
  let mockDelivery: { deliver: ReturnType<typeof vi.fn> };
  let mockBackend: Record<string, unknown>;
  let mockReplier: { reply: ReturnType<typeof vi.fn>; replyMedia: ReturnType<typeof vi.fn> };
  let router: Router;

  beforeEach(() => {
    mockDelivery = { deliver: vi.fn() };
    mockBackend = { name: 'claude-code' };
    mockReplier = {
      reply: vi.fn().mockResolvedValue(undefined),
      replyMedia: vi.fn().mockResolvedValue(undefined),
    };
    router = new Router(mockDelivery, mockBackend, mockReplier);
  });

  it('calls replier.reply when delivery returns text and selfReplied:false', async () => {
    mockDelivery.deliver.mockResolvedValue({
      text: 'hi',
      selfReplied: false,
    });

    const ctx = makeCtx();
    await router.handle(ctx);

    expect(mockReplier.reply).toHaveBeenCalledTimes(1);
    expect(mockReplier.reply).toHaveBeenCalledWith(ctx, 'hi');
  });

  it('does NOT call replier.reply when selfReplied:true', async () => {
    mockDelivery.deliver.mockResolvedValue({
      text: '',
      selfReplied: true,
    });

    await router.handle(makeCtx());

    expect(mockReplier.reply).not.toHaveBeenCalled();
  });

  it('does NOT call replier.reply when text is empty and selfReplied:false', async () => {
    mockDelivery.deliver.mockResolvedValue({
      text: '',
      selfReplied: false,
    });

    await router.handle(makeCtx());

    expect(mockReplier.reply).not.toHaveBeenCalled();
  });

  it('calls replier.replyMedia for each media file', async () => {
    mockDelivery.deliver.mockResolvedValue({
      text: 'check these files',
      selfReplied: false,
      mediaFiles: ['/tmp/a.png', '/tmp/b.jpg'],
    });

    const ctx = makeCtx();
    await router.handle(ctx);

    expect(mockReplier.reply).toHaveBeenCalledWith(ctx, 'check these files');
    expect(mockReplier.replyMedia).toHaveBeenCalledTimes(2);
    expect(mockReplier.replyMedia).toHaveBeenCalledWith(ctx, '/tmp/a.png');
    expect(mockReplier.replyMedia).toHaveBeenCalledWith(ctx, '/tmp/b.jpg');
  });

  it('does NOT call replier.replyMedia when mediaFiles is empty', async () => {
    mockDelivery.deliver.mockResolvedValue({
      text: 'no files',
      selfReplied: false,
      mediaFiles: [],
    });

    await router.handle(makeCtx());

    expect(mockReplier.replyMedia).not.toHaveBeenCalled();
  });

  it('does NOT call replier.replyMedia when mediaFiles is undefined', async () => {
    mockDelivery.deliver.mockResolvedValue({
      text: 'no files',
      selfReplied: false,
    });

    await router.handle(makeCtx());

    expect(mockReplier.replyMedia).not.toHaveBeenCalled();
  });

  it('calls replyMedia even when selfReplied:true', async () => {
    mockDelivery.deliver.mockResolvedValue({
      text: '',
      selfReplied: true,
      mediaFiles: ['/tmp/a.png'],
    });

    const ctx = makeCtx();
    await router.handle(ctx);

    expect(mockReplier.reply).not.toHaveBeenCalled();
    expect(mockReplier.replyMedia).toHaveBeenCalledWith(ctx, '/tmp/a.png');
  });

  it('catches delivery error and replies error message', async () => {
    mockDelivery.deliver.mockRejectedValue(new Error('connection timeout'));

    const ctx = makeCtx();
    await router.handle(ctx);

    expect(mockReplier.reply).toHaveBeenCalledWith(ctx, '[Error] connection timeout');
    expect(mockReplier.replyMedia).not.toHaveBeenCalled();
  });

  it('passes backend to delivery.deliver', async () => {
    mockDelivery.deliver.mockResolvedValue({ text: 'ok', selfReplied: false });

    const ctx = makeCtx();
    await router.handle(ctx);

    expect(mockDelivery.deliver).toHaveBeenCalledWith(ctx, mockBackend);
  });
});
