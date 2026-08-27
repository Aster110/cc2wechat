import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

// Import tmux-cli functions
import { hasTmux, isTmuxSessionAlive, createTmuxSession, sendToSession, killTmuxSession } from '../src/v5/deliveries/tmux/tmux-cli.js';
import { TmuxSessions } from '../src/v5/deliveries/tmux/tmux-sessions.js';
import { TmuxDelivery } from '../src/v5/deliveries/tmux/tmux-delivery.js';

const TEST_SESSION_PREFIX = 'cc2w-test-';

function cleanupTestSessions(): void {
  try {
    const list = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    for (const name of list.trim().split('\n')) {
      if (name.startsWith(TEST_SESSION_PREFIX)) {
        try { execSync(`tmux kill-session -t ${name}`); } catch { /* ok */ }
      }
    }
  } catch { /* no sessions */ }
}

describe('tmux-cli', () => {
  afterEach(() => {
    cleanupTestSessions();
  });

  it('hasTmux() returns true when tmux is installed', () => {
    expect(hasTmux()).toBe(true);
  });

  it('isTmuxSessionAlive() returns false for non-existent session', () => {
    expect(isTmuxSessionAlive('cc2w-test-nonexistent')).toBe(false);
  });

  it('createTmuxSession() creates a session that is alive', () => {
    const name = `${TEST_SESSION_PREFIX}create`;
    createTmuxSession(name, '/tmp', 'bash');
    expect(isTmuxSessionAlive(name)).toBe(true);
  });

  it('killTmuxSession() kills a session', () => {
    const name = `${TEST_SESSION_PREFIX}kill`;
    createTmuxSession(name, '/tmp', 'bash');
    expect(isTmuxSessionAlive(name)).toBe(true);
    killTmuxSession(name);
    expect(isTmuxSessionAlive(name)).toBe(false);
  });

  it('sendToSession() injects text into a session', () => {
    const name = `${TEST_SESSION_PREFIX}inject`;
    createTmuxSession(name, '/tmp', 'bash');
    const ok = sendToSession(name, 'echo hello-from-test');
    expect(ok).toBe(true);
  });

  it('sendToSession() returns false for non-existent session', () => {
    const ok = sendToSession(`${TEST_SESSION_PREFIX}ghost`, 'echo nope');
    expect(ok).toBe(false);
  });

  it('handles special characters in text (quotes, backslashes, newlines)', () => {
    const name = `${TEST_SESSION_PREFIX}escape`;
    createTmuxSession(name, '/tmp', 'bash');
    // This text contains all the tricky characters
    const tricky = `echo "hello 'world'" && echo 'back\\slash' && echo $HOME`;
    const ok = sendToSession(name, tricky);
    expect(ok).toBe(true);
  });

  it('createTmuxSession() replaces existing session with same name', () => {
    const name = `${TEST_SESSION_PREFIX}replace`;
    createTmuxSession(name, '/tmp', 'bash');
    expect(isTmuxSessionAlive(name)).toBe(true);
    // Creating again should not throw
    createTmuxSession(name, '/tmp', 'bash');
    expect(isTmuxSessionAlive(name)).toBe(true);
  });
});

describe('TmuxSessions', () => {
  const testFile = '/tmp/cc2wechat-tmux-test-sessions.json';

  afterEach(() => {
    try { fs.unlinkSync(testFile); } catch { /* ok */ }
  });

  it('creates and finds sessions', async () => {
    const sessions = new TmuxSessions(99999);
    // Override file path for test
    (sessions as any).filePath = testFile;

    const entry = await sessions.createSession('user-a', {
      sessionId: 'sid-a',
      cwd: '/tmp',
      platformData: { sessionName: 'cc2w-testa' },
    });
    expect(entry.userId).toBe('user-a');
    expect(entry.platformData.sessionName).toBe('cc2w-testa');

    const found = await sessions.findSession('user-a');
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe('sid-a');
  });

  it('destroys sessions', async () => {
    const sessions = new TmuxSessions(99999);
    (sessions as any).filePath = testFile;

    await sessions.createSession('user-b', { sessionId: 'sid-b', cwd: '/tmp' });
    await sessions.destroySession('user-b');
    const found = await sessions.findSession('user-b');
    expect(found).toBeNull();
  });

  it('concurrent users have independent sessions', async () => {
    const sessions = new TmuxSessions(99999);
    (sessions as any).filePath = testFile;

    await sessions.createSession('user-1', {
      sessionId: 'sid-1',
      cwd: '/tmp',
      platformData: { sessionName: 'cc2w-u1' },
    });
    await sessions.createSession('user-2', {
      sessionId: 'sid-2',
      cwd: '/tmp',
      platformData: { sessionName: 'cc2w-u2' },
    });

    const s1 = await sessions.findSession('user-1');
    const s2 = await sessions.findSession('user-2');
    expect(s1!.platformData.sessionName).toBe('cc2w-u1');
    expect(s2!.platformData.sessionName).toBe('cc2w-u2');
  });

  it('cleanupStale removes old sessions', async () => {
    const sessions = new TmuxSessions(99999);
    (sessions as any).filePath = testFile;

    const entry = await sessions.createSession('user-old', { sessionId: 'sid-old', cwd: '/tmp' });
    // Manually set lastActiveAt to the past
    entry.lastActiveAt = Date.now() - 100_000;
    (sessions as any).store.set('user-old', entry);

    await sessions.cleanupStale(50_000);
    const found = await sessions.findSession('user-old');
    expect(found).toBeNull();
  });
});

describe('TmuxDelivery', () => {
  it('checkCompatibility() returns available=true when tmux is installed', async () => {
    const delivery = new TmuxDelivery();
    const result = await delivery.checkCompatibility();
    expect(result.available).toBe(true);
  });
});
