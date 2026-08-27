import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodexBackend } from '../../src/v5/backends/codex.js';
import type { BackendEvent } from '../../src/v5/interfaces/index.js';

const TEST_PORT = '19999';
let tmpHome: string;
let savedHome: string | undefined;
let savedPort: string | undefined;
let savedCodexHome: string | undefined;

function seedThreadMap(map: Record<string, string>): void {
  const dir = path.join(tmpHome, '.cc2wechat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `codex-threads-${TEST_PORT}.json`), JSON.stringify(map));
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedPort = process.env.CC2WECHAT_PORT;
  savedCodexHome = process.env.CODEX_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backend-test-'));
  process.env.HOME = tmpHome;
  process.env.CC2WECHAT_PORT = TEST_PORT;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedPort == null) delete process.env.CC2WECHAT_PORT;
  else process.env.CC2WECHAT_PORT = savedPort;
  if (savedCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('CodexBackend.extractResult', () => {
  const backend = new CodexBackend();

  it('picks the last agent_message text', () => {
    const events: BackendEvent[] = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { type: 'command_execution', text: 'ls' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
      { type: 'turn.completed' },
    ];
    expect(backend.extractResult(events)).toBe('final answer');
  });

  it('falls back to turn.failed error message', () => {
    const events: BackendEvent[] = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'error', message: 'usage limit hit' },
      { type: 'turn.failed', error: { message: 'usage limit hit' } },
    ];
    expect(backend.extractResult(events)).toBe('[codex] usage limit hit');
  });

  it('returns empty string with no usable events', () => {
    expect(backend.extractResult([{ type: 'turn.started' }])).toBe('');
  });
});

describe('CodexBackend command builders', () => {
  const backend = new CodexBackend();

  it('launches fresh interactive codex without a mapped thread', () => {
    const cmd = backend.buildLaunchCommand({ sessionId: 'sess-1', cwd: '/tmp/w' });
    expect(cmd).toContain('cd /tmp/w');
    expect(cmd).toContain('codex --dangerously-bypass-approvals-and-sandbox; exit');
    expect(cmd).not.toContain('resume');
  });

  it('resumes interactive codex with a mapped thread', () => {
    seedThreadMap({ 'sess-1': 'thread-abc' });
    const cmd = backend.buildLaunchCommand({ sessionId: 'sess-1', cwd: '/tmp/w' });
    expect(cmd).toContain('codex --dangerously-bypass-approvals-and-sandbox resume thread-abc');
  });

  it('builds pipe command with resume and output file', () => {
    seedThreadMap({ 'sess-2': 'thread-xyz' });
    const cmd = backend.buildPipeCommand({ prompt: "hi 'there'", sessionId: 'sess-2', cwd: '/tmp/w' });
    expect(cmd).toContain('exec resume');
    expect(cmd).toContain("'thread-xyz'");
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain('--skip-git-repo-check');
    expect(cmd).toContain('cat ');
  });

  // resume 子命令不支持 -C（2026-08-06 实测：clap 报 "to pass '-C' as a value"），
  // 这条守住"别再把 -C 加回来"
  it('never passes -C to codex (cwd goes through the child process instead)', () => {
    seedThreadMap({ 'sess-2': 'thread-xyz' });
    const resumeCmd = backend.buildPipeCommand({ prompt: 'x', sessionId: 'sess-2', cwd: '/tmp/w' });
    const freshCmd = backend.buildPipeCommand({ prompt: 'x', sessionId: 'sess-none', cwd: '/tmp/w' });
    for (const cmd of [resumeCmd, freshCmd]) {
      expect(cmd).not.toMatch(/\s-C\s/);
      expect(cmd).toContain("cd '/tmp/w'");
    }
  });

  it('prefixes CODEX_HOME when set', () => {
    process.env.CODEX_HOME = '/Users/x/.codex-924';
    const cmd = backend.buildLaunchCommand({ sessionId: 'sess-3', cwd: '/tmp/w' });
    expect(cmd).toContain("CODEX_HOME='/Users/x/.codex-924' codex");
  });
});

describe('CodexBackend.resetSession', () => {
  const backend = new CodexBackend();

  it('drops the thread binding so the next message starts fresh', () => {
    seedThreadMap({ 'sess-a': 'thread-a', 'sess-b': 'thread-b' });
    expect(backend.buildLaunchCommand({ sessionId: 'sess-a', cwd: '/w' })).toContain('resume thread-a');

    backend.resetSession('sess-a');

    // sess-a 回到全新会话，sess-b 不受影响
    expect(backend.buildLaunchCommand({ sessionId: 'sess-a', cwd: '/w' })).not.toContain('resume');
    expect(backend.buildLaunchCommand({ sessionId: 'sess-b', cwd: '/w' })).toContain('resume thread-b');
  });

  it('is a no-op for an unknown session', () => {
    seedThreadMap({ 'sess-a': 'thread-a' });
    expect(() => backend.resetSession('nobody')).not.toThrow();
    expect(backend.buildLaunchCommand({ sessionId: 'sess-a', cwd: '/w' })).toContain('resume thread-a');
  });
});

describe('CodexBackend reasoning effort override', () => {
  const backend = new CodexBackend();
  const savedEffort = process.env.CC2WECHAT_CODEX_EFFORT;

  afterEach(() => {
    if (savedEffort == null) delete process.env.CC2WECHAT_CODEX_EFFORT;
    else process.env.CC2WECHAT_CODEX_EFFORT = savedEffort;
  });

  it('leaves config.toml alone when the env knob is unset', () => {
    delete process.env.CC2WECHAT_CODEX_EFFORT;
    const cmd = backend.buildPipeCommand({ prompt: 'x', sessionId: 's', cwd: '/w' });
    expect(cmd).not.toContain('model_reasoning_effort');
  });

  it('injects -c model_reasoning_effort when the env knob is set', () => {
    process.env.CC2WECHAT_CODEX_EFFORT = 'medium';
    const cmd = backend.buildPipeCommand({ prompt: 'x', sessionId: 's', cwd: '/w' });
    expect(cmd).toContain('model_reasoning_effort="medium"');
  });
});

describe('CodexBackend.extractResult 错误优先级', () => {
  const backend = new CodexBackend();

  // codex 退出前会把 skill 加载失败之类的写进 stderr，那条事件排在最后。
  // 直接取最后一条会让用户看到 "invalid YAML"，而真正的原因是配额用尽。
  it('prefers the semantic failure over the process-exit noise', () => {
    const events: BackendEvent[] = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'error', message: "You've hit your usage limit." },
      { type: 'turn.failed', error: { message: "You've hit your usage limit." } },
      { type: 'error', message: 'codex exited 1: md: invalid YAML: did not find expected key' },
    ];
    expect(backend.extractResult(events)).toBe("[codex] You've hit your usage limit.");
  });

  it('still surfaces the exit error when nothing else explains the failure', () => {
    const events: BackendEvent[] = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'error', message: 'codex exited 1: something broke' },
    ];
    expect(backend.extractResult(events)).toBe('[codex] codex exited 1: something broke');
  });
});
