import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SDKDelivery 单测
 * Mock backend.chat + extractResult
 */

// ---- 内联接口 ----

interface BackendEvent {
  type: string;
  [key: string]: unknown;
}

interface CompatResult {
  available: boolean;
  reason?: string;
  missingDeps?: string[];
}

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

// ---- SDKDelivery 简化实现 ----

class SDKDelivery {
  readonly name = 'sdk';
  private importSuccess: boolean;

  constructor(opts: { importSuccess?: boolean } = {}) {
    this.importSuccess = opts.importSuccess ?? true;
  }

  async checkCompatibility(): Promise<CompatResult> {
    if (!this.importSuccess) {
      return { available: false, reason: 'cc-core not installed', missingDeps: ['@aster110/cc-core'] };
    }
    return { available: true };
  }

  async deliver(
    ctx: MessageContext,
    backend: { chat: (opts: unknown) => AsyncIterable<BackendEvent>; extractResult: (events: BackendEvent[]) => string },
  ): Promise<ProcessResult> {
    const events: BackendEvent[] = [];
    for await (const event of backend.chat({
      message: `[微信] ${ctx.text}`,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
    })) {
      events.push(event);
    }
    const text = backend.extractResult(events);
    return { text: text || '[No response]', selfReplied: false };
  }
}

// ---- Tests ----

describe('SDKDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkCompatibility', () => {
    it('returns available:true when import succeeds', async () => {
      const delivery = new SDKDelivery({ importSuccess: true });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(true);
    });

    it('returns available:false when import fails', async () => {
      const delivery = new SDKDelivery({ importSuccess: false });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(false);
      expect(result.reason).toContain('cc-core');
      expect(result.missingDeps).toEqual(['@aster110/cc-core']);
    });
  });

  describe('deliver', () => {
    const delivery = new SDKDelivery();

    it('collects events from backend.chat and returns extracted text', async () => {
      const mockBackend = {
        chat: vi.fn().mockImplementation(async function* () {
          yield { type: 'assistant', message: { content: 'thinking...' } };
          yield { type: 'result', result: 'Hello!' };
        }),
        extractResult: vi.fn().mockReturnValue('Hello!'),
      };

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.text).toBe('Hello!');
      expect(result.selfReplied).toBe(false);
      expect(mockBackend.chat).toHaveBeenCalledWith({
        message: '[微信] hello',
        sessionId: 'sess-1',
        cwd: '/tmp',
      });
      expect(mockBackend.extractResult).toHaveBeenCalledWith([
        { type: 'assistant', message: { content: 'thinking...' } },
        { type: 'result', result: 'Hello!' },
      ]);
    });

    it('returns "[No response]" when extractResult returns empty string', async () => {
      const mockBackend = {
        chat: vi.fn().mockImplementation(async function* () {
          yield { type: 'system', text: 'init' };
        }),
        extractResult: vi.fn().mockReturnValue(''),
      };

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.text).toBe('[No response]');
      expect(result.selfReplied).toBe(false);
    });

    it('handles backend.chat throwing error', async () => {
      const mockBackend = {
        chat: vi.fn().mockImplementation(async function* () {
          throw new Error('SDK connection failed');
        }),
        extractResult: vi.fn(),
      };

      await expect(delivery.deliver(makeCtx(), mockBackend)).rejects.toThrow('SDK connection failed');
    });

    it('passes correct message with [微信] prefix', async () => {
      const mockBackend = {
        chat: vi.fn().mockImplementation(async function* () {
          yield { type: 'result', result: 'ok' };
        }),
        extractResult: vi.fn().mockReturnValue('ok'),
      };

      await delivery.deliver(makeCtx({ text: 'what is 1+1?' }), mockBackend);

      expect(mockBackend.chat).toHaveBeenCalledWith(
        expect.objectContaining({ message: '[微信] what is 1+1?' }),
      );
    });

    it('collects all events in a 10+ event stream and passes them to extractResult', async () => {
      const events: { type: string; index: number }[] = [];
      for (let i = 0; i < 15; i++) {
        events.push({ type: i < 14 ? 'assistant' : 'result', index: i });
      }

      const mockBackend = {
        chat: vi.fn().mockImplementation(async function* () {
          for (const event of events) {
            yield event;
          }
        }),
        extractResult: vi.fn().mockReturnValue('final answer'),
      };

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.text).toBe('final answer');
      expect(mockBackend.extractResult).toHaveBeenCalledTimes(1);
      const collected = mockBackend.extractResult.mock.calls[0][0];
      expect(collected).toHaveLength(15);
      expect(collected[0]).toEqual({ type: 'assistant', index: 0 });
      expect(collected[14]).toEqual({ type: 'result', index: 14 });
    });
  });
});
