/**
 * M1 · Gateway SQLite Store 与 CredentialStore（RED）
 *
 * 覆盖架构 §9 的持久化/幂等/游标契约与 §3.6 的完成门禁：
 * - 空库与"上一版 schema"都能原位 migrate（不是只会建空库）
 * - inbox receipt 与 cursor 同事务；异常整体回滚，不留半条
 * - duplicate receipt 明确定义为 cursor 仍推进（否则重放会把游标钉死）
 * - outbox pending→sent，重试复用原 messageId；重开只恢复 pending
 * - running turn 崩溃后标 interrupted，不自动重跑（架构 §9）
 * - channelSecret 经 0600 master key wrapping，DB 与持久对象都不含明文
 * - 权限不合格 fail-closed，且失败构造不留未关闭句柄
 * - 完整 assembly 在 expiresAt-1 可取、expiresAt 不可取且被原子清理（显式传 now，不依赖墙钟）
 *
 * 这里的 ID 用短字符串：store 不负责外部协议解析，UUIDv7 约束在 envelope parser 那层。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type TrustTier = 'chat-only' | 'sandbox-workspace' | 'repo-pr' | 'admin-bypass';
type PairingScope =
  | 'chat.send'
  | 'conversation.new'
  | 'conversation.stop'
  | 'conversation.resume'
  | 'artifact.read';

type AgentEndpoint = {
  id: string;
  runnerProfileId: string;
  workspacePolicyId: string;
  trustTier: TrustTier;
  status: 'active' | 'disabled';
};

type CursorRow = { lastCreatedAt: number; lastMessageId: string };

type ReceiptRow = {
  pairingId: string;
  messageId: string;
  status: 'received' | 'running' | 'completed' | 'rejected';
  receivedAt: number;
};

type OutboxRow = {
  messageId: string;
  pairingId: string;
  routeId: string;
  kind: string;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  createdAt: number;
  externalDeliveryId?: string;
};

type ConversationRow = {
  id: string;
  pairingId: string;
  principalId: string;
  generation: number;
};

type ProviderBindingRow = {
  conversationId: string;
  agentType: string;
  providerSessionId: string;
  generation: number;
};

type RunnerAssignmentRow = {
  endpointId: string;
  nodeId: string;
  leaseEpoch: number;
  leaseUntil: number;
};

type TurnRow = {
  turnId: string;
  conversationId: string;
  pairingId: string;
  messageId: string;
  status: 'running' | 'completed' | 'interrupted';
  startedAt: number;
};

type StoredChunkRow = {
  messageId: string;
  pairingId: string;
  routeId: string;
  chunkIndex: number;
  chunkCount: number;
  nonce: string;
  ciphertext: string;
  createdAt: number;
  expiresAt: number;
};

type GatewayTransaction = {
  upsertEndpoint(endpoint: AgentEndpoint): void;
  insertPrincipal(p: { id: string; displayName?: string; status: 'active' | 'disabled'; createdAt: number }): void;
  insertDevice(d: { id: string; principalId: string; label?: string; createdAt: number }): void;
  insertPairing(p: {
    id: string;
    principalId: string;
    deviceId: string;
    endpointId: string;
    routeId: string;
    scopes: PairingScope[];
    channelSecret: Uint8Array;
    keyVersion: number;
    createdAt: number;
  }): void;
  insertInboxReceipt(r: ReceiptRow): 'inserted' | 'duplicate';
  commitCursor(collection: string, cursor: CursorRow): void;
  saveAssetUpload(cacheKey: string, assetId: string, createdAt: number): void;
  insertOutbox(o: Omit<OutboxRow, 'status' | 'attempts' | 'externalDeliveryId'>): 'inserted' | 'duplicate';
  markOutboxSent(messageId: string, externalDeliveryId: string, sentAt: number): void;
  saveConversation(c: ConversationRow): void;
  bumpGeneration(conversationId: string): number;
  saveProviderBinding(b: ProviderBindingRow): void;
  saveRunnerAssignment(a: RunnerAssignmentRow): void;
  startTurn(t: Omit<TurnRow, 'status'>): void;
  saveChunk(c: StoredChunkRow): 'inserted' | 'duplicate' | 'conflict';
};

type GatewayStoreApi = {
  readonly schemaVersion: number;
  transaction<T>(fn: (tx: GatewayTransaction) => T): T;
  getEndpoint(id: string): AgentEndpoint | null;
  getPairing(id: string): { id: string; status: 'active' | 'revoked'; secretCiphertext: string } | null;
  getPairingSecret(id: string): Uint8Array | null;
  getReceipt(pairingId: string, messageId: string): ReceiptRow | null;
  getCursor(collection: string): CursorRow | null;
  getAssetUpload(cacheKey: string, now: number, maxAgeMs: number): string | null;
  getOutbox(messageId: string): OutboxRow | null;
  listPendingOutbox(): OutboxRow[];
  getConversation(id: string): ConversationRow | null;
  getProviderBinding(conversationId: string): ProviderBindingRow | null;
  getRunnerAssignment(endpointId: string): RunnerAssignmentRow | null;
  getTurn(turnId: string): TurnRow | null;
  recoverInterruptedTurns(now: number): TurnRow[];
  takeAssembly(messageId: string, now: number): StoredChunkRow[] | null;
  countChunks(messageId: string): number;
  countPrincipals(): number;
  countDevices(): number;
  countPairings(): number;
  close(): void;
};

type SqliteStoreModule = {
  openGatewayStore(options: { dbPath: string; masterKeyPath: string }): GatewayStoreApi;
  readonly GATEWAY_SCHEMA_VERSION: number;
  readonly MIGRATIONS: ReadonlyArray<{ version: number; sql: string }>;
};

type CredentialStoreApi = {
  wrap(plaintext: Uint8Array): string;
  unwrap(wrapped: string): Uint8Array;
  close(): void;
};

type CredentialStoreModule = {
  openCredentialStore(options: { masterKeyPath: string }): CredentialStoreApi;
};

type GatewayError = Error & { code: string; field?: string };

function lazyModule<T>(specifier: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = import(specifier) as Promise<T>;
    return cached;
  };
}

const loadStore = lazyModule<SqliteStoreModule>('../../gateway/state/sqlite-store.js');
const loadCredentials = lazyModule<CredentialStoreModule>('../../gateway/state/credential-store.js');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NOW = 1_760_000_000_000;

const ADMIN_ENDPOINT: AgentEndpoint = {
  id: 'aster-admin',
  runnerProfileId: 'local-729a',
  workspacePolicyId: 'admin-home',
  trustTier: 'admin-bypass',
  status: 'active',
};

let dir: string;
let dbPath: string;
let masterKeyPath: string;
const opened: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-store-'));
  dbPath = path.join(dir, 'gateway.db');
  masterKeyPath = path.join(dir, 'master.key');
});

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* 清理失败不该掩盖真正的断言失败 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function openStore(): Promise<GatewayStoreApi> {
  const mod = await loadStore();
  const store = mod.openGatewayStore({ dbPath, masterKeyPath });
  opened.push(store);
  return store;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** 直接读文件里的 `PRAGMA user_version`：store.schemaVersion 是编译期常量，证明不了库真的迁过。 */
