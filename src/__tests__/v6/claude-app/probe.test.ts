import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CcRegistry } from '../../../v6/claude-app/cc-registry.js';
import { InboxRegistry } from '../../../v6/claude-app/inbox-registry.js';
import { runProbe, formatProbe, VERIFIED_APP_VERSIONS } from '../../../v6/claude-app/probe.js';
import { writeEngines } from './fixtures.js';

let root: string;
let sessionsDir: string;
let projectsDir: string;
let appDir: string;
let inboxes: InboxRegistry;

function registry(): CcRegistry {
  return new CcRegistry({ sessionsDir, projectsDir, appVersionsDir: appDir, isAlive: () => true });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-')));
  sessionsDir = path.join(root, 'sessions');
  projectsDir = path.join(root, 'projects');
  appDir = path.join(root, 'app');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(appDir, VERIFIED_APP_VERSIONS[0]), { recursive: true });
  inboxes = new InboxRegistry({ accountId: 'acct', dir: path.join(root, 'data'), now: () => 1 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function probe(over: Record<string, unknown> = {}) {
  return runProbe({ registry: registry(), inboxes, busStats: { connected: true, connections: 1, lastAckMs: 42 }, ...over });
}

function check(r: ReturnType<typeof probe>, name: string) {
  const hit = r.checks.find((c) => c.name === name);
  if (!hit) throw new Error(`没有这个检查项:${name}(有的是 ${r.checks.map((c) => c.name).join(', ')})`);
  return hit;
}

describe('runProbe —— 开机自检(版本脆弱,坏了要降级不许哑死)', () => {
  it('一切正常时 ok', () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    writeEngines(sessionsDir, [{ pid: 1, sessionId: 'cli', cwd: '/inbox/kiki' }]);
    const r = probe();
    expect(r.ok).toBe(true);
  });

  it('注册表读不到 → 不 ok(cwd→CLI id 这条路断了,回程就瞎了)', () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    const c = check(probe(), '引擎注册表');
    expect(c.ok).toBe(false);
  });

  it('注册表能读但没有活引擎 → ok(WarmLifecycle 放倒是常态,不是故障)', () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const c = check(probe(), '引擎注册表');
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('0');
  });

  it('app 版本在已验证清单里 → ok 不 warn', () => {
    const c = check(probe(), 'app 版本');
    expect(c.ok).toBe(true);
    expect(c.warn).toBeFalsy();
    expect(c.detail).toContain(VERIFIED_APP_VERSIONS[0]);
  });

  it('版本漂移 → warn 但不判死(所有机制都是内部实现,变了先喊一声)', () => {
    fs.mkdirSync(path.join(appDir, '9.9.9'), { recursive: true });
    const c = check(probe(), 'app 版本');
    expect(c.warn).toBe(true);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('9.9.9');
  });

  it('一个版本目录都没有 → warn(可能 app 没装/路径变了)', () => {
    fs.rmSync(appDir, { recursive: true, force: true });
    expect(check(probe(), 'app 版本').warn).toBe(true);
  });

  it('网关不在线 → 不 ok,而且说清怎么救', () => {
    const c = check(probe({ busStats: { connected: false, connections: 0 } }), '网关连接');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/重挂|GATEWAY/);
  });

  it('拿不到 bus 状态(daemon 没跑)时如实说,不假装健康', () => {
    const c = check(probe({ busStats: null }), '网关连接');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('daemon');
  });

  it('最近一次注入回执延迟进报告', () => {
    expect(check(probe(), '注入回执').detail).toContain('42');
  });

  it('从没注入过 → 不算故障', () => {
    const c = check(probe({ busStats: { connected: true, connections: 1, lastAckMs: -1 } }), '注入回执');
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/还没|无/);
  });

  it('一个收件箱都没播种 → 不 ok', () => {
    const c = check(probe(), '收件箱台账');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('seed');
  });

  it('播了但没人敲首条(localId 未解析)→ warn', () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const c = check(probe(), '收件箱台账');
    expect(c.warn).toBe(true);
    expect(c.detail).toContain('kiki');
  });

  it('整体 ok = 所有硬检查都 ok(warn 不影响)', () => {
    // 两个 warn:版本漂移 + 收件箱还没敲首条。硬检查一个没坏 → 整体仍然 ok
    inboxes.seed('kiki', '/inbox/kiki');
    fs.mkdirSync(path.join(appDir, '9.9.9'), { recursive: true });
    const r = probe();
    expect(r.checks.filter((c) => c.warn).length).toBe(2);
    expect(r.ok).toBe(true);
  });

  it('有一项硬检查坏了,整体就不 ok', () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const r = probe({ busStats: { connected: false, connections: 0 } });
    expect(r.ok).toBe(false);
  });
});

describe('formatProbe —— 人读的输出', () => {
  it('每项一行,带状态符号', () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const out = formatProbe(probe());
    expect(out).toContain('引擎注册表');
    expect(out).toContain('网关连接');
    expect(out).toMatch(/[✅⚠️❌]/u);
  });

  it('坏的项要显眼', () => {
    const out = formatProbe(probe({ busStats: null }));
    expect(out).toContain('❌');
  });
});
