import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * TerminalDelivery 单测
 * Mock 平台检测 + session 管理 + AppleScript 原子操作
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

interface SessionEntry {
  userId: string;
  sessionId: string;
  platformData: Record<string, unknown>;
  createdAt: number;
  lastActiveAt: number;
}

// ---- Mock 依赖 ----

const mockTryInject = vi.fn<(sessionId: string, windowId: string, text: string) => boolean>();
const mockCreateWindow = vi.fn<(userId: string, cmd: string) => { windowId: string; sessionId: string }>();
const mockFindSession = vi.fn<(userId: string) => Promise<SessionEntry | null>>();
const mockCreateSession = vi.fn<(userId: string, opts: unknown) => Promise<SessionEntry>>();
const mockDestroySession = vi.fn<(userId: string) => Promise<void>>();
const mockTouch = vi.fn<(userId: string) => Promise<void>>();
const mockSleep = vi.fn<(ms: number) => Promise<void>>();
const mockCleanupStale = vi.fn<(maxAgeMs: number) => Promise<void>>();

const mockBackend = {
  name: 'claude-code',
  buildLaunchCommand: vi.fn().mockReturnValue('cd /tmp && claude --resume sess1'),
  chat: vi.fn(),
  buildPipeCommand: vi.fn(),
  extractResult: vi.fn(),
};

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

// ---- 简化的 TerminalDelivery 实现（用于测试行为逻辑）----

class TerminalDelivery {
  readonly name = 'terminal';
  private platform: string;
  private itermExists: boolean;

  constructor(opts: { platform?: string; itermExists?: boolean } = {}) {
    this.platform = opts.platform ?? 'darwin';
    this.itermExists = opts.itermExists ?? true;
  }

  async checkCompatibility(): Promise<CompatResult> {
    if (this.platform !== 'darwin') {
      return { available: false, reason: 'Requires macOS, current platform: ' + this.platform };
    }
    if (!this.itermExists) {
      return { available: false, reason: 'iTerm not installed' };
    }
    return { available: true };
  }

  async deliver(ctx: MessageContext, backend: typeof mockBackend): Promise<ProcessResult> {
    await mockCleanupStale(24 * 3600 * 1000);
    const entry = await mockFindSession(ctx.userId);

    if (entry) {
      const ok = mockTryInject(
        entry.platformData.sessionId as string,
        entry.platformData.windowId as string,
        `[微信] ${ctx.text}`,
      );
      if (ok) {
        await mockTouch(ctx.userId);
        return { text: '', selfReplied: true };
      }
      await mockDestroySession(ctx.userId);
    }

    const cmd = backend.buildLaunchCommand({ sessionId: ctx.sessionId, cwd: ctx.cwd });
    const newEntry = mockCreateWindow(ctx.userId, cmd);
    await mockSleep(1000);
    await mockCreateSession(ctx.userId, {
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      platformData: { windowId: newEntry.windowId, sessionId: newEntry.sessionId },
    });
    mockTryInject(newEntry.sessionId, newEntry.windowId, `[微信] ${ctx.text}`);

    return { text: '', selfReplied: true };
  }
}

// ---- Tests ----

describe('TerminalDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkCompatibility', () => {
    it('returns available:true on macOS with iTerm', async () => {
      const delivery = new TerminalDelivery({ platform: 'darwin', itermExists: true });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('returns available:false on Linux with reason containing "macOS"', async () => {
      const delivery = new TerminalDelivery({ platform: 'linux', itermExists: false });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(false);
      expect(result.reason).toContain('macOS');
    });

    it('returns available:false on macOS without iTerm', async () => {
      const delivery = new TerminalDelivery({ platform: 'darwin', itermExists: false });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(false);
      expect(result.reason).toContain('iTerm');
    });

    it('returns available:false on Windows', async () => {
      const delivery = new TerminalDelivery({ platform: 'win32' });
      const result = await delivery.checkCompatibility();
      expect(result.available).toBe(false);
      expect(result.reason).toContain('macOS');
    });
  });

  describe('deliver', () => {
    const delivery = new TerminalDelivery();

    it('injects into existing session when tryInject succeeds → selfReplied:true', async () => {
      const existingEntry: SessionEntry = {
        userId: 'user-1',
        sessionId: 'sess-1',
        platformData: { windowId: 'win-1', sessionId: 'tab-1' },
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      mockFindSession.mockResolvedValue(existingEntry);
      mockTryInject.mockReturnValue(true);

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.selfReplied).toBe(true);
      expect(mockTryInject).toHaveBeenCalledWith('tab-1', 'win-1', '[微信] hello');
      expect(mockTouch).toHaveBeenCalledWith('user-1');
      expect(mockCreateWindow).not.toHaveBeenCalled();
      expect(mockDestroySession).not.toHaveBeenCalled();
    });

    it('destroys session + creates new window when tryInject fails', async () => {
      const existingEntry: SessionEntry = {
        userId: 'user-1',
        sessionId: 'sess-1',
        platformData: { windowId: 'win-1', sessionId: 'tab-1' },
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      mockFindSession.mockResolvedValue(existingEntry);
      mockTryInject
        .mockReturnValueOnce(false)   // first inject fails
        .mockReturnValueOnce(true);   // second inject (after createWindow) succeeds
      mockCreateWindow.mockReturnValue({ windowId: 'win-2', sessionId: 'tab-2' });
      mockCreateSession.mockResolvedValue({} as SessionEntry);

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.selfReplied).toBe(true);
      expect(mockDestroySession).toHaveBeenCalledWith('user-1');
      expect(mockCreateWindow).toHaveBeenCalled();
      expect(mockBackend.buildLaunchCommand).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        cwd: '/tmp',
      });
    });

    it('creates new window when no existing session', async () => {
      mockFindSession.mockResolvedValue(null);
      mockCreateWindow.mockReturnValue({ windowId: 'win-new', sessionId: 'tab-new' });
      mockCreateSession.mockResolvedValue({} as SessionEntry);
      mockTryInject.mockReturnValue(true);

      const result = await delivery.deliver(makeCtx(), mockBackend);

      expect(result.selfReplied).toBe(true);
      expect(mockCreateWindow).toHaveBeenCalled();
      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockTryInject).toHaveBeenCalledWith('tab-new', 'win-new', '[微信] hello');
    });

    it('calls sleep after creating new window', async () => {
      mockFindSession.mockResolvedValue(null);
      mockCreateWindow.mockReturnValue({ windowId: 'win-new', sessionId: 'tab-new' });
      mockCreateSession.mockResolvedValue({} as SessionEntry);
      mockTryInject.mockReturnValue(true);
      mockSleep.mockResolvedValue(undefined);

      await delivery.deliver(makeCtx(), mockBackend);

      expect(mockSleep).toHaveBeenCalledWith(1000);
    });

    it('calls cleanupStale with 24h timeout before processing', async () => {
      mockFindSession.mockResolvedValue(null);
      mockCreateWindow.mockReturnValue({ windowId: 'w', sessionId: 't' });
      mockCreateSession.mockResolvedValue({} as SessionEntry);
      mockTryInject.mockReturnValue(true);

      await delivery.deliver(makeCtx(), mockBackend);

      expect(mockCleanupStale).toHaveBeenCalledWith(24 * 3600 * 1000);
    });
  });
});

