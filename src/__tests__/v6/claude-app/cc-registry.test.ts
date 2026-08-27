import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CcRegistry, slugOf, transcriptPath } from '../../../v6/claude-app/cc-registry.js';
import { writeEngines } from './fixtures.js';

let root: string;
let sessionsDir: string;
let projectsDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-registry-')));
  sessionsDir = path.join(root, 'sessions');
  projectsDir = path.join(root, 'projects');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function reg(opts: { alive?: (pid: number) => boolean } = {}): CcRegistry {
  return new CcRegistry({
    sessionsDir,
    projectsDir,
    isAlive: opts.alive ?? (() => true),
  });
}

describe('slugOf —— 项目目录名规则(实测:非字母数字一律换成 -)', () => {
  it('普通路径', () => {
    expect(slugOf('/Users/aster/AIproject/mylife')).toBe('-Users-aster-AIproject-mylife');
  });

  it('下划线也变横线(polyverse_samantha 实例)', () => {
    expect(slugOf('/Users/aster/AIproject/polyverse_samantha')).toBe('-Users-aster-AIproject-polyverse-samantha');
  });

  it('点号变横线,于是 /.claude/ 变成 --claude-(worktree 实例)', () => {
    expect(slugOf('/Users/aster/AIproject/polyverse_samantha/.claude/worktrees/nice-mendel-d2b91f')).toBe(
      '-Users-aster-AIproject-polyverse-samantha--claude-worktrees-nice-mendel-d2b91f',
    );
  });

  it('末尾斜杠不该多出一截', () => {
    expect(slugOf('/Users/aster/cc-wechat/inbox-a/')).toBe(slugOf('/Users/aster/cc-wechat/inbox-a'));
  });
});

describe('transcriptPath', () => {
  it('= <projects>/<slug(cwd)>/<CLI-id>.jsonl', () => {
    expect(transcriptPath('/p', '/Users/aster/AIproject/mylife', 'abc-123')).toBe(
      '/p/-Users-aster-AIproject-mylife/abc-123.jsonl',
    );
  });
});

describe('CcRegistry.liveEngineByCwd —— 按 cwd 找活引擎', () => {
  it('读得到注册表里同 cwd 的引擎(并带出 CLI id / socket)', () => {
    writeEngines(sessionsDir, [{ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a', name: 'inbox-a' }]);
    const e = reg().liveEngineByCwd('/inbox/a');
    expect(e).toMatchObject({ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a', name: 'inbox-a' });
    expect(e!.messagingSocketPath).toBe('/tmp/cc-socks/111.sock');
  });

  it('cwd 不匹配的引擎不算(每收件箱独占 cwd = 路由键)', () => {
    writeEngines(sessionsDir, [{ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a' }]);
    expect(reg().liveEngineByCwd('/inbox/b')).toBeNull();
  });

  it('末尾斜杠 / 相对写法不该错过自己的引擎', () => {
    writeEngines(sessionsDir, [{ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a' }]);
    expect(reg().liveEngineByCwd('/inbox/a/')).not.toBeNull();
  });

  it('pid 已经死了就不算活引擎(WarmLifecycle 放倒后注册表可能还残留)', () => {
    writeEngines(sessionsDir, [{ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a' }]);
    expect(reg({ alive: () => false }).liveEngineByCwd('/inbox/a')).toBeNull();
  });

  it('同 cwd 多个引擎时取最新起来的那个', () => {
    writeEngines(sessionsDir, [
      { pid: 1, sessionId: 'old', cwd: '/inbox/a', startedAt: 1000 },
      { pid: 2, sessionId: 'new', cwd: '/inbox/a', startedAt: 9000 },
    ]);
    expect(reg().liveEngineByCwd('/inbox/a')!.sessionId).toBe('new');
  });

  it('.key 文件和坏 JSON 一律跳过,不该把整张表读崩', () => {
    writeEngines(sessionsDir, [{ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a' }]);
    fs.writeFileSync(path.join(sessionsDir, '999.json'), '{ 这不是 json');
    fs.writeFileSync(path.join(sessionsDir, 'README.txt'), 'hi');
    expect(reg().liveEngineByCwd('/inbox/a')!.sessionId).toBe('cli-aaa');
  });

  it('注册表目录压根不存在时返回 null 而不是抛', () => {
    const r = new CcRegistry({ sessionsDir: path.join(root, 'nope'), projectsDir, isAlive: () => true });
    expect(r.liveEngineByCwd('/inbox/a')).toBeNull();
    expect(r.listEngines()).toEqual([]);
  });
});

describe('CcRegistry.transcriptFor —— 活引擎 → jsonl 路径', () => {
  it('拼出 projects/<slug>/<CLI-id>.jsonl', () => {
    writeEngines(sessionsDir, [{ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a' }]);
    expect(reg().transcriptFor('/inbox/a')).toBe(path.join(projectsDir, '-inbox-a', 'cli-aaa.jsonl'));
  });

  it('没有活引擎就没有路径 —— 不缓存跨唤醒的旧映射(10 §4 纪律)', () => {
    expect(reg().transcriptFor('/inbox/a')).toBeNull();
  });
});

describe('CcRegistry.projectDir', () => {
  it('不依赖活引擎也能给出收件箱的 transcript 目录', () => {
    expect(reg().projectDir('/inbox/a')).toBe(path.join(projectsDir, '-inbox-a'));
  });
});

describe('CcRegistry.waitForEngine —— 冷唤醒:投递后等新引擎出现', () => {
  it('引擎已经在就立刻返回', async () => {
    writeEngines(sessionsDir, [{ pid: 111, sessionId: 'cli-aaa', cwd: '/inbox/a' }]);
    const e = await reg().waitForEngine('/inbox/a', { timeoutMs: 50, pollMs: 5 });
    expect(e!.sessionId).toBe('cli-aaa');
  });

  it('等到引擎注册进来(实测 ~2s 起一个新引擎)', async () => {
    const r = reg();
    setTimeout(() => writeEngines(sessionsDir, [{ pid: 222, sessionId: 'cli-cold', cwd: '/inbox/a' }]), 20);
    const e = await r.waitForEngine('/inbox/a', { timeoutMs: 1_000, pollMs: 5 });
    expect(e!.sessionId).toBe('cli-cold');
  });

  it('超时返回 null,不抛', async () => {
    expect(await reg().waitForEngine('/inbox/a', { timeoutMs: 30, pollMs: 5 })).toBeNull();
  });

  it('abort 立刻收摊', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    expect(await reg().waitForEngine('/inbox/a', { timeoutMs: 5_000, pollMs: 5, signal: ac.signal })).toBeNull();
  });
});

describe('CcRegistry.appVersions —— 版本脆弱,探针要盯着', () => {
  it('列出 app 内置 claude-code 的版本目录', () => {
    const appDir = path.join(root, 'app');
    fs.mkdirSync(path.join(appDir, '2.1.246'), { recursive: true });
    fs.mkdirSync(path.join(appDir, '2.1.250'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'notes.txt'), 'x');
    const r = new CcRegistry({ sessionsDir, projectsDir, appVersionsDir: appDir, isAlive: () => true });
    expect(r.appVersions()).toEqual(['2.1.246', '2.1.250']);
  });

  it('目录不存在时给空数组', () => {
    const r = new CcRegistry({ sessionsDir, projectsDir, appVersionsDir: path.join(root, 'nope'), isAlive: () => true });
    expect(r.appVersions()).toEqual([]);
  });
});
