import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { FileSessionStore, deriveConversationId } from '../../v6/session-store.js';
import { userIdToSessionUUID } from '../../utils.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-session-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(opts: { accountId?: string; legacyPort?: string } = {}) {
  return new FileSessionStore({
    accountId: opts.accountId ?? 'acc-1',
    dir,
    legacyPort: opts.legacyPort ?? '19001',
  });
}

function readFileJson(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
}

describe('deriveConversationId', () => {
  it('是 sha256(accountId\\nuserId) 的前 32 hex', () => {
    const expected = createHash('sha256').update('acc-1\nuser-1').digest('hex').slice(0, 32);
    expect(deriveConversationId('acc-1', 'user-1')).toBe(expected);
    expect(deriveConversationId('acc-1', 'user-1')).toHaveLength(32);
  });

  it('换账号或换用户都换 id,但与端口无关', () => {
    const a = deriveConversationId('acc-1', 'user-1');
    expect(deriveConversationId('acc-2', 'user-1')).not.toBe(a);
    expect(deriveConversationId('acc-1', 'user-2')).not.toBe(a);
  });
});

describe('FileSessionStore — 基本读写', () => {
  it('未命中返回 null', () => {
    expect(store().get('nope')).toBeNull();
  });

  it('saveProviderSession 后 get 拿得到,且落到按 accountId 命名的文件', () => {
    const s = store();
    s.saveProviderSession('conv-1', 'codex', 'thread-abc');
    const b = s.get('conv-1')!;
    expect(b.providerSessionId).toBe('thread-abc');
    expect(b.agentType).toBe('codex');
    expect(b.generation).toBe(1);
    expect(b.conversationId).toBe('conv-1');

    expect(fs.existsSync(path.join(dir, 'sessions-acc-1.json'))).toBe(true);
    expect(readFileJson('sessions-acc-1.json').bindings['conv-1'].providerSessionId).toBe('thread-abc');
  });

  it('换进程(新实例)读得回来', () => {
    store().saveProviderSession('conv-1', 'codex', 'thread-abc');
    expect(store().get('conv-1')?.providerSessionId).toBe('thread-abc');
  });

  it('不同账号各写各的文件,互不串味', () => {
    store({ accountId: 'acc-1' }).saveProviderSession('conv-1', 'codex', 't1');
    store({ accountId: 'acc-2' }).saveProviderSession('conv-1', 'codex', 't2');
    expect(store({ accountId: 'acc-1' }).get('conv-1')?.providerSessionId).toBe('t1');
    expect(store({ accountId: 'acc-2' }).get('conv-1')?.providerSessionId).toBe('t2');
  });

  it('原子写:落盘后目录里不留临时文件', () => {
    const s = store();
    s.saveProviderSession('conv-1', 'codex', 't1');
    s.saveProviderSession('conv-2', 'codex', 't2');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('文件损坏当空处理,不抛异常,后续写入自愈', () => {
    fs.writeFileSync(path.join(dir, 'sessions-acc-1.json'), '{ this is not json');
    const s = store();
    expect(s.get('conv-1')).toBeNull();
    s.saveProviderSession('conv-1', 'codex', 't1');
    expect(readFileJson('sessions-acc-1.json').bindings['conv-1'].providerSessionId).toBe('t1');
  });
});

describe('FileSessionStore — touch / bump / drop', () => {
  it('touch 只刷新 updatedAt', () => {
    const s = store();
    s.saveProviderSession('conv-1', 'codex', 't1');
    const before = s.get('conv-1')!;
    s.touch('conv-1');
    const after = s.get('conv-1')!;
    expect(after.providerSessionId).toBe('t1');
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('touch 不存在的会话是 no-op', () => {
    const s = store();
    expect(() => s.touch('ghost')).not.toThrow();
    expect(s.get('ghost')).toBeNull();
  });

  it('bump 让 generation 递增并清空 providerSessionId,条目保留', () => {
    const s = store();
    s.saveProviderSession('conv-1', 'codex', 't1');
    s.bump('conv-1');
    const b = s.get('conv-1')!;
    expect(b.generation).toBe(2);
    expect(b.providerSessionId).toBe('');

    s.saveProviderSession('conv-1', 'codex', 't2');
    expect(s.get('conv-1')!.generation).toBe(2);
    s.bump('conv-1');
    expect(s.get('conv-1')!.generation).toBe(3);
  });

  it('bump 不存在的会话也建条目(generation 从 1 起)', () => {
    const s = store();
    s.bump('fresh');
    expect(s.get('fresh')).toMatchObject({ generation: 1, providerSessionId: '' });
  });

  it('drop 删掉条目', () => {
    const s = store();
    s.saveProviderSession('conv-1', 'codex', 't1');
    s.drop('conv-1');
    expect(s.get('conv-1')).toBeNull();
    expect(readFileJson('sessions-acc-1.json').bindings['conv-1']).toBeUndefined();
  });
});

describe('FileSessionStore — legacy codex-threads 迁移', () => {
  function seedLegacy(port: string, map: Record<string, string>): void {
    fs.writeFileSync(path.join(dir, `codex-threads-${port}.json`), JSON.stringify(map));
  }

  it('新表未命中时,从 legacy 端口文件按 userIdToSessionUUID(userId) 导入', () => {
    const userId = 'wx-user-1';
    seedLegacy('19001', { [userIdToSessionUUID(userId)]: 'legacy-thread-1' });

    const s = store();
    const conv = deriveConversationId('acc-1', userId);
    s.noteUser(conv, userId);

    const b = s.get(conv)!;
    expect(b.providerSessionId).toBe('legacy-thread-1');
    expect(b.agentType).toBe('codex');
    // 导入后必须落到新文件,不然下次重启还得再迁一遍
    expect(readFileJson('sessions-acc-1.json').bindings[conv].providerSessionId).toBe('legacy-thread-1');
  });

  it('没告诉 store 这个会话对应哪个 userId 就不迁移(避免瞎猜)', () => {
    const userId = 'wx-user-1';
    seedLegacy('19001', { [userIdToSessionUUID(userId)]: 'legacy-thread-1' });
    const conv = deriveConversationId('acc-1', userId);
    expect(store().get(conv)).toBeNull();
  });

  it('legacy 文件不存在 / 键不匹配 → 安静返回 null', () => {
    const s = store();
    s.noteUser('conv-x', 'nobody');
    expect(s.get('conv-x')).toBeNull();

    seedLegacy('19001', { 'other-key': 'th' });
    const s2 = store();
    s2.noteUser('conv-y', 'someone');
    expect(s2.get('conv-y')).toBeNull();
  });

  it('legacy 文件损坏不炸', () => {
    fs.writeFileSync(path.join(dir, 'codex-threads-19001.json'), 'not json');
    const s = store();
    s.noteUser('conv-x', 'u');
    expect(() => s.get('conv-x')).not.toThrow();
    expect(s.get('conv-x')).toBeNull();
  });

  it('drop 之后不会被 legacy 迁移复活(/exit 要真的关掉)', () => {
    const userId = 'wx-user-1';
    seedLegacy('19001', { [userIdToSessionUUID(userId)]: 'legacy-thread-1' });
    const s = store();
    const conv = deriveConversationId('acc-1', userId);
    s.noteUser(conv, userId);
    expect(s.get(conv)?.providerSessionId).toBe('legacy-thread-1');

    s.drop(conv);
    expect(s.get(conv)).toBeNull();
  });
});

describe('FileSessionStore — expireIdle', () => {
  it('清掉超时条目并返回 id 列表', () => {
    const s = store();
    s.saveProviderSession('old', 'codex', 't-old');
    s.saveProviderSession('fresh', 'codex', 't-fresh');

    // 把 old 的 updatedAt 手工推回一小时前
    const file = path.join(dir, 'sessions-acc-1.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data.bindings.old.updatedAt = Date.now() - 3_600_000;
    fs.writeFileSync(file, JSON.stringify(data));

    const s2 = store();
    expect(s2.expireIdle(60_000)).toEqual(['old']);
    expect(s2.get('old')).toBeNull();
    expect(s2.get('fresh')).not.toBeNull();
    expect(readFileJson('sessions-acc-1.json').bindings.old).toBeUndefined();
  });

  it('没有过期的返回空数组', () => {
    const s = store();
    s.saveProviderSession('conv-1', 'codex', 't1');
    expect(s.expireIdle(60_000)).toEqual([]);
  });

  it('maxIdleMs<=0 = 关闭清理', () => {
    const s = store();
    s.saveProviderSession('conv-1', 'codex', 't1');
    expect(s.expireIdle(0)).toEqual([]);
    expect(s.get('conv-1')).not.toBeNull();
  });
});
