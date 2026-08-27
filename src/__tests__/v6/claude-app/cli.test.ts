import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CcRegistry } from '../../../v6/claude-app/cc-registry.js';
import { InboxRegistry } from '../../../v6/claude-app/inbox-registry.js';
import { runClaudeAppCli } from '../../../v6/claude-app/cli.js';
import { VERIFIED_APP_VERSIONS } from '../../../v6/claude-app/probe.js';
import { writeEngines } from './fixtures.js';

let tmp: string;
let root: string;
let dataDir: string;
let sessionsDir: string;
let projectsDir: string;
let appDir: string;
let inboxes: InboxRegistry;
let out: string[];
let opened: string[];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-appcli-')));
  root = path.join(tmp, 'cc-wechat');
  dataDir = path.join(tmp, 'data');
  sessionsDir = path.join(tmp, 'sessions');
  projectsDir = path.join(tmp, 'projects');
  appDir = path.join(tmp, 'app');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(appDir, VERIFIED_APP_VERSIONS[0]), { recursive: true });
  inboxes = new InboxRegistry({ accountId: 'acct', dir: dataDir, now: () => 1 });
  out = [];
  opened = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(argv: string[], over: Record<string, unknown> = {}) {
  return runClaudeAppCli({
    argv,
    port: 18081,
    root,
    inboxes,
    registry: new CcRegistry({ sessionsDir, projectsDir, appVersionsDir: appDir, isAlive: () => true }),
    fetchStatus: async () => ({ connected: true, connections: 1, lastAckMs: 33 }),
    openUrl: (u) => opened.push(u),
    out: (l) => out.push(l),
    ...over,
  });
}

const text = (): string => out.join('\n');

describe('claude-app seed', () => {
  it('建目录 + 写模板 + 发深链,退出码 0', async () => {
    const code = await run(['seed', '--name', 'kiki']);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(root, 'inbox-kiki', 'CLAUDE.md'))).toBe(true);
    expect(opened[0]).toContain('claude://code/new?folder=');
    expect(text()).toContain('inbox-kiki');
  });

  it('--no-open 不发深链', async () => {
    await run(['seed', '--name', 'kiki', '--no-open']);
    expect(opened).toEqual([]);
  });

  it('--root 换根目录', async () => {
    const other = path.join(tmp, 'elsewhere');
    await run(['seed', '--name', 'kiki', '--root', other]);
    expect(fs.existsSync(path.join(other, 'inbox-kiki'))).toBe(true);
  });

  it('没给 --name → 用法 + 退出码 1', async () => {
    expect(await run(['seed'])).toBe(1);
    expect(text()).toContain('--name');
  });

  it('名字非法 → 报错但不抛(CLI 不该栈回溯糊人一脸)', async () => {
    expect(await run(['seed', '--name', 'a/b'])).toBe(1);
    expect(text()).toMatch(/不合法/);
  });
});

describe('claude-app status', () => {
  it('探针 + 台账一起打,全绿退 0', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    writeEngines(sessionsDir, [{ pid: 9, sessionId: 'cli', cwd: '/inbox/kiki' }]);
    const code = await run(['status']);
    expect(code).toBe(0);
    expect(text()).toContain('网关连接');
    expect(text()).toContain('kiki');
  });

  it('台账里每个收件箱的 cwd / localId / 绑定都要看得见', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    inboxes.claim('conv-9');
    await run(['status']);
    const t = text();
    expect(t).toContain('/inbox/kiki');
    expect(t).toContain('local_k');
    expect(t).toContain('conv-9');
  });

  it('还没敲首条的收件箱要点名,并给出下一步', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    await run(['status']);
    expect(text()).toMatch(/首条|待/);
  });

  it('打出台账文件路径 —— CLI 退到 default 而 daemon 用真 accountId 时,这是唯一能看出来的地方', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    await run(['status']);
    expect(text()).toContain(inboxes.filePath());
  });

  it('daemon 没跑(status 打不通)→ 明说,退出码 1', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const code = await run(['status'], { fetchStatus: async () => null });
    expect(code).toBe(1);
    expect(text()).toContain('daemon');
  });

  it('一个收件箱都没有 → 退出码 1 并教怎么播种', async () => {
    expect(await run(['status'])).toBe(1);
    expect(text()).toContain('seed --name');
  });
});

describe('用法', () => {
  it('不给子命令 → 用法 + 退出码 1', async () => {
    expect(await run([])).toBe(1);
    expect(text()).toContain('claude-app seed');
    expect(text()).toContain('claude-app status');
  });

  it('未知子命令 → 用法 + 退出码 1', async () => {
    expect(await run(['frobnicate'])).toBe(1);
    expect(text()).toContain('claude-app seed');
  });
});
