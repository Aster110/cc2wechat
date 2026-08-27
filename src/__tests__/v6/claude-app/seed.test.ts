import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InboxRegistry } from '../../../v6/claude-app/inbox-registry.js';
import {
  inboxClaudeMd,
  inboxSettings,
  seedInbox,
  formatSeedReport,
  deepLinkFor,
} from '../../../v6/claude-app/seed.js';

let root: string;
let dataDir: string;
let inboxes: InboxRegistry;
let opened: string[];

beforeEach(() => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seed-')));
  root = path.join(tmp, 'cc-wechat');
  dataDir = path.join(tmp, 'data');
  inboxes = new InboxRegistry({ accountId: 'acct', dir: dataDir, now: () => 1 });
  opened = [];
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

function seed(name = 'kiki', over: Record<string, unknown> = {}) {
  return seedInbox({ name, root, inboxes, openUrl: (u) => opened.push(u), ...over });
}

describe('deepLinkFor —— 深链只开可见草稿(参数是明文绝对路径)', () => {
  it('claude://code/new?folder=<绝对路径>', () => {
    expect(deepLinkFor('/Users/aster/cc-wechat/inbox-kiki')).toBe(
      'claude://code/new?folder=/Users/aster/cc-wechat/inbox-kiki',
    );
  });

  it('带空格的路径要转义,否则 open 会截断', () => {
    expect(deepLinkFor('/Users/a b/inbox')).toContain('%20');
  });
});

describe('seedInbox —— 建目录 + 模板 + 发深链', () => {
  it('目录名是 inbox-<name>,每收件箱独占 cwd', async () => {
    const r = await seed('kiki');
    expect(r.cwd).toBe(path.join(root, 'inbox-kiki'));
    expect(fs.existsSync(r.cwd)).toBe(true);
  });

  it('写出 CLAUDE.md 与 .claude/settings.json', async () => {
    const r = await seed('kiki');
    expect(fs.existsSync(path.join(r.cwd, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.cwd, '.claude', 'settings.json'))).toBe(true);
    expect(r.created).toContain(path.join(r.cwd, 'CLAUDE.md'));
  });

  it('登记进台账,状态是"待人工敲首条"(还没 localId)', async () => {
    await seed('kiki');
    const rec = inboxes.byName('kiki')!;
    expect(rec.cwd).toBe(path.join(root, 'inbox-kiki'));
    expect(rec.localId).toBeNull();
  });

  it('发射深链(open 是注入的,测试不会真开 app)', async () => {
    const r = await seed('kiki');
    expect(opened).toEqual([r.deepLink]);
  });

  it('--no-open 时不发深链,但把链接打出来让人自己点', async () => {
    const r = await seed('kiki', { open: false });
    expect(opened).toEqual([]);
    expect(formatSeedReport(r)).toContain('claude://code/new?folder=');
  });

  it('人工步骤必须写明"敲首条消息",这是播种唯一不能自动化的一步', async () => {
    const r = await seed('kiki');
    const steps = r.manualSteps.join('\n');
    expect(steps).toMatch(/首条|敲一条/);
    expect(formatSeedReport(r)).toContain('claude-app status');
  });

  it('重复播种不覆盖已有 CLAUDE.md(人可能改过)', async () => {
    const r1 = await seed('kiki');
    fs.writeFileSync(path.join(r1.cwd, 'CLAUDE.md'), '我改过了');
    const r2 = await seed('kiki');
    expect(fs.readFileSync(path.join(r2.cwd, 'CLAUDE.md'), 'utf-8')).toBe('我改过了');
    expect(r2.alreadyExisted).toBe(true);
    expect(r2.created).not.toContain(path.join(r2.cwd, 'CLAUDE.md'));
  });

  it('--force 时把模板写回去', async () => {
    const r1 = await seed('kiki');
    fs.writeFileSync(path.join(r1.cwd, 'CLAUDE.md'), '我改过了');
    const r2 = await seed('kiki', { force: true });
    expect(fs.readFileSync(path.join(r2.cwd, 'CLAUDE.md'), 'utf-8')).toContain('收件箱');
  });

  it('名字非法(带斜杠/空)时拒绝 —— 目录名就是路由键,不能让它逃出 root', async () => {
    await expect(seed('../../etc')).rejects.toThrow();
    await expect(seed('')).rejects.toThrow();
    await expect(seed('a/b')).rejects.toThrow();
  });
});

describe('CLAUDE.md 模板 —— 收件箱纪律', () => {
  const md = inboxClaudeMd('kiki');

  it('点名禁用 cc2wechat --text(防双发,与 codex 通道同纪律)', () => {
    expect(md).toContain('cc2wechat --text');
    expect(md).toMatch(/禁用|不要|别/);
  });

  it('说明信封格式,让收件箱知道 job 标记是什么', () => {
    expect(md).toContain('[微信|');
    expect(md).toContain('job:');
  });

  it('把微信输入标成不可信输入', () => {
    expect(md).toContain('不可信');
  });

  it('交代媒体是本地路径', () => {
    expect(md).toContain('[附件]');
  });

  it('带上收件箱自己的名字', () => {
    expect(md).toContain('kiki');
  });

  it('交代回复风格(微信那头在等,短一点)', () => {
    expect(md).toMatch(/微信/);
  });
});

describe('settings.json 模板 —— 目录级权限白名单', () => {
  const s = inboxSettings();

  it('是合法 JSON 且有 permissions', () => {
    const parsed = JSON.parse(JSON.stringify(s));
    expect(parsed.permissions).toBeTruthy();
    expect(Array.isArray(parsed.permissions.allow)).toBe(true);
    expect(Array.isArray(parsed.permissions.deny)).toBe(true);
  });

  it('不是 bypassPermissions —— 微信输入不可信,克制点', () => {
    expect(s.permissions.defaultMode).not.toBe('bypassPermissions');
  });

  it('deny 里挡住 cc2wechat 回传(纪律要有牙齿,不能只写在 CLAUDE.md 里)', () => {
    expect(s.permissions.deny.some((d) => d.includes('cc2wechat'))).toBe(true);
  });

  it('允许基本的读/搜/网,不然收件箱干不了活', () => {
    const allow = s.permissions.allow.join(' ');
    expect(allow).toContain('Read');
    expect(allow).toContain('Grep');
  });
});
