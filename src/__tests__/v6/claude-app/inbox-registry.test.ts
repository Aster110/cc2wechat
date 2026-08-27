import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InboxRegistry } from '../../../v6/claude-app/inbox-registry.js';

let dir: string;
let clock = 1_000;

function reg(): InboxRegistry {
  return new InboxRegistry({ accountId: 'acct-1', dir, now: () => clock });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-inbox-')));
  clock = 1_000;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('seed —— 播种一次,终身复用', () => {
  it('登记名字与 cwd', () => {
    const r = reg();
    const rec = r.seed('kiki', '/inbox/kiki');
    expect(rec).toMatchObject({ name: 'kiki', cwd: '/inbox/kiki', conversationId: null, localId: null, generation: 1 });
    expect(r.list().map((i) => i.name)).toEqual(['kiki']);
  });

  it('重复播种同名 = 幂等(更新 cwd,不重开一条)', () => {
    const r = reg();
    r.seed('kiki', '/inbox/kiki');
    r.seed('kiki', '/inbox/kiki-2');
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0].cwd).toBe('/inbox/kiki-2');
  });

  it('落盘,换个实例还在(daemon 重启不该丢台账)', () => {
    reg().seed('kiki', '/inbox/kiki');
    expect(reg().list()[0].name).toBe('kiki');
  });

  it('文件名带 accountId —— 一台机器多账号各管各的', () => {
    reg().seed('kiki', '/inbox/kiki');
    expect(fs.existsSync(path.join(dir, 'claude-app-inboxes-acct-1.json'))).toBe(true);
  });
});

describe('claim —— 微信会话认领一个空收件箱', () => {
  it('没有绑定过就领一个空的', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    const got = r.claim('conv-1');
    expect(got).toMatchObject({ name: 'a', conversationId: 'conv-1' });
    expect(r.forConversation('conv-1')!.name).toBe('a');
  });

  it('已经绑过的会话直接命中,不会再领第二个', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.seed('b', '/inbox/b');
    r.claim('conv-1');
    expect(r.claim('conv-1')!.name).toBe('a');
    expect(r.list().find((i) => i.name === 'b')!.conversationId).toBeNull();
  });

  it('按播种顺序领,不抢别人已经占的', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.seed('b', '/inbox/b');
    expect(r.claim('conv-1')!.name).toBe('a');
    expect(r.claim('conv-2')!.name).toBe('b');
  });

  it('没有空收件箱就返回 null —— 播种是人工动作,不能偷偷造一个', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.claim('conv-1');
    expect(r.claim('conv-2')).toBeNull();
  });

  it('认领要落盘(下一条消息还得认得出来)', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.claim('conv-1');
    expect(reg().forConversation('conv-1')!.name).toBe('a');
  });
});

describe('localId 懒解析', () => {
  it('刚播种时没有 localId,需要 resolve', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    expect(r.needResolve('a')).toBe(true);
  });

  it('绑上之后不再需要 resolve', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.bindLocalId('a', 'local_123');
    expect(r.needResolve('a')).toBe(false);
    expect(reg().list()[0].localId).toBe('local_123');
  });

  it('localId 变了要能改绑(app 侧句柄理论上稳定,但不赌)', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.bindLocalId('a', 'local_1');
    r.bindLocalId('a', 'local_2');
    expect(r.list()[0].localId).toBe('local_2');
  });

  it('清掉 localId(注入失败时让下一轮重解析)', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.bindLocalId('a', 'local_1');
    r.clearLocalId('a');
    expect(r.needResolve('a')).toBe(true);
  });

  it('对不存在的收件箱操作不炸', () => {
    const r = reg();
    expect(() => r.bindLocalId('ghost', 'x')).not.toThrow();
    expect(r.needResolve('ghost')).toBe(false);
  });
});

describe('reset —— 上下文重置标记(收件箱永续,不换绑定)', () => {
  it('bump 之后 generation+1 并挂起一个重置标记', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.claim('conv-1');
    r.bumpGeneration('conv-1');
    const rec = r.forConversation('conv-1')!;
    expect(rec.generation).toBe(2);
    expect(rec.resetPending).toBe(true);
    // 绑定关系一个没动:收件箱是终身的
    expect(rec.name).toBe('a');
    expect(rec.cwd).toBe('/inbox/a');
  });

  it('takeReset 取一次就清,不会每条消息都喊重置', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.claim('conv-1');
    r.bumpGeneration('conv-1');
    expect(r.takeReset('a')).toBe(true);
    expect(r.takeReset('a')).toBe(false);
  });

  it('没绑过的会话 bump 不炸', () => {
    expect(() => reg().bumpGeneration('nobody')).not.toThrow();
  });
});

describe('release —— /exit 解绑,收件箱回池子', () => {
  it('解绑后别人能领', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    r.claim('conv-1');
    r.release('conv-1');
    expect(r.forConversation('conv-1')).toBeNull();
    expect(r.claim('conv-2')!.name).toBe('a');
  });
});

describe('存储健壮性', () => {
  it('文件坏了当空表 —— 会话丢了能重绑,进程起不来才是事故', () => {
    fs.writeFileSync(path.join(dir, 'claude-app-inboxes-acct-1.json'), '{ 半个 json');
    expect(reg().list()).toEqual([]);
  });

  it('目录不存在会自己建(0700)', () => {
    const sub = path.join(dir, 'deep', 'er');
    const r = new InboxRegistry({ accountId: 'acct-1', dir: sub, now: () => clock });
    r.seed('a', '/inbox/a');
    expect(fs.existsSync(path.join(sub, 'claude-app-inboxes-acct-1.json'))).toBe(true);
  });

  it('写盘是临时文件 + rename,不会留半截 JSON', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('updatedAt 跟着注入时钟走', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    clock = 9_999;
    r.bindLocalId('a', 'x');
    expect(r.list()[0].updatedAt).toBe(9_999);
  });
});

describe('byName / byCwd', () => {
  it('按名字查', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    expect(r.byName('a')!.cwd).toBe('/inbox/a');
    expect(r.byName('zzz')).toBeNull();
  });

  it('按 cwd 查(cwd 是路由键,末尾斜杠不该错过)', () => {
    const r = reg();
    r.seed('a', '/inbox/a');
    expect(r.byCwd('/inbox/a/')!.name).toBe('a');
  });
});
