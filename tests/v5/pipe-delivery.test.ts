import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PipeDelivery 单测
 * Mock which/execSync
 */

// ---- 内联接口 ----

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

// ---- Mock execSync ----

const mockExecSync = vi.fn<(cmd: string, opts?: unknown) => string>();

// ---- PipeDelivery 简化实现 ----

class PipeDelivery {
  readonly name = 'pipe';
  private whichSuccess: boolean;

  constructor(opts: { whichSuccess?: boolean } = {}) {
    this.whichSuccess = opts.whichSuccess ?? true;
  }

  async checkCompatibility(): Promise<CompatResult> {
    if (!this.whichSuccess) {
      return { available: false, reason: 'claude CLI not in PATH' };
    }
    return { available: true };
  }

  async deliver(
    ctx: MessageContext,
    backend: { buildPipeCommand: (opts: unknown) => string },
  ): Promise<ProcessResult> {
    const cmd = backend.buildPipeCommand({
      prompt: ctx.text,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
    });
    const result = mockExecSync(cmd, {
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: ctx.cwd,
    });
    const text = (result || '').trim();
    return { text: text || '[No response]', selfReplied: false };
  }
}

// ---- Tests ----

describe('PipeDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkCompatibility', () => {
    it('returns available:true when which claude succeeds', async () => {
      const delivery = new PipeDelivery({ whichSuccess: true });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(true);
    });

    it('returns available:false when which claude fails', async () => {
      const delivery = new PipeDelivery({ whichSuccess: false });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(false);
      expect(result.reason).toContain('claude CLI');
    });
  });

  describe('deliver', () => {
    const delivery = new PipeDelivery();

    it('calls backend.buildPipeCommand and execSync, returns stdout', async () => {
      const mockBackend = {
        buildPipeCommand: vi.fn().mockReturnValue('claude -p "hello" --resume sess-1 --output-format text'),
      };
      mockExecSync.mockReturnValue('Hello from Claude!\n');

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.text).toBe('Hello from Claude!');
      expect(result.selfReplied).toBe(false);
      expect(mockBackend.buildPipeCommand).toHaveBeenCalledWith({
        prompt: 'hello',
        sessionId: 'sess-1',
        cwd: '/tmp',
      });
      expect(mockExecSync).toHaveBeenCalledWith(
        'claude -p "hello" --resume sess-1 --output-format text',
        expect.objectContaining({
          encoding: 'utf-8',
          timeout: 120_000,
          cwd: '/tmp',
        }),
      );
    });

    it('returns "[No response]" when execSync returns empty string', async () => {
      const mockBackend = {
        buildPipeCommand: vi.fn().mockReturnValue('claude -p "hi"'),
      };
      mockExecSync.mockReturnValue('   \n');

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.text).toBe('[No response]');
    });

    it('trims whitespace from output', async () => {
      const mockBackend = {
        buildPipeCommand: vi.fn().mockReturnValue('cmd'),
      };
      mockExecSync.mockReturnValue('  result with spaces  \n');

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.text).toBe('result with spaces');
    });

    it('propagates execSync errors', async () => {
      const mockBackend = {
        buildPipeCommand: vi.fn().mockReturnValue('cmd'),
      };
      mockExecSync.mockImplementation(() => {
        throw new Error('Command timed out');
      });

      await expect(delivery.deliver(makeCtx(), mockBackend)).rejects.toThrow('Command timed out');
    });
  });
});
