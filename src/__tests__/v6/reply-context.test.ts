import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveReplyContext, writeReplyRoute, ctxDir, ctxPathForUser } from '../../v6/reply-context.js';

let home: string;
let tmpDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-ctx-home-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-ctx-tmp-'));
  savedHome = process.env.HOME;
  // store.loadAccounts 读 os.homedir(),测试期间把 HOME 指到临时目录
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome == null) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAccounts(port: number, accounts: unknown[]): void {
  const dir = path.join(home, '.cc2wechat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `accounts-${port}.json`), JSON.stringify(accounts));
}

describe('writeReplyRoute', () => {
  it('写到 ~/.cc2wechat/ctx/,目录 0700 文件 0600,内容不含 token', () => {
    const p = writeReplyRoute({ userId: 'u1', contextToken: 'ctx-1', port: 19001, accountId: 'acc-1' }, home);
    expect(p).toBe(ctxPathForUser('u1', home));
    expect(p.startsWith(ctxDir(home))).toBe(true);

    const raw = fs.readFileSync(p, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ userId: 'u1', contextToken: 'ctx-1', port: 19001, accountId: 'acc-1' });
    expect(raw).not.toContain('token');

    expect(fs.statSync(ctxDir(home)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('同一个用户覆盖同一个文件,不堆垃圾', () => {
    writeReplyRoute({ userId: 'u1', contextToken: 'a', port: 1, accountId: 'x' }, home);
    writeReplyRoute({ userId: 'u1', contextToken: 'b', port: 1, accountId: 'x' }, home);
    expect(fs.readdirSync(ctxDir(home))).toHaveLength(1);
  });
});

describe('resolveReplyContext — v6 路由 + accounts 查 token', () => {
  it('从 ctx 路由取 userId,从 accounts-<port>.json 取 token/baseUrl', () => {
    seedAccounts(19001, [{ accountId: 'acc-1', token: 'tok-1', baseUrl: 'https://a.example.com' }]);
    writeReplyRoute({ userId: 'u1', contextToken: 'ctx-1', port: 19001, accountId: 'acc-1' }, home);

    expect(resolveReplyContext({ home, env: {}, tmpDir })).toEqual({
      token: 'tok-1',
      baseUrl: 'https://a.example.com',
      userId: 'u1',
      contextToken: 'ctx-1',
    });
  });

  it('多用户时取最近写过的那个', async () => {
    seedAccounts(19001, [{ accountId: 'acc-1', token: 'tok-1' }]);
    writeReplyRoute({ userId: 'old-user', contextToken: 'c1', port: 19001, accountId: 'acc-1' }, home);
    await new Promise((r) => setTimeout(r, 12));
    writeReplyRoute({ userId: 'new-user', contextToken: 'c2', port: 19001, accountId: 'acc-1' }, home);

    expect(resolveReplyContext({ home, env: {}, tmpDir })?.userId).toBe('new-user');
  });

  it('同端口多账号时按 accountId 对上号', () => {
    seedAccounts(19001, [
      { accountId: 'acc-1', token: 'tok-1' },
      { accountId: 'acc-2', token: 'tok-2' },
    ]);
    writeReplyRoute({ userId: 'u1', contextToken: 'c', port: 19001, accountId: 'acc-1' }, home);
    expect(resolveReplyContext({ home, env: {}, tmpDir })?.token).toBe('tok-1');
  });

  it('accounts 文件缺失时退回 legacy,不硬崩', () => {
    writeReplyRoute({ userId: 'u1', contextToken: 'c', port: 19001, accountId: 'acc-1' }, home);
    fs.writeFileSync(
      path.join(tmpDir, 'cc2wechat-ctx-abc.json'),
      JSON.stringify({ token: 'legacy-tok', userId: 'legacy-u', contextToken: 'legacy-c' }),
    );
    expect(resolveReplyContext({ home, env: {}, tmpDir })?.token).toBe('legacy-tok');
  });
});

describe('resolveReplyContext — legacy 兜底(v5 并存期)', () => {
  it('/tmp/cc2wechat-ctx-*.json 里自带 token 的老格式照样能用', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cc2wechat-ctx-11111111.json'),
      JSON.stringify({ token: 'tok-legacy', baseUrl: 'https://b.example.com', userId: 'u9', contextToken: 'c9' }),
    );
    expect(resolveReplyContext({ home, env: {}, tmpDir })).toEqual({
      token: 'tok-legacy',
      baseUrl: 'https://b.example.com',
      userId: 'u9',
      contextToken: 'c9',
    });
  });

  it('更早的单文件 /tmp/cc2wechat-context.json 也认', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cc2wechat-context.json'),
      JSON.stringify({ token: 'tok-old', userId: 'u8', contextToken: 'c8' }),
    );
    expect(resolveReplyContext({ home, env: {}, tmpDir })?.token).toBe('tok-old');
  });

  it('v6 路由优先于 legacy', () => {
    seedAccounts(19001, [{ accountId: 'acc-1', token: 'tok-new' }]);
    writeReplyRoute({ userId: 'u-new', contextToken: 'c', port: 19001, accountId: 'acc-1' }, home);
    fs.writeFileSync(
      path.join(tmpDir, 'cc2wechat-ctx-22222222.json'),
      JSON.stringify({ token: 'tok-legacy', userId: 'u-legacy', contextToken: 'c' }),
    );
    expect(resolveReplyContext({ home, env: {}, tmpDir })?.userId).toBe('u-new');
  });

  it('CC2WECHAT_CONTEXT 显式指定优先级最高', () => {
    const explicit = path.join(tmpDir, 'explicit.json');
    fs.writeFileSync(explicit, JSON.stringify({ token: 'tok-explicit', userId: 'u-explicit', contextToken: 'c' }));
    seedAccounts(19001, [{ accountId: 'acc-1', token: 'tok-new' }]);
    writeReplyRoute({ userId: 'u-new', contextToken: 'c', port: 19001, accountId: 'acc-1' }, home);

    expect(resolveReplyContext({ home, env: { CC2WECHAT_CONTEXT: explicit }, tmpDir })?.token).toBe('tok-explicit');
  });

  it('CC2WECHAT_CONTEXT 指向 v6 路由格式(无 token)时也能补齐', () => {
    seedAccounts(19001, [{ accountId: 'acc-1', token: 'tok-1' }]);
    const explicit = path.join(tmpDir, 'route.json');
    fs.writeFileSync(explicit, JSON.stringify({ userId: 'u1', contextToken: 'c1', port: 19001, accountId: 'acc-1' }));
    expect(resolveReplyContext({ home, env: { CC2WECHAT_CONTEXT: explicit }, tmpDir })?.token).toBe('tok-1');
  });

  it('什么都没有时返回 null(调用方负责提示 daemon 没跑)', () => {
    expect(resolveReplyContext({ home, env: {}, tmpDir })).toBeNull();
  });

  it('损坏的 ctx 文件不炸,继续往下找', () => {
    fs.mkdirSync(ctxDir(home), { recursive: true });
    fs.writeFileSync(path.join(ctxDir(home), 'broken.json'), 'not json');
    fs.writeFileSync(
      path.join(tmpDir, 'cc2wechat-ctx-33333333.json'),
      JSON.stringify({ token: 'tok-legacy', userId: 'u', contextToken: 'c' }),
    );
    expect(resolveReplyContext({ home, env: {}, tmpDir })?.token).toBe('tok-legacy');
  });
});
