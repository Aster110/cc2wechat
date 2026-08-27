import { describe, it, expect } from 'vitest';

/**
 * 接口类型编译验证 — 确保所有 v5 接口类型定义正确、可组合。
 * 这些测试不测运行时行为，只验证 TypeScript 类型系统层面的正确性。
 */

// ---- 内联接口定义（实现文件尚未创建）----

interface LaunchOpts {
  sessionId: string;
  cwd: string;
}

interface ChatOpts {
  message: string;
  sessionId: string;
  cwd: string;
}

interface PipeOpts {
  prompt: string;
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
}

interface BackendEvent {
  type: string;
  [key: string]: unknown;
}

interface AIBackend {
  readonly name: string;
  buildLaunchCommand(opts: LaunchOpts): string;
  chat(opts: ChatOpts): AsyncIterable<BackendEvent>;
  buildPipeCommand(opts: PipeOpts): string;
  extractResult(events: BackendEvent[]): string;
}

interface CompatResult {
  available: boolean;
  reason?: string;
  missingDeps?: string[];
}

interface DeliveryConfig {
  [key: string]: unknown;
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

interface ProcessResult {
  text: string;
  mediaFiles?: string[];
  selfReplied?: boolean;
}

interface Delivery {
  readonly name: string;
  checkCompatibility(): Promise<CompatResult>;
  initialize(config: DeliveryConfig): Promise<void>;
  deliver(ctx: MessageContext, backend: AIBackend): Promise<ProcessResult>;
  shutdown(): Promise<void>;
}

interface SessionEntry {
  userId: string;
  sessionId: string;
  platformData: Record<string, unknown>;
  createdAt: number;
  lastActiveAt: number;
}

interface SessionOpts {
  sessionId: string;
  cwd: string;
  platformData?: Record<string, unknown>;
}

interface SessionManager {
  findSession(userId: string): Promise<SessionEntry | null>;
  createSession(userId: string, opts: SessionOpts): Promise<SessionEntry>;
  destroySession(userId: string): Promise<void>;
  cleanupStale(maxAgeMs: number): Promise<void>;
}

interface MessageSender {
  sendText(to: string, text: string, contextToken: string): Promise<void>;
  sendMedia(to: string, filePath: string, contextToken: string): Promise<void>;
}

interface MessageReceiver {
  readonly name: string;
  start(handler: (msg: unknown, account: unknown) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

// ---- 类型编译验证测试 ----

describe('v5 interfaces — type compilation', () => {
  it('AIBackend can be implemented as a plain object', () => {
    const backend: AIBackend = {
      name: 'test-backend',
      buildLaunchCommand(opts: LaunchOpts) {
        return `cd ${opts.cwd} && test --resume ${opts.sessionId}`;
      },
      async *chat(_opts: ChatOpts): AsyncIterable<BackendEvent> {
        yield { type: 'result', result: 'ok' };
      },
      buildPipeCommand(opts: PipeOpts) {
        return `test -p ${JSON.stringify(opts.prompt)}`;
      },
      extractResult(events: BackendEvent[]) {
        return events.map(e => e.type).join(',');
      },
    };

    expect(backend.name).toBe('test-backend');
    expect(backend.buildLaunchCommand({ sessionId: 's1', cwd: '/tmp' })).toContain('/tmp');
    expect(backend.buildPipeCommand({ prompt: 'hi', sessionId: 's1', cwd: '/tmp' })).toContain('hi');
    expect(backend.extractResult([{ type: 'result' }])).toBe('result');
  });

  it('Delivery can be implemented as a plain object', async () => {
    const delivery: Delivery = {
      name: 'test-delivery',
      async checkCompatibility() {
        return { available: true };
      },
      async initialize(_config: DeliveryConfig) {},
      async deliver(_ctx: MessageContext, _backend: AIBackend) {
        return { text: 'reply', selfReplied: false };
      },
      async shutdown() {},
    };

    expect(delivery.name).toBe('test-delivery');
    const compat = await delivery.checkCompatibility();
    expect(compat.available).toBe(true);
  });

  it('CompatResult with reason and missingDeps', () => {
    const result: CompatResult = {
      available: false,
      reason: 'Not macOS',
      missingDeps: ['iTerm'],
    };
    expect(result.available).toBe(false);
    expect(result.reason).toBe('Not macOS');
    expect(result.missingDeps).toEqual(['iTerm']);
  });

  it('ProcessResult supports optional fields', () => {
    const minimal: ProcessResult = { text: 'hello' };
    expect(minimal.selfReplied).toBeUndefined();
    expect(minimal.mediaFiles).toBeUndefined();

    const full: ProcessResult = {
      text: 'hello',
      selfReplied: true,
      mediaFiles: ['/tmp/a.png'],
    };
    expect(full.selfReplied).toBe(true);
    expect(full.mediaFiles).toEqual(['/tmp/a.png']);
  });

  it('SessionManager can be implemented', async () => {
    const store = new Map<string, SessionEntry>();
    const manager: SessionManager = {
      async findSession(userId) {
        return store.get(userId) ?? null;
      },
      async createSession(userId, opts) {
        const entry: SessionEntry = {
          userId,
          sessionId: opts.sessionId,
          platformData: opts.platformData ?? {},
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        };
        store.set(userId, entry);
        return entry;
      },
      async destroySession(userId) {
        store.delete(userId);
      },
      async cleanupStale(_maxAgeMs) {
        // no-op for test
      },
    };

    expect(await manager.findSession('u1')).toBeNull();
    const entry = await manager.createSession('u1', { sessionId: 's1', cwd: '/tmp' });
    expect(entry.userId).toBe('u1');
    expect(entry.sessionId).toBe('s1');
    const found = await manager.findSession('u1');
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe('s1');
  });

  it('MessageSender interface shape', () => {
    const sender: MessageSender = {
      async sendText(_to, _text, _ctx) {},
      async sendMedia(_to, _file, _ctx) {},
    };
    expect(typeof sender.sendText).toBe('function');
    expect(typeof sender.sendMedia).toBe('function');
  });

  it('MessageReceiver interface shape', async () => {
    const receiver: MessageReceiver = {
      name: 'test-receiver',
      async start(_handler) {},
      async stop() {},
    };
    expect(receiver.name).toBe('test-receiver');
  });

  it('BackendEvent allows arbitrary extra fields', () => {
    const event: BackendEvent = {
      type: 'assistant',
      message: { content: 'hello' },
      metadata: { tokens: 100 },
    };
    expect(event.type).toBe('assistant');
    expect(event.message).toEqual({ content: 'hello' });
  });

  it('MessageContext contains all required fields', () => {
    const ctx: MessageContext = {
      text: 'hello',
      mediaFiles: ['/tmp/img.png'],
      userId: 'user-1',
      sessionId: 'sess-1',
      contextToken: 'ctx-tok',
      rawMessage: {},
      account: {},
      cwd: '/home/user',
    };
    expect(ctx.text).toBe('hello');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.cwd).toBe('/home/user');
  });

  it('Delivery.deliver receives backend — Delivery × Backend composable', async () => {
    const backend: AIBackend = {
      name: 'mock-backend',
      buildLaunchCommand: () => 'cmd',
      async *chat() { yield { type: 'result', result: 'ok' }; },
      buildPipeCommand: () => 'pipe-cmd',
      extractResult: () => 'extracted',
    };

    const delivery: Delivery = {
      name: 'mock-delivery',
      async checkCompatibility() { return { available: true }; },
      async initialize() {},
      async deliver(_ctx, b) {
        // Delivery uses backend — this is the N+M composability
        const cmd = b.buildLaunchCommand({ sessionId: 's', cwd: '/tmp' });
        return { text: cmd, selfReplied: false };
      },
      async shutdown() {},
    };

    const ctx: MessageContext = {
      text: 'hi', mediaFiles: [], userId: 'u', sessionId: 's',
      contextToken: 'c', rawMessage: {}, account: {}, cwd: '/tmp',
    };

    const result = await delivery.deliver(ctx, backend);
    expect(result.text).toBe('cmd');
    expect(result.selfReplied).toBe(false);
  });
});