function dbUserVersion(file: string): number {
  const db = new DatabaseSync(file);
  try {
    return Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>)['user_version']);
  } finally {
    db.close();
  }
}

function hasTable(file: string, name: string): boolean {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  } finally {
    db.close();
  }
}

async function schemaVersion(): Promise<number> {
  return (await loadStore()).GATEWAY_SCHEMA_VERSION;
}

/**
 * 只保留 DDL 语义再 hash：去掉 `--` 注释、空白归一。
 * 改缩进 / 改注释不该红（那不改变任何库的形状），改一个字的 DDL 必须红。
 */
function sha256OfSql(sql: string): string {
  const normalized = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

type MigrationLock = { migrations: Array<{ version: number; sha256: string }> };

function readMigrationLock(): MigrationLock {
  const file = fileURLToPath(new URL('../../gateway/state/migrations.lock.json', import.meta.url));
  return JSON.parse(fs.readFileSync(file, 'utf8')) as MigrationLock;
}

function captureThrow(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (e) {
    return e as GatewayError;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

function seedPairing(
  store: GatewayStoreApi,
  id: string,
  secret: Uint8Array,
): void {
  store.transaction((tx) => {
    tx.upsertEndpoint(ADMIN_ENDPOINT);
    tx.insertPrincipal({ id: `pri-${id}`, status: 'active', createdAt: NOW });
    tx.insertDevice({ id: `dev-${id}`, principalId: `pri-${id}`, createdAt: NOW });
    tx.insertPairing({
      id,
      principalId: `pri-${id}`,
      deviceId: `dev-${id}`,
      endpointId: ADMIN_ENDPOINT.id,
      routeId: `rt-${id}`,
      scopes: ['chat.send'],
      channelSecret: secret,
      keyVersion: 1,
      createdAt: NOW,
    });
  });
}

function chunkRow(messageId: string, chunkIndex: number, chunkCount: number, expiresAt: number): StoredChunkRow {
  return {
    messageId,
    pairingId: 'pair-1',
    routeId: 'rt-1',
    chunkIndex,
    chunkCount,
    nonce: randomBytes(12).toString('base64url'),
    ciphertext: randomBytes(64).toString('base64url'),
    createdAt: NOW,
    expiresAt,
  };
}

// ---------------------------------------------------------------------------

describe('M1 · schema 与 migration', () => {
  it('空库建到当前 schema 版本，重复打开幂等，文件权限 0600', async () => {
    const first = await openStore();
    const version = first.schemaVersion;
    expect(version).toBeGreaterThanOrEqual(1);
    first.transaction((tx) => tx.upsertEndpoint(ADMIN_ENDPOINT));
    first.close();

    // 重复 migrate 不炸、不清数据、版本不变
    const second = await openStore();
    expect(second.schemaVersion).toBe(version);
    expect(second.getEndpoint('aster-admin')).toEqual(ADMIN_ENDPOINT);
    second.close();

    const third = await openStore();
    expect(third.schemaVersion).toBe(version);
    expect(third.getEndpoint('aster-admin')?.trustTier).toBe('admin-bypass');

    expect(mode(dbPath)).toBe(0o600);
    expect(mode(masterKeyPath)).toBe(0o600);
  });

  it('上一版 schema 的库能原位 migrate，且旧数据保留', async () => {
    // 手工造一个 v1 库（PRAGMA user_version = 1）
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE endpoints (
        id TEXT PRIMARY KEY,
        runner_profile_id TEXT NOT NULL,
        workspace_policy_id TEXT NOT NULL,
        trust_tier TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO endpoints (id, runner_profile_id, workspace_policy_id, trust_tier, status)
      VALUES ('aster-admin', 'local-729a', 'admin-home', 'admin-bypass', 'active');
      PRAGMA user_version = 1;
    `);
    db.close();

    const store = await openStore();
    expect(store.schemaVersion).toBeGreaterThan(1);
    expect(store.getEndpoint('aster-admin')).toEqual(ADMIN_ENDPOINT);

    // migrate 之后新表可用
    store.transaction((tx) =>
      tx.commitCursor('agent_inbox_v1', { lastCreatedAt: NOW, lastMessageId: 'm-1' }),
    );
    expect(store.getCursor('agent_inbox_v1')).toEqual({ lastCreatedAt: NOW, lastMessageId: 'm-1' });
    store.close();

    // 再开一次不会重复跑 v1 migration
    const again = await openStore();
    expect(again.getEndpoint('aster-admin')).toEqual(ADMIN_ENDPOINT);
    expect(again.getCursor('agent_inbox_v1')?.lastMessageId).toBe('m-1');
  });

  it('已经在 v2 的老库能补出 asset_uploads —— 新表必须走新版本，不能塞回已发布的 migration', async () => {
    // 冻结的 v2 fixture：asset_uploads 被塞进 v2 之前，线上库真实长的样子。
    // 故意**不**从 MIGRATIONS 派生 —— 用 MIGRATIONS 造 fixture 的话，
    // "把 DDL 写回旧版本"这个 bug 会连 fixture 一起自愈，测试永远绿。
    // 只造断言用得到的那几张表：v2 之后的 migration 不会回头补 v2 的表，
    // 这正是本 case 要钉的语义（老库缺的东西只能由新版本补）。
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE endpoints (
        id TEXT PRIMARY KEY,
        runner_profile_id TEXT NOT NULL,
        workspace_policy_id TEXT NOT NULL,
        trust_tier TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE mailbox_cursors (
        collection TEXT PRIMARY KEY,
        last_created_at INTEGER NOT NULL,
        last_message_id TEXT NOT NULL
      );

      CREATE TABLE outbox_records (
        message_id TEXT PRIMARY KEY,
        pairing_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        external_delivery_id TEXT
      );

      INSERT INTO endpoints (id, runner_profile_id, workspace_policy_id, trust_tier, status)
      VALUES ('aster-admin', 'local-729a', 'admin-home', 'admin-bypass', 'active');
      INSERT INTO mailbox_cursors (collection, last_created_at, last_message_id)
      VALUES ('agent_inbox_v1', 1, 'm-old');

      PRAGMA user_version = 2;
    `);
    db.close();
    expect(hasTable(dbPath, 'asset_uploads')).toBe(false);

    const store = await openStore();

    // 出站附件上传前的那次缓存查询：老库上它抛 `no such table: asset_uploads`，
    // 于是每 30s 重投一次、永远失败。补出来之后它必须能读能写。
    expect(store.getAssetUpload('k-1', NOW, 60_000)).toBeNull();
    store.transaction((tx) => tx.saveAssetUpload('k-1', 'ast_1', NOW));
    expect(store.getAssetUpload('k-1', NOW, 60_000)).toBe('ast_1');

    // 老数据原样保留：这是补版本，不是重建库
    expect(store.getEndpoint('aster-admin')).toEqual(ADMIN_ENDPOINT);
    expect(store.getCursor('agent_inbox_v1')?.lastMessageId).toBe('m-old');
    store.close();

    const latest = await schemaVersion();
    expect(dbUserVersion(dbPath)).toBe(latest);
    expect(latest).toBeGreaterThanOrEqual(3);
  });

  it('被手工 CREATE TABLE 解围过的 v2 库也能收敛到 v3，不炸也不清数据', async () => {
    // 线上真实存在的中间态：为了让 daemon 当场能发图，人手在 v2 库上补了这张表，
    // 但 user_version 还停在 2。v3 用的是 IF NOT EXISTS ⇒ 补版本号即可，别把人家的数据推平。
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE endpoints (
        id TEXT PRIMARY KEY,
        runner_profile_id TEXT NOT NULL,
        workspace_policy_id TEXT NOT NULL,
        trust_tier TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE asset_uploads (
        cache_key TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      INSERT INTO endpoints (id, runner_profile_id, workspace_policy_id, trust_tier, status)
      VALUES ('aster-admin', 'local-729a', 'admin-home', 'admin-bypass', 'active');
      INSERT INTO asset_uploads (cache_key, asset_id, created_at) VALUES ('k-hand', 'ast_hand', ${NOW});

      PRAGMA user_version = 2;
    `);
    db.close();

    const store = await openStore();
    expect(store.getAssetUpload('k-hand', NOW, 60_000)).toBe('ast_hand'); // 手工期的缓存没被推平
    expect(store.getEndpoint('aster-admin')).toEqual(ADMIN_ENDPOINT);
    store.close();

    expect(dbUserVersion(dbPath)).toBe(await schemaVersion());
  });

  it('全新库一次建到最新版本，asset_uploads 当场可用', async () => {
    const store = await openStore();
    store.transaction((tx) => tx.saveAssetUpload('k-new', 'ast_new', NOW));
    expect(store.getAssetUpload('k-new', NOW, 60_000)).toBe('ast_new');
    const latest = await schemaVersion();
    expect(store.schemaVersion).toBe(latest);
    store.close();

    expect(dbUserVersion(dbPath)).toBe(latest);
    expect(hasTable(dbPath, 'asset_uploads')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('migration 不可变性契约', () => {
  it('已发布的 migration 的 SQL 一个字都不许改（改了就改 lock 文件，那会被人看见）', async () => {
    const mod = await loadStore();
    const actual = Object.fromEntries(mod.MIGRATIONS.map((m) => [String(m.version), sha256OfSql(m.sql)]));
    const locked = Object.fromEntries(readMigrationLock().migrations.map((m) => [String(m.version), m.sha256]));

    // 两个方向都要红：
    // - 旧版本 hash 变了 = 有人把 DDL 写回了已发布的 migration（老库永远跑不到，PR #5 就是这么炸的）
    // - 出现 lock 里没有的版本 = 追加了新 migration，把它登记进 lock 才算数
    expect(actual).toEqual(locked);
  });

  it('版本严格递增，且 GATEWAY_SCHEMA_VERSION 就是最后一条', async () => {
    const mod = await loadStore();
    const versions = mod.MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(mod.GATEWAY_SCHEMA_VERSION).toBe(versions[versions.length - 1]);
  });
});

// ---------------------------------------------------------------------------

describe('M1 · inbox receipt 与 cursor', () => {
  it('receipt 与 cursor 在同一事务提交；事务内异常整体回滚，不留半条', async () => {
    const store = await openStore();

    store.transaction((tx) => {
      expect(tx.insertInboxReceipt({ pairingId: 'p1', messageId: 'm1', status: 'received', receivedAt: NOW })).toBe(
        'inserted',
      );
      tx.commitCursor('agent_inbox_v1', { lastCreatedAt: NOW, lastMessageId: 'm1' });
    });
    expect(store.getReceipt('p1', 'm1')?.status).toBe('received');
    expect(store.getCursor('agent_inbox_v1')).toEqual({ lastCreatedAt: NOW, lastMessageId: 'm1' });

    const err = captureThrow(() =>
      store.transaction((tx) => {
        tx.insertInboxReceipt({ pairingId: 'p1', messageId: 'm2', status: 'received', receivedAt: NOW + 1 });
        tx.commitCursor('agent_inbox_v1', { lastCreatedAt: NOW + 1, lastMessageId: 'm2' });
        throw new Error('boom');
      }),
    );
    expect(err.message).toBe('boom');
    expect(store.getReceipt('p1', 'm2')).toBeNull();
    expect(store.getCursor('agent_inbox_v1')).toEqual({ lastCreatedAt: NOW, lastMessageId: 'm1' });
  });

  it('重复 receipt 返回 duplicate 但游标照常推进；不同 pairing 的同 messageId 互不冲突', async () => {
    const store = await openStore();
    store.transaction((tx) => {
      tx.insertInboxReceipt({ pairingId: 'p1', messageId: 'm1', status: 'received', receivedAt: NOW });
      tx.commitCursor('agent_inbox_v1', { lastCreatedAt: NOW, lastMessageId: 'm1' });
    });

    const outcome = store.transaction((tx) => {
      const r = tx.insertInboxReceipt({ pairingId: 'p1', messageId: 'm1', status: 'received', receivedAt: NOW + 5 });
      // 重放不能把游标钉死，否则永远卡在同一页
      tx.commitCursor('agent_inbox_v1', { lastCreatedAt: NOW + 5, lastMessageId: 'm1' });
      return r;
    });
    expect(outcome).toBe('duplicate');
    expect(store.getCursor('agent_inbox_v1')).toEqual({ lastCreatedAt: NOW + 5, lastMessageId: 'm1' });
    // 原 receipt 不被覆盖
    expect(store.getReceipt('p1', 'm1')?.receivedAt).toBe(NOW);

    // 两个 pairing 各自的命名空间
    const other = store.transaction((tx) =>
      tx.insertInboxReceipt({ pairingId: 'p2', messageId: 'm1', status: 'received', receivedAt: NOW + 9 }),
    );
    expect(other).toBe('inserted');
    expect(store.getReceipt('p2', 'm1')?.receivedAt).toBe(NOW + 9);
  });
});

// ---------------------------------------------------------------------------

describe('M1 · outbox', () => {
  it('pending→sent；重试复用原 messageId，不产生第二条', async () => {
    const store = await openStore();
    const rec = { messageId: 'out-1', pairingId: 'p1', routeId: 'rt-1', kind: 'final', payload: 'ct', createdAt: NOW };

    expect(store.transaction((tx) => tx.insertOutbox(rec))).toBe('inserted');
    expect(store.listPendingOutbox().map((r) => r.messageId)).toEqual(['out-1']);

    // 重试：同 messageId 再投一次，仍是同一条记录
    expect(store.transaction((tx) => tx.insertOutbox({ ...rec, payload: 'ct-retry' }))).toBe('duplicate');
    const pending = store.listPendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0].messageId).toBe('out-1');
    expect(pending[0].payload).toBe('ct');

    store.transaction((tx) => tx.markOutboxSent('out-1', 'waku-row-9', NOW + 100));
    expect(store.getOutbox('out-1')?.status).toBe('sent');
    expect(store.getOutbox('out-1')?.externalDeliveryId).toBe('waku-row-9');
    expect(store.listPendingOutbox()).toEqual([]);
  });

  it('重开后只恢复 pending，sent 不再重投', async () => {
    const store = await openStore();
    store.transaction((tx) => {
      tx.insertOutbox({ messageId: 'out-1', pairingId: 'p1', routeId: 'rt-1', kind: 'final', payload: 'a', createdAt: NOW });
      tx.insertOutbox({ messageId: 'out-2', pairingId: 'p1', routeId: 'rt-1', kind: 'final', payload: 'b', createdAt: NOW + 1 });
      tx.markOutboxSent('out-2', 'waku-row-2', NOW + 2);
    });
    store.close();

    const reopened = await openStore();
    const pending = reopened.listPendingOutbox();
    expect(pending.map((r) => r.messageId)).toEqual(['out-1']);
    expect(reopened.getOutbox('out-2')?.status).toBe('sent');
  });
});

// ---------------------------------------------------------------------------

describe('M1 · conversation / runner / turn 状态', () => {
  it('generation、provider binding 与 runner assignment 都能跨重开恢复', async () => {
    const store = await openStore();
    store.transaction((tx) => {
      tx.upsertEndpoint(ADMIN_ENDPOINT);
      tx.saveConversation({ id: 'conv-1', pairingId: 'p1', principalId: 'pri-1', generation: 1 });
      tx.saveProviderBinding({
        conversationId: 'conv-1',
        agentType: 'codex',
        providerSessionId: 'thread-abc',
        generation: 1,
      });
      tx.saveRunnerAssignment({ endpointId: 'aster-admin', nodeId: '729a', leaseEpoch: 3, leaseUntil: NOW + 60_000 });
    });

    const bumped = store.transaction((tx) => tx.bumpGeneration('conv-1'));
    expect(bumped).toBe(2);
    store.close();

    const reopened = await openStore();
    expect(reopened.getConversation('conv-1')?.generation).toBe(2);
    expect(reopened.getProviderBinding('conv-1')?.providerSessionId).toBe('thread-abc');
    expect(reopened.getRunnerAssignment('aster-admin')).toEqual({
      endpointId: 'aster-admin',
      nodeId: '729a',
      leaseEpoch: 3,
      leaseUntil: NOW + 60_000,
    });
  });

  it('崩溃时 running 的 turn 重开后标 interrupted，且不会被自动重跑', async () => {
    const store = await openStore();
    store.transaction((tx) => {
      tx.startTurn({ turnId: 't-1', conversationId: 'conv-1', pairingId: 'p1', messageId: 'm-1', startedAt: NOW });
      tx.startTurn({ turnId: 't-2', conversationId: 'conv-2', pairingId: 'p1', messageId: 'm-2', startedAt: NOW + 1 });
    });
    expect(store.getTurn('t-1')?.status).toBe('running');
    store.close(); // 模拟 daemon 被强杀

    const reopened = await openStore();
    const recovered = reopened.recoverInterruptedTurns(NOW + 5_000);
    expect(recovered.map((t) => t.turnId).sort()).toEqual(['t-1', 't-2']);
    expect(reopened.getTurn('t-1')?.status).toBe('interrupted');
    expect(reopened.getTurn('t-2')?.status).toBe('interrupted');

    // 幂等：第二次不再返回，避免"重启就重跑一遍可能改过代码的任务"
    expect(reopened.recoverInterruptedTurns(NOW + 6_000)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('M1 · chunk assembly 过期', () => {
  it('完整 assembly 在 expiresAt-1 可取（按 index 有序），到 expiresAt 不产出并被原子清理', async () => {
    const store = await openStore();
    const expiresAt = NOW + 300_000;

    store.transaction((tx) => {
      expect(tx.saveChunk(chunkRow('m-ok', 1, 2, expiresAt))).toBe('inserted');
      expect(tx.saveChunk(chunkRow('m-ok', 0, 2, expiresAt))).toBe('inserted');
      tx.saveChunk(chunkRow('m-late', 0, 2, expiresAt));
      tx.saveChunk(chunkRow('m-late', 1, 2, expiresAt));
      tx.saveChunk(chunkRow('m-partial', 0, 2, expiresAt));
    });

    // 未到期的完整 assembly：按 chunkIndex 有序返回，并被消费掉
    const taken = store.takeAssembly('m-ok', expiresAt - 1);
    expect(taken?.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect(store.countChunks('m-ok')).toBe(0);

    // 到期点即 fail-closed：即使块齐了也不产出，且持久 assembly 被原子清理
    expect(store.takeAssembly('m-late', expiresAt)).toBeNull();
    expect(store.countChunks('m-late')).toBe(0);

    // 不完整的 assembly 在有效期内只是"还没齐"，不该被当成过期清掉
    expect(store.takeAssembly('m-partial', expiresAt - 1)).toBeNull();
    expect(store.countChunks('m-partial')).toBe(1);
    expect(store.takeAssembly('m-partial', expiresAt + 1)).toBeNull();
    expect(store.countChunks('m-partial')).toBe(0);
  });

  it('同块重复写入是 duplicate，内容冲突是 conflict，不静默覆盖', async () => {
    const store = await openStore();
    const expiresAt = NOW + 300_000;
    const c0 = chunkRow('m-1', 0, 2, expiresAt);

    store.transaction((tx) => {
      expect(tx.saveChunk(c0)).toBe('inserted');
      expect(tx.saveChunk({ ...c0 })).toBe('duplicate');
      expect(tx.saveChunk({ ...c0, ciphertext: randomBytes(64).toString('base64url') })).toBe('conflict');
      expect(tx.saveChunk({ ...c0, chunkIndex: 1, chunkCount: 3 })).toBe('conflict');
    });
    expect(store.countChunks('m-1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('M1 · CredentialStore 与 master-key wrapping', () => {
  it('channelSecret 经 master key 加密落库：DB 与持久对象都没有明文，重开可解', async () => {
    const secret = randomBytes(32);
    const store = await openStore();
    seedPairing(store, 'pair-1', secret);

    const row = store.getPairing('pair-1');
    expect(row?.secretCiphertext).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(hex(secret));
    expect(JSON.stringify(row)).not.toContain(Buffer.from(secret).toString('base64url'));
    store.close();

    const dbBytes = fs.readFileSync(dbPath);
    expect(dbBytes.includes(Buffer.from(secret))).toBe(false);
    expect(dbBytes.includes(Buffer.from(hex(secret), 'utf8'))).toBe(false);
    expect(fs.readFileSync(masterKeyPath).includes(Buffer.from(secret))).toBe(false);

    const reopened = await openStore();
    expect(hex(reopened.getPairingSecret('pair-1') ?? new Uint8Array())).toBe(hex(secret));
    expect(reopened.getPairingSecret('missing')).toBeNull();
  });

  it('master key 文件权限不是 0600 时 fail-closed，且失败构造不留未关闭实例', async () => {
    const mod = await loadStore();
    fs.writeFileSync(masterKeyPath, randomBytes(32));
    fs.chmodSync(masterKeyPath, 0o644);

    let created: GatewayStoreApi | undefined = undefined;
    let error: GatewayError | undefined = undefined;
    try {
      created = mod.openGatewayStore({ dbPath, masterKeyPath });
    } catch (e) {
      error = e as GatewayError;
    } finally {
      if (created) created.close();
    }
    expect(error?.code).toBe('insecure_credential_permissions');
    expect(created).toBeUndefined();

    // 权限修好后可以正常打开
    fs.chmodSync(masterKeyPath, 0o600);
    const store = await openStore();
    expect(store.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('CredentialStore：wrap 每次不同、可跨实例 unwrap、密文被改就拒绝', async () => {
    const mod = await loadCredentials();
    const cs = mod.openCredentialStore({ masterKeyPath });
    opened.push(cs);
    expect(mode(masterKeyPath)).toBe(0o600);

    const plain = randomBytes(32);
    const w1 = cs.wrap(plain);
    const w2 = cs.wrap(plain);
    expect(w1).not.toBe(w2); // 每次独立 nonce
    expect(w1).not.toContain(Buffer.from(plain).toString('base64url'));
    expect(hex(cs.unwrap(w1))).toBe(hex(plain));
    cs.close();

    // 同一个 master key 的另一个实例能解开（重启后仍可用）
    const cs2 = mod.openCredentialStore({ masterKeyPath });
    opened.push(cs2);
    expect(hex(cs2.unwrap(w2))).toBe(hex(plain));

    const bytes = Buffer.from(w1, 'base64url');
    bytes[bytes.length - 1] ^= 0x01;
    expect(captureThrow(() => cs2.unwrap(bytes.toString('base64url'))).code).toBe('credential_auth_failed');

    // 换一把 master key 就解不开
    const otherKeyPath = path.join(dir, 'other.key');
    fs.writeFileSync(otherKeyPath, randomBytes(32), { mode: 0o600 });
    fs.chmodSync(otherKeyPath, 0o600);
    const cs3 = mod.openCredentialStore({ masterKeyPath: otherKeyPath });
    opened.push(cs3);
    expect(captureThrow(() => cs3.unwrap(w1)).code).toBe('credential_auth_failed');
  });
});
