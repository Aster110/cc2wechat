import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We need to mock the CHANNEL_DIR to use a temp directory
// Since CHANNEL_DIR is a module-level const, we mock os.homedir before importing
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2wechat-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Since store.ts computes CHANNEL_DIR at module load time using os.homedir(),
// we need to re-import with a mocked homedir each time.
async function importStore(homeDir: string) {
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, default: { ...actual, homedir: () => homeDir }, homedir: () => homeDir };
  });
  // Force fresh import
  const mod = await import('../src/store.js');
  return mod;
}

describe('store', () => {
  let store: Awaited<ReturnType<typeof importStore>>;

  beforeEach(async () => {
    vi.resetModules();
    store = await importStore(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveAccount / getActiveAccount / loadAccounts', () => {
    it('returns null when no accounts saved', () => {
      expect(store.getActiveAccount()).toBeNull();
    });

    it('saves and retrieves an account', () => {
      const account = {
        accountId: 'acc1',
        token: 'tok_abc',
        baseUrl: 'https://example.com',
        savedAt: '2026-01-01T00:00:00Z',
      };
      store.saveAccount(account);
      const active = store.getActiveAccount();
      expect(active).not.toBeNull();
      expect(active!.accountId).toBe('acc1');
      expect(active!.token).toBe('tok_abc');
      expect(active!.baseUrl).toBe('https://example.com');
    });

    it('returns the last saved account as active', () => {
      store.saveAccount({ accountId: 'a1', token: 't1', savedAt: '2026-01-01' });
      store.saveAccount({ accountId: 'a2', token: 't2', savedAt: '2026-01-02' });
      const active = store.getActiveAccount();
      expect(active!.accountId).toBe('a2');
    });

    it('deduplicates by accountId on save', () => {
      store.saveAccount({ accountId: 'a1', token: 'old', savedAt: '2026-01-01' });
      store.saveAccount({ accountId: 'a1', token: 'new', savedAt: '2026-01-02' });
      const accounts = store.loadAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.token).toBe('new');
    });
  });

  describe('loadSyncBuf / saveSyncBuf', () => {
    it('returns empty string when no buf saved', () => {
      expect(store.loadSyncBuf('nonexistent')).toBe('');
    });

    it('saves and loads sync buf consistently', () => {
      store.saveSyncBuf('acc1', 'some_cursor_data_12345');
      expect(store.loadSyncBuf('acc1')).toBe('some_cursor_data_12345');
    });

    it('overwrites previous buf', () => {
      store.saveSyncBuf('acc1', 'first');
      store.saveSyncBuf('acc1', 'second');
      expect(store.loadSyncBuf('acc1')).toBe('second');
    });
  });
});
