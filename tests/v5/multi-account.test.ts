/**
 * Spec test for multi-account isolation.
 * All store/session/context logic is inline-mocked here to define the expected
 * behavior. Once the real modules are implemented, replace inline mocks with
 * imports from the production code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2wechat-multi-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Clean up any /tmp context files we created
  for (const f of fs.readdirSync('/tmp').filter(n => n.startsWith('cc2wechat-ctx-'))) {
    try { fs.unlinkSync(path.join('/tmp', f)); } catch { /* ok */ }
  }
});

/**
 * Hash helper matching the future multi-account context file naming convention:
 * /tmp/cc2wechat-ctx-{md5(userId).slice(0,8)}.json
 */
function contextPathForUser(userId: string): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
  return `/tmp/cc2wechat-ctx-${hash}.json`;
}

// ---------------------------------------------------------------------------
// 0. contextPathForUser edge cases
// ---------------------------------------------------------------------------

describe('contextPathForUser edge cases', () => {
  it('empty string userId does not crash and returns a valid path', () => {
    const p = contextPathForUser('');
    expect(p).toMatch(/^\/tmp\/cc2wechat-ctx-[0-9a-f]{8}\.json$/);
  });

  it('userId with special characters produces a valid hex-only filename', () => {
    for (const userId of ['user/with/slashes', 'user@#$%^&*()', '中文用户', '  ', '\n\t']) {
      const p = contextPathForUser(userId);
      expect(p).toMatch(/^\/tmp\/cc2wechat-ctx-[0-9a-f]{8}\.json$/);
    }
  });

  it('different special-char userIds produce different paths', () => {
    const paths = new Set(['a/b', 'a@b', '中文', 'émoji🎉'].map(contextPathForUser));
    expect(paths.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 1. Store 多账号（内联 mock store 逻辑）
// ---------------------------------------------------------------------------

describe('store multi-account', () => {
  /**
   * Inline mock of a port-aware account store.
   * The real store uses ~/.claude/channels/ — multi-account version
   * should use a data dir scoped by port.
   */
  interface AccountData {
    accountId: string;
    token: string;
    baseUrl?: string;
    savedAt: string;
    port?: number;
  }

  function dataDir(): string {
    return path.join(tmpDir, 'cc2wechat', 'data');
  }

  function accountsFileForPort(port: number): string {
    return path.join(dataDir(), `accounts-${port}.json`);
  }

  function saveAccount(account: AccountData & { port: number }): void {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = accountsFileForPort(account.port);
    let existing: AccountData[] = [];
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* first save */ }
    existing = existing.filter(a => a.accountId !== account.accountId);
    existing.push(account);
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  }

  function getActiveAccount(port: number): AccountData | null {
    try {
      const accounts: AccountData[] = JSON.parse(
        fs.readFileSync(accountsFileForPort(port), 'utf-8'),
      );
      return accounts.length > 0 ? accounts[accounts.length - 1]! : null;
    } catch {
      return null;
    }
  }

  it('saveAccount with port 18081 → stored in data dir', () => {
    saveAccount({
      accountId: 'wx-alice',
      token: 'tok-a',
      savedAt: '2026-03-24',
      port: 18081,
    });
    const filePath = accountsFileForPort(18081);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain('cc2wechat/data');
  });

  it('two accounts on different ports are independent', () => {
    saveAccount({ accountId: 'wx-alice', token: 'tok-a', savedAt: '2026-03-24', port: 18081 });
    saveAccount({ accountId: 'wx-bob', token: 'tok-b', savedAt: '2026-03-24', port: 18082 });

    const alice = getActiveAccount(18081);
    const bob = getActiveAccount(18082);
    expect(alice!.accountId).toBe('wx-alice');
    expect(bob!.accountId).toBe('wx-bob');
    expect(alice!.token).toBe('tok-a');
    expect(bob!.token).toBe('tok-b');
  });

  it('getActiveAccount(18081) returns the port-18081 account', () => {
    saveAccount({ accountId: 'wx-alice', token: 'tok-a', savedAt: '2026-03-24', port: 18081 });
    const account = getActiveAccount(18081);
    expect(account).not.toBeNull();
    expect(account!.accountId).toBe('wx-alice');
  });

  it('getActiveAccount(18082) returns the port-18082 account', () => {
    saveAccount({ accountId: 'wx-bob', token: 'tok-b', savedAt: '2026-03-24', port: 18082 });
    const account = getActiveAccount(18082);
    expect(account).not.toBeNull();
    expect(account!.accountId).toBe('wx-bob');
  });

  it('getActiveAccount for port with no account returns null', () => {
    const account = getActiveAccount(18081);
    expect(account).toBeNull();
  });

  it('same port: saving alice then bob → getActiveAccount returns bob', () => {
    saveAccount({ accountId: 'wx-alice', token: 'tok-a', savedAt: '2026-03-24', port: 18081 });
    saveAccount({ accountId: 'wx-bob', token: 'tok-b', savedAt: '2026-03-24', port: 18081 });

    const active = getActiveAccount(18081);
    expect(active).not.toBeNull();
    expect(active!.accountId).toBe('wx-bob');
    expect(active!.token).toBe('tok-b');
  });

  it('data directory path contains cc2wechat/data', () => {
    const dir = dataDir();
    expect(dir).toContain('cc2wechat/data');
    expect(dir).not.toContain('.claude/channels');
  });
});

// ---------------------------------------------------------------------------
// 2. Context 文件隔离
// ---------------------------------------------------------------------------

describe('context file isolation', () => {
  interface AccountData {
    token: string;
    baseUrl?: string;
  }

  /**
   * Future writeReplyContext: writes to a per-user file instead of
   * a single /tmp/cc2wechat-context.json.
   */
  function writeReplyContext(account: AccountData, userId: string, contextToken: string): string {
    const filePath = contextPathForUser(userId);
    fs.writeFileSync(filePath, JSON.stringify({
      token: account.token,
      baseUrl: account.baseUrl,
      userId,
      contextToken,
    }));
    return filePath;
  }

  function readReplyContext(envPath: string | undefined): Record<string, unknown> | null {
    const filePath = envPath ?? '/tmp/cc2wechat-context.json';
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  it('writeReplyContext writes to /tmp/cc2wechat-ctx-{hash}.json', () => {
    const account = { token: 'tok-a', baseUrl: 'https://api.example.com' };
    const filePath = writeReplyContext(account, 'user-a', 'ctx-a');
    expect(filePath).toBe(contextPathForUser('user-a'));
    expect(filePath).toMatch(/^\/tmp\/cc2wechat-ctx-[0-9a-f]{8}\.json$/);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('different users write to different files', () => {
    const account = { token: 'tok-a' };
    const pathA = writeReplyContext(account, 'user-a', 'ctx-a');
    const pathB = writeReplyContext(account, 'user-b', 'ctx-b');
    expect(pathA).not.toBe(pathB);

    // Verify each file has correct content
    const dataA = JSON.parse(fs.readFileSync(pathA, 'utf-8'));
    const dataB = JSON.parse(fs.readFileSync(pathB, 'utf-8'));
    expect(dataA.userId).toBe('user-a');
    expect(dataA.contextToken).toBe('ctx-a');
    expect(dataB.userId).toBe('user-b');
    expect(dataB.contextToken).toBe('ctx-b');
  });

  it('readReplyContext with env path reads the specified file', () => {
    const account = { token: 'tok-a' };
    const filePath = writeReplyContext(account, 'user-a', 'ctx-a');
    const ctx = readReplyContext(filePath);
    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe('user-a');
    expect(ctx!.contextToken).toBe('ctx-a');
    expect(ctx!.token).toBe('tok-a');
  });

  it('readReplyContext(undefined) falls back to /tmp/cc2wechat-context.json', () => {
    // Write a legacy context file
    fs.writeFileSync('/tmp/cc2wechat-context.json', JSON.stringify({
      token: 'legacy-tok',
      userId: 'legacy-user',
      contextToken: 'legacy-ctx',
    }));

    const ctx = readReplyContext(undefined);
    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe('legacy-user');

    // Cleanup
    try { fs.unlinkSync('/tmp/cc2wechat-context.json'); } catch { /* ok */ }
  });

  afterEach(() => {
    // Clean up context files created during tests
    for (const userId of ['user-a', 'user-b']) {
      try { fs.unlinkSync(contextPathForUser(userId)); } catch { /* ok */ }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. createWindow 环境变量注入
// ---------------------------------------------------------------------------

describe('createWindow env injection', () => {
  /**
   * Mock of the future createWindow that includes CC2WECHAT_CONTEXT env var.
   * We don't call real osascript — just verify the command string.
   */
  function buildCreateWindowCommand(userId: string, baseCmd: string): string {
    const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
    const contextPath = `/tmp/cc2wechat-ctx-${hash}.json`;
    return `CC2WECHAT_CONTEXT=${contextPath} ${baseCmd}`;
  }

  it('command includes CC2WECHAT_CONTEXT env var', () => {
    const cmd = buildCreateWindowCommand('user-a', 'claude --resume');
    expect(cmd).toContain('CC2WECHAT_CONTEXT=');
    expect(cmd).toContain('claude --resume');
  });

  it('env var value is /tmp/cc2wechat-ctx-{hash}.json format', () => {
    const cmd = buildCreateWindowCommand('user-a', 'claude');
    const match = cmd.match(/CC2WECHAT_CONTEXT=(\/tmp\/cc2wechat-ctx-[0-9a-f]{8}\.json)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(contextPathForUser('user-a'));
  });

  it('different users get different context paths in command', () => {
    const cmdA = buildCreateWindowCommand('user-a', 'claude');
    const cmdB = buildCreateWindowCommand('user-b', 'claude');

    const matchA = cmdA.match(/CC2WECHAT_CONTEXT=(\S+)/);
    const matchB = cmdB.match(/CC2WECHAT_CONTEXT=(\S+)/);
    expect(matchA![1]).not.toBe(matchB![1]);
  });
});

// ---------------------------------------------------------------------------
// 4. TerminalSessions 端口隔离
// ---------------------------------------------------------------------------

describe('terminal-sessions port isolation', () => {
  interface SessionEntry {
    userId: string;
    sessionId: string;
    platformData: Record<string, unknown>;
    createdAt: number;
    lastActiveAt: number;
  }

  /**
   * Inline mock of port-aware TerminalSessions.
   * The real one uses /tmp/cc2wechat-tabs.json — multi-account version
   * should scope by port.
   */
  class MockTerminalSessions {
    private store = new Map<string, SessionEntry>();
    readonly filePath: string;

    constructor(private port: number) {
      this.filePath = `/tmp/cc2wechat-tabs-${port}.json`;
      this.loadFromDisk();
    }

    async createSession(userId: string, sessionId: string): Promise<SessionEntry> {
      const entry: SessionEntry = {
        userId,
        sessionId,
        platformData: {},
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      this.store.set(userId, entry);
      this.saveToDisk();
      return entry;
    }

    async findSession(userId: string): Promise<SessionEntry | null> {
      return this.store.get(userId) ?? null;
    }

    private saveToDisk(): void {
      const obj: Record<string, SessionEntry> = {};
      for (const [key, entry] of this.store) obj[key] = entry;
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
      } catch { /* best-effort */ }
    }

    private loadFromDisk(): void {
      try {
        if (fs.existsSync(this.filePath)) {
          const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
          for (const [key, val] of Object.entries(data)) {
            this.store.set(key, val as SessionEntry);
          }
        }
      } catch { /* start fresh */ }
    }
  }

  afterEach(() => {
    // Clean up tabs files
    for (const port of [18081, 18082]) {
      try { fs.unlinkSync(`/tmp/cc2wechat-tabs-${port}.json`); } catch { /* ok */ }
    }
  });

  it('TerminalSessions(18081) file path contains 18081', () => {
    const sessions = new MockTerminalSessions(18081);
    expect(sessions.filePath).toContain('18081');
  });

  it('TerminalSessions(18082) file path contains 18082', () => {
    const sessions = new MockTerminalSessions(18082);
    expect(sessions.filePath).toContain('18082');
  });

  it('two instances on different ports write to separate files', async () => {
    const s1 = new MockTerminalSessions(18081);
    const s2 = new MockTerminalSessions(18082);

    await s1.createSession('user-a', 'session-a');
    await s2.createSession('user-b', 'session-b');

    // Verify files are separate
    expect(fs.existsSync(s1.filePath)).toBe(true);
    expect(fs.existsSync(s2.filePath)).toBe(true);
    expect(s1.filePath).not.toBe(s2.filePath);

    // Verify data isolation — s1 only has user-a, s2 only has user-b
    const data1 = JSON.parse(fs.readFileSync(s1.filePath, 'utf-8'));
    const data2 = JSON.parse(fs.readFileSync(s2.filePath, 'utf-8'));
    expect(data1['user-a']).toBeDefined();
    expect(data1['user-b']).toBeUndefined();
    expect(data2['user-b']).toBeDefined();
    expect(data2['user-a']).toBeUndefined();
  });

  it('sessions on same port do not leak to other port', async () => {
    const s1 = new MockTerminalSessions(18081);
    const s2 = new MockTerminalSessions(18082);

    await s1.createSession('user-x', 'session-x');

    const foundInS1 = await s1.findSession('user-x');
    const foundInS2 = await s2.findSession('user-x');
    expect(foundInS1).not.toBeNull();
    expect(foundInS1!.sessionId).toBe('session-x');
    expect(foundInS2).toBeNull();
  });
});