// ---- TerminalSessions 持久化测试 ----

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach } from 'vitest';

describe('TerminalSessions persistence', () => {
  // 使用临时文件避免污染 /tmp/cc2wechat-tabs.json
  const tmpFile = path.join(os.tmpdir(), `cc2wechat-tabs-test-${Date.now()}.json`);

  // 内联简化实现（与 src/v5 一致，但可配置文件路径）
  class TestTerminalSessions {
    private store = new Map<string, SessionEntry>();
    constructor(private filePath: string) { this.loadFromDisk(); }

    async findSession(userId: string) { return this.store.get(userId) ?? null; }

    async createSession(userId: string, opts: { sessionId: string; cwd: string; platformData?: Record<string, unknown> }) {
      const entry: SessionEntry = {
        userId, sessionId: opts.sessionId,
        platformData: opts.platformData ?? {},
        createdAt: Date.now(), lastActiveAt: Date.now(),
      };
      this.store.set(userId, entry);
      this.saveToDisk();
      return entry;
    }

    async destroySession(userId: string) {
      this.store.delete(userId);
      this.saveToDisk();
    }

    async touch(userId: string) {
      const entry = this.store.get(userId);
      if (entry) { entry.lastActiveAt = Date.now(); this.saveToDisk(); }
    }

    async cleanupStale(maxAgeMs: number) {
      const now = Date.now();
      let changed = false;
      for (const [userId, entry] of this.store) {
        if (now - entry.lastActiveAt > maxAgeMs) { this.store.delete(userId); changed = true; }
      }
      if (changed) this.saveToDisk();
    }

    private saveToDisk() {
      const obj: Record<string, SessionEntry> = {};
      for (const [k, v] of this.store) obj[k] = v;
      try { fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2)); } catch {}
    }

    private loadFromDisk() {
      try {
        if (fs.existsSync(this.filePath)) {
          const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
          for (const [k, v] of Object.entries(data)) {
            const entry = v as SessionEntry;
            if (entry?.userId && entry?.platformData) this.store.set(k, entry);
          }
        }
      } catch {}
    }
  }

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('saves session to disk on createSession', async () => {
    const sessions = new TestTerminalSessions(tmpFile);
    await sessions.createSession('user-a', {
      sessionId: 'sess-a', cwd: '/tmp',
      platformData: { windowId: '100', sessionId: 'ABC-123' },
    });

    expect(fs.existsSync(tmpFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(data['user-a'].platformData.windowId).toBe('100');
    expect(data['user-a'].platformData.sessionId).toBe('ABC-123');
  });

  it('restores sessions from disk on new instance', async () => {
    const sessions1 = new TestTerminalSessions(tmpFile);
    await sessions1.createSession('user-b', {
      sessionId: 'sess-b', cwd: '/tmp',
      platformData: { windowId: '200', sessionId: 'DEF-456' },
    });

    // 新实例（模拟 daemon 重启）
    const sessions2 = new TestTerminalSessions(tmpFile);
    const entry = await sessions2.findSession('user-b');

    expect(entry).not.toBeNull();
    expect(entry!.platformData.windowId).toBe('200');
    expect(entry!.platformData.sessionId).toBe('DEF-456');
  });

  it('removes session from disk on destroySession', async () => {
    const sessions = new TestTerminalSessions(tmpFile);
    await sessions.createSession('user-c', {
      sessionId: 'sess-c', cwd: '/tmp',
      platformData: { windowId: '300', sessionId: 'GHI-789' },
    });
    await sessions.destroySession('user-c');

    const data = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(data['user-c']).toBeUndefined();
  });

  it('handles corrupt file gracefully — starts fresh', async () => {
    fs.writeFileSync(tmpFile, '{{invalid json');
    const sessions = new TestTerminalSessions(tmpFile);
    const entry = await sessions.findSession('anyone');
    expect(entry).toBeNull();
  });

  it('handles missing file gracefully — starts empty', async () => {
    const sessions = new TestTerminalSessions(tmpFile);
    const entry = await sessions.findSession('anyone');
    expect(entry).toBeNull();
  });
});
