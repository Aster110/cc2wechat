/**
 * M2 · WakuDataClient（RED）
 *
 * 冻结对象：任务书 §4.2 的 `insert/query/delete/upsert、Retry-After、错误分类`。
 *
 * 这一层是 gateway 唯一接触 Waku REST DTO 的地方（架构 §3 硬边界 1），所以它必须把
 * 平台的真实形状**吃干净**，不能把 `detail.code` / 摊平行 / 429 的两种含义漏给上层：
 *
 * - 请求：POST `{apiBaseUrl}/content-runtime/data/{collection}/{verb}`，collection 走路径不进 body；
 *   headers 必须带 `Authorization: Bearer`、`Origin`（bootstrap 钉的那个）、`X-Runtime-Session-Id`。
 * - 响应行是**摊平**的（`{docId, createdAt, updatedAt, owner, ...doc, key?}`），client 负责归一成
 *   `{...meta, doc}`——否则上层每次都要自己猜哪个键是业务字段。
 * - 错误体是 `{"detail": ...}`，detail 可能是 **对象**（datastore_* / capability denied）也可能是
 *   **字符串**（401 `invalid or expired token`、403 audience/origin）。两种都得能分类。
 * - 429 有两种：`datastore_rate_limited`（带 Retry-After，可退避）与 `datastore_quota_exceeded`
 *   （**不带** Retry-After，退避没用，要人清行）。把它们混成一类 = 无限空转。
 * - 写请求的网络失败必须是 `unknown` 而不是 `retryable`：服务端可能已经落库了，
 *   盲重发会在 append_only 集合里造重复行（本文件用 applyWrite 故障构造这个真实场景）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  COLLECTIONS,
  FakeWakuServer,
  MAILBOX_FIELDS,
  PLATFORM,
  QUERY_OPS,
  RESERVED_FIELDS,
  captureAsync,
  lazyModule,
  type FetchLike,
  type Json,
} from './fake-waku.js';

// ---------------------------------------------------------------------------
// 测试侧契约（无 any；动态 import 只为让尚未实现的模块先 RED）
// ---------------------------------------------------------------------------

/** 传输层接缝与真 fetch 结构兼容——不是只为 fake 量身定做的形状。 */
const _fetchImplIsRealFetchCompatible: FetchLike = globalThis.fetch;

type WakuErrorClass = 'retryable' | 'permanent' | 'unknown' | 'auth' | 'rate-limited';
type WakuVerb = 'insert' | 'upsert' | 'query' | 'delete';

type WakuDataError = Error & {
  readonly name: 'WakuDataError';
  readonly classification: WakuErrorClass;
  /** 平台 `detail.code`（datastore_* / content_runtime_*）或客户端自有 `waku_*`。 */
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly verb: WakuVerb;
  readonly collection: string;
  readonly field?: string;
};

type WakuRow = {
  docId: string;
  createdAt: number;
  updatedAt: number;
  owner: { displayName: string; isMe: boolean };
  key?: string;
  /** 业务字段——元数据已被剥离到同级，不混在这里。 */
  doc: Record<string, Json>;
};

type WakuPage = { rows: WakuRow[]; nextCursor: string | null; hasMore: boolean };

type WakuFilter = { field: string; op: string; value: Json };
type WakuQueryParams = {
  filter?: WakuFilter[];
  sort?: string | [string, 'asc' | 'desc'];
  limit?: number;
  cursor?: string;
};

type RuntimeCredentials = {
  token: string;
  sessionId: string;
  apiBaseUrl: string;
  origin: string;
  expiresAt: number;
  capabilities: readonly string[];
};

type CredentialSeam = {
  current(): Promise<RuntimeCredentials>;
  refresh(): Promise<void>;
};

type WakuDataClientApi = {
  insert(collection: string, doc: Record<string, Json>): Promise<WakuRow>;
  upsert(collection: string, key: string, doc: Record<string, Json>): Promise<WakuRow>;
  query(collection: string, params: WakuQueryParams): Promise<WakuPage>;
  delete(collection: string, target: { docId: string } | { key: string }): Promise<{ ok: true }>;
};

type WakuDataClientOptions = {
  credentials: CredentialSeam;
  fetchImpl: FetchLike;
  now: () => number;
  /** 429 既无 Retry-After header 也无 retry_after_sec 时的兜底。 */
  defaultRetryAfterMs?: number;
};

type DataClientModule = {
  createWakuDataClient(options: WakuDataClientOptions): WakuDataClientApi;
  WAKU_QUERY_OPS: readonly string[];
  WAKU_QUERY_PAGE_LIMIT: number;
  WAKU_DOC_MAX_BYTES: number;
  WAKU_JSON_FIELD_MAX_BYTES: number;
  WAKU_RESERVED_FIELDS: readonly string[];
};

const loadClient = lazyModule<DataClientModule>('../../gateway/channels/waku/data-client.js');

function asWakuError(e: unknown): WakuDataError {
  return e as WakuDataError;
}

// ---------------------------------------------------------------------------
// Fixture（secret 随机生成，不写死在常量里）
// ---------------------------------------------------------------------------

const API_BASE = 'https://aicap.example.test/api';
const ORIGIN = 'http://127.0.0.1:47311';
const DAEMON_USER = 'usr_daemon';
const PLAYER_USER = 'usr_player';
const T0 = 1_760_000_000_000;

function freshToken(): string {
  return `rt_${randomBytes(24).toString('base64url')}`;
}

class StubCredentials implements CredentialSeam {
  refreshCalls = 0;
  private state: RuntimeCredentials;
  private readonly onRefresh: (() => RuntimeCredentials) | null;

  constructor(state: RuntimeCredentials, onRefresh?: () => RuntimeCredentials) {
    this.state = state;
    this.onRefresh = onRefresh ?? null;
  }

  current(): Promise<RuntimeCredentials> {
    return Promise.resolve(this.state);
  }

  refresh(): Promise<void> {
    this.refreshCalls += 1;
    if (!this.onRefresh) return Promise.reject(new Error('mint command failed'));
    this.state = this.onRefresh();
    return Promise.resolve();
  }
}

let clock = T0;
let server: FakeWakuServer;
let token: string;
let sessionId: string;
let credentials: StubCredentials;

function chunkDoc(overrides: Partial<Record<string, Json>> = {}): Record<string, Json> {
  return {
    protocolVersion: 1,
    routeId: 'rt-alpha',
    messageId: '0198f4c1-1111-7000-8000-aaaaaaaaaaaa',
    kind: 'turn',
    expiresAt: T0 + 600_000,
    chunkIndex: 0,
    chunkCount: 1,
    keyVersion: 1,
    nonce: randomBytes(12).toString('base64url'),
    payload: { ciphertext: randomBytes(48).toString('base64url') },
    ...overrides,
  };
}

function makeClient(mod: DataClientModule): WakuDataClientApi {
  return mod.createWakuDataClient({
    credentials,
    fetchImpl: server.fetch,
    now: () => clock,
  });
}

beforeEach(() => {
  clock = T0;
  token = freshToken();
  sessionId = `rts_${randomBytes(8).toString('hex')}`;
  server = new FakeWakuServer({
    apiBaseUrl: API_BASE,
    origin: ORIGIN,
    userId: DAEMON_USER,
    now: () => clock,
    env: 'draft',
  });
  server.defineMailboxCollections();
  server.issueToken({ token, sessionId, expiresAt: T0 + 3_600_000 });
  credentials = new StubCredentials({
    token,
    sessionId,
    apiBaseUrl: API_BASE,
    origin: ORIGIN,
    expiresAt: T0 + 3_600_000,
    capabilities: ['datastore.read', 'datastore.write'],
  });
});

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

describe('M2 · WakuDataClient 请求形状', () => {
  it('insert 打到 /content-runtime/data/{collection}/insert，collection 只走路径不进 body', async () => {
    const client = makeClient(await loadClient());
    await client.insert(COLLECTIONS.outbox, chunkDoc());

    const [req] = server.callsOf('insert', COLLECTIONS.outbox);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API_BASE}/content-runtime/data/${COLLECTIONS.outbox}/insert`);
    expect(Object.keys(req.body).sort()).toEqual(['doc']);
    expect(req.body['collection']).toBeUndefined();
  });

  it('每个请求都带 Bearer token、bootstrap 钉的 Origin 与 X-Runtime-Session-Id', async () => {
    const client = makeClient(await loadClient());
    await client.insert(COLLECTIONS.outbox, chunkDoc());

    const [req] = server.callsOf('insert', COLLECTIONS.outbox);
    expect(req.headers['authorization']).toBe(`Bearer ${token}`);
    expect(req.headers['origin']).toBe(ORIGIN);
    // session pin：缺了它服务端会回退"该 user 最近 active session"，多 session 下串 env/content。
    expect(req.headers['x-runtime-session-id']).toBe(sessionId);
    expect(req.headers['content-type']).toContain('application/json');
  });

  it('把摊平的行归一成 {docId, createdAt, updatedAt, owner, doc}，业务字段全在 doc 下', async () => {
    const client = makeClient(await loadClient());
    const doc = chunkDoc();
    const row = await client.insert(COLLECTIONS.outbox, doc);

    expect(row.docId).toMatch(/^dsr_/);
    expect(row.createdAt).toBe(T0);
    expect(row.owner.isMe).toBe(true);
    expect(row.doc['routeId']).toBe('rt-alpha');
    expect(row.doc['payload']).toEqual(doc['payload']);
    // 元数据不许混进 doc，否则上层没法把 doc 直接当 MailboxChunk 用。
    for (const meta of ['docId', 'createdAt', 'updatedAt', 'owner', 'key']) {
      expect(Object.keys(row.doc)).not.toContain(meta);
    }
  });

  it('query 交出 rows/nextCursor/hasMore，且按 cursor 翻页拿到剩余行不重不漏', async () => {
    for (let i = 0; i < 5; i += 1) {
      server.seed(COLLECTIONS.inbox, {
        owner: PLAYER_USER,
        createdAt: T0 + i,
        doc: chunkDoc({ messageId: `0198f4c1-1111-7000-8000-00000000000${i}` }),
      });
    }
    const client = makeClient(await loadClient());
    const page1 = await client.query(COLLECTIONS.inbox, { sort: 'createdAt', limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(typeof page1.nextCursor).toBe('string');

    const page2 = await client.query(COLLECTIONS.inbox, {
      sort: 'createdAt',
      limit: 2,
      cursor: page1.nextCursor ?? '',
    });
    const ids = [...page1.rows, ...page2.rows].map((r) => r.doc['messageId']);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual([...ids].sort());
  });

  it('边界：1 条与恰好整页——刚好取完时 hasMore=false 且 nextCursor=null', async () => {
    server.seed(COLLECTIONS.inbox, { owner: PLAYER_USER, createdAt: T0, doc: chunkDoc() });
    const client = makeClient(await loadClient());

    const one = await client.query(COLLECTIONS.inbox, { sort: 'createdAt', limit: 1 });
    expect(one.rows).toHaveLength(1);
    expect(one.hasMore).toBe(false);
    expect(one.nextCursor).toBeNull();

    for (let i = 1; i < 100; i += 1) {
      server.seed(COLLECTIONS.inbox, {
        owner: PLAYER_USER,
        createdAt: T0 + i,
        doc: chunkDoc({ chunkIndex: 0 }),
      });
    }
    const full = await client.query(COLLECTIONS.inbox, { sort: 'createdAt', limit: PLATFORM.QUERY_PAGE_LIMIT });
    expect(full.rows).toHaveLength(100);
    expect(full.hasMore).toBe(false);
    expect(full.nextCursor).toBeNull();
  });

  it('upsert 按 key 覆盖：重复 upsert 行数不涨、docId 不变（status 心跳靠这个不刷屏）', async () => {
    const client = makeClient(await loadClient());
    const first = await client.upsert(COLLECTIONS.status, 'rt-alpha', chunkDoc({ kind: 'progress' }));
    clock += 1000;
    const second = await client.upsert(COLLECTIONS.status, 'rt-alpha', chunkDoc({ kind: 'progress' }));

    expect(second.docId).toBe(first.docId);
    expect(server.rowCount(COLLECTIONS.status)).toBe(1);
    expect(second.updatedAt).toBeGreaterThan(second.createdAt);
  });

  it('delete 自己的行返回 {ok:true} 并真的少一行', async () => {
    const client = makeClient(await loadClient());
    const row = await client.insert(COLLECTIONS.outbox, chunkDoc());
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(1);

    const result = await client.delete(COLLECTIONS.outbox, { docId: row.docId });
    expect(result).toEqual({ ok: true });
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(0);
  });

  it('导出的平台常量与真源一致（改了后端就该在这里红）', async () => {
    const mod = await loadClient();
    expect([...mod.WAKU_QUERY_OPS].sort()).toEqual([...QUERY_OPS].sort());
    expect(mod.WAKU_QUERY_PAGE_LIMIT).toBe(PLATFORM.QUERY_PAGE_LIMIT);
    expect(mod.WAKU_DOC_MAX_BYTES).toBe(PLATFORM.DOC_MAX_BYTES);
    expect(mod.WAKU_JSON_FIELD_MAX_BYTES).toBe(PLATFORM.JSON_FIELD_MAX_BYTES);
    expect([...mod.WAKU_RESERVED_FIELDS].sort()).toEqual([...RESERVED_FIELDS].sort());
  });
});

// ---------------------------------------------------------------------------
// 429：两种完全不同的 429
// ---------------------------------------------------------------------------

describe('M2 · WakuDataClient 限速与配额', () => {
  it('429 datastore_rate_limited → rate-limited 分类，Retry-After 秒转毫秒', async () => {
    server.enqueueFault({
      kind: 'status',
      status: 429,
      body: { detail: { code: 'datastore_rate_limited', message: 'too many datastore requests; retry shortly', retry_after_sec: 10 } },
      headers: { 'Retry-After': '10' },
    });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.insert(COLLECTIONS.outbox, chunkDoc())));

    expect(err.classification).toBe('rate-limited');
    expect(err.code).toBe('datastore_rate_limited');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(10_000);
  });

  it('真限速闸（连续写打满 writePerMin）也走同一条分类路径', async () => {
    server = new FakeWakuServer({
      apiBaseUrl: API_BASE,
      origin: ORIGIN,
      userId: DAEMON_USER,
      now: () => clock,
      env: 'draft',
      writePerMin: 3,
    });
    server.defineMailboxCollections();
    server.issueToken({ token, sessionId, expiresAt: T0 + 3_600_000 });

    const client = makeClient(await loadClient());
    for (let i = 0; i < 3; i += 1) await client.insert(COLLECTIONS.outbox, chunkDoc());
    const err = asWakuError(await captureAsync(() => client.insert(COLLECTIONS.outbox, chunkDoc())));

    expect(err.classification).toBe('rate-limited');
    expect(err.retryAfterMs).toBe(PLATFORM.RATE_LIMIT_RETRY_AFTER_SEC * 1000);
    // delete 也计写——预算表里它不是免费的。
    expect(server.usage().writes).toBe(3);
  });

  it('Retry-After header 缺失时回落 detail.retry_after_sec（detail 是摊平的，不在 details 下）', async () => {
    server.enqueueFault({
      kind: 'status',
      status: 429,
      body: { detail: { code: 'datastore_rate_limited', message: 'slow down', retry_after_sec: 7 } },
    });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));
    expect(err.retryAfterMs).toBe(7000);
  });

  it('Retry-After 是垃圾/HTTP-date 时回落默认值，绝不产出 NaN 或 0', async () => {
    server.enqueueFault({
      kind: 'status',
      status: 429,
      body: { detail: { code: 'datastore_rate_limited', message: 'slow down' } },
      headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));
    expect(Number.isFinite(err.retryAfterMs)).toBe(true);
    expect(err.retryAfterMs).toBeGreaterThan(0);
  });

  it('429 datastore_quota_exceeded 不是限速：permanent + 无 retryAfterMs（退避解不了行数满）', async () => {
    server = new FakeWakuServer({
      apiBaseUrl: API_BASE,
      origin: ORIGIN,
      userId: DAEMON_USER,
      now: () => clock,
      env: 'draft',
      rowsPerOwnerCollection: 1,
    });
    server.defineMailboxCollections();
    server.issueToken({ token, sessionId, expiresAt: T0 + 3_600_000 });

    const client = makeClient(await loadClient());
    await client.insert(COLLECTIONS.outbox, chunkDoc());
    const err = asWakuError(await captureAsync(() => client.insert(COLLECTIONS.outbox, chunkDoc())));

    expect(err.status).toBe(429);
    expect(err.code).toBe('datastore_quota_exceeded');
    expect(err.classification).toBe('permanent');
    expect(err.retryAfterMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 401 / 403 / 404 / 400
// ---------------------------------------------------------------------------

describe('M2 · WakuDataClient 鉴权与权限错误', () => {
  it('401 触发恰好一次 refresh 并重放原请求；成功后不再刷新', async () => {
    const nextToken = freshToken();
    const nextSession = `rts_${randomBytes(8).toString('hex')}`;
    credentials = new StubCredentials(
      { token, sessionId, apiBaseUrl: API_BASE, origin: ORIGIN, expiresAt: T0 + 1000, capabilities: ['datastore.read', 'datastore.write'] },
      () => {
        server.issueToken({ token: nextToken, sessionId: nextSession, expiresAt: T0 + 3_600_000 });
        return {
          token: nextToken,
          sessionId: nextSession,
          apiBaseUrl: API_BASE,
          origin: ORIGIN,
          expiresAt: T0 + 3_600_000,
          capabilities: ['datastore.read', 'datastore.write'],
        };
      },
    );
    server.revokeToken(token);

    const client = makeClient(await loadClient());
    const row = await client.insert(COLLECTIONS.outbox, chunkDoc());

    expect(row.docId).toMatch(/^dsr_/);
    expect(credentials.refreshCalls).toBe(1);
    expect(server.callsOf('insert', COLLECTIONS.outbox)).toHaveLength(2);
    expect(server.callsOf('insert', COLLECTIONS.outbox)[1].headers['authorization']).toBe(`Bearer ${nextToken}`);
    expect(server.callsOf('insert', COLLECTIONS.outbox)[1].headers['x-runtime-session-id']).toBe(nextSession);
  });

  it('刷新后仍 401 → 抛 auth 且只刷新一次（不循环刷新）', async () => {
    credentials = new StubCredentials(
      { token, sessionId, apiBaseUrl: API_BASE, origin: ORIGIN, expiresAt: T0 + 1000, capabilities: ['datastore.read', 'datastore.write'] },
      () => ({ token, sessionId, apiBaseUrl: API_BASE, origin: ORIGIN, expiresAt: T0 + 1000, capabilities: ['datastore.read', 'datastore.write'] }),
    );
    server.revokeToken(token);

    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));

    expect(err.classification).toBe('auth');
    expect(credentials.refreshCalls).toBe(1);
    expect(server.callsOf('query', COLLECTIONS.inbox)).toHaveLength(2);
  });

  it('refresh 本身失败时抛 auth，且错误里不带 mint 细节以外的凭证', async () => {
    credentials = new StubCredentials({
      token,
      sessionId,
      apiBaseUrl: API_BASE,
      origin: ORIGIN,
      expiresAt: T0 + 1000,
      capabilities: ['datastore.read', 'datastore.write'],
    });
    server.revokeToken(token);

    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));

    expect(err.classification).toBe('auth');
    expect(credentials.refreshCalls).toBe(1);
    expect(JSON.stringify(err)).not.toContain(token);
    expect(String(err.message)).not.toContain(token);
  });

  it('401 的 detail 是字符串而非对象，分类不能因此炸掉', async () => {
    server.enqueueFault({ kind: 'status', status: 401, body: { detail: 'invalid or expired token' } });
    credentials = new StubCredentials({
      token,
      sessionId,
      apiBaseUrl: API_BASE,
      origin: ORIGIN,
      expiresAt: T0 + 3_600_000,
      capabilities: ['datastore.read', 'datastore.write'],
    });

    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));
    expect(err.classification).toBe('auth');
    expect(err.status).toBe(401);
  });

  it('403 capability denied → permanent，且 message 说清缺哪个 capability（可操作）', async () => {
    server.issueToken({ token, sessionId, expiresAt: T0 + 3_600_000, scopes: ['datastore.read'] });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.insert(COLLECTIONS.outbox, chunkDoc())));

    expect(err.classification).toBe('permanent');
    expect(err.code).toBe('content_runtime_capability_denied');
    expect(err.message).toContain('datastore.write');
    expect(err.message).not.toContain(token);
    expect(credentials.refreshCalls).toBe(0);
  });

  it('403 origin 不匹配（字符串 detail）→ permanent，不当成可重试', async () => {
    credentials = new StubCredentials({
      token,
      sessionId,
      apiBaseUrl: API_BASE,
      origin: 'http://127.0.0.1:1',
      expiresAt: T0 + 3_600_000,
      capabilities: ['datastore.read', 'datastore.write'],
    });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));

    expect(err.status).toBe(403);
    expect(err.classification).toBe('permanent');
  });

  it('append_only 集合 upsert → 403 datastore_policy_denied，permanent', async () => {
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.upsert(COLLECTIONS.outbox, 'k1', chunkDoc())));

    expect(err.status).toBe(403);
    expect(err.code).toBe('datastore_policy_denied');
    expect(err.classification).toBe('permanent');
  });

  it('删别人的行 → 404「only delete your own rows」，permanent（不能当成删成功）', async () => {
    const docId = server.seed(COLLECTIONS.inbox, { owner: PLAYER_USER, createdAt: T0, doc: chunkDoc() });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.delete(COLLECTIONS.inbox, { docId })));

    expect(err.status).toBe(404);
    expect(err.code).toBe('datastore_not_found');
    expect(err.classification).toBe('permanent');
    expect(server.rowCount(COLLECTIONS.inbox)).toBe(1);
  });

  it('collection 未声明 → 404 datastore_not_found，message 指向 waku data define', async () => {
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query('agent_nope_v1', {})));

    expect(err.code).toBe('datastore_not_found');
    expect(err.classification).toBe('permanent');
    expect(err.message.toLowerCase()).toContain('declare');
  });

  it('datastore_invalid_cursor 原样透出 code（cursor-store 靠它决定回扫重置）', async () => {
    server.seed(COLLECTIONS.inbox, { owner: PLAYER_USER, createdAt: T0, doc: chunkDoc() });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, { cursor: 'not-a-real-cursor' })));

    expect(err.code).toBe('datastore_invalid_cursor');
    expect(err.status).toBe(400);
    expect(err.classification).toBe('permanent');
  });

  it('X-Runtime-Session-Id 与 token 不是同一个 session → datastore_scope_required，permanent', async () => {
    credentials = new StubCredentials({
      token,
      sessionId: 'rts_someone_else',
      apiBaseUrl: API_BASE,
      origin: ORIGIN,
      expiresAt: T0 + 3_600_000,
      capabilities: ['datastore.read', 'datastore.write'],
    });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));

    expect(err.code).toBe('datastore_scope_required');
    expect(err.classification).toBe('permanent');
  });
});

// ---------------------------------------------------------------------------
// 5xx / 网络 / 坏响应：retryable vs unknown
// ---------------------------------------------------------------------------

describe('M2 · WakuDataClient 传输故障分类', () => {
  it.each([500, 502, 503, 504])('%i → retryable', async (status) => {
    server.enqueueFault({ kind: 'status', status, body: { detail: 'upstream boom' } });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));

    expect(err.classification).toBe('retryable');
    expect(err.status).toBe(status);
  });

  it('读请求网络失败 → retryable（重读没有副作用）', async () => {
    server.enqueueFault({ kind: 'network', match: { verb: 'query' }, message: 'ECONNRESET' });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.query(COLLECTIONS.inbox, {})));

    expect(err.classification).toBe('retryable');
    expect(err.status).toBeUndefined();
  });

  it('写请求网络失败 → unknown：服务端其实已经落库，盲重发会造重复行', async () => {
    server.enqueueFault({ kind: 'network', match: { verb: 'insert' }, applyWrite: true, message: 'socket hang up' });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.insert(COLLECTIONS.outbox, chunkDoc())));

    expect(err.classification).toBe('unknown');
    expect(err.verb).toBe('insert');
    // 这就是 unknown 的理由：客户端没收到响应，但行确实在。
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(1);
  });

  it('delete 网络失败同样是 unknown（delete 也是写，也计入写额度）', async () => {
    const client = makeClient(await loadClient());
    const row = await client.insert(COLLECTIONS.outbox, chunkDoc());
    server.enqueueFault({ kind: 'network', match: { verb: 'delete' }, applyWrite: true });
    const err = asWakuError(await captureAsync(() => client.delete(COLLECTIONS.outbox, { docId: row.docId })));

    expect(err.classification).toBe('unknown');
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(0);
  });

  it('200 但 body 不是 JSON：读 retryable / 写 unknown，绝不静默当成空对象', async () => {
    const mod = await loadClient();

    server.enqueueFault({ kind: 'garbage-body', match: { verb: 'query' }, raw: '<html>proxy error</html>' });
    const readErr = asWakuError(await captureAsync(() => makeClient(mod).query(COLLECTIONS.inbox, {})));
    expect(readErr.classification).toBe('retryable');

    server.enqueueFault({ kind: 'garbage-body', match: { verb: 'insert' }, raw: 'not json at all' });
    const writeErr = asWakuError(await captureAsync(() => makeClient(mod).insert(COLLECTIONS.outbox, chunkDoc())));
    expect(writeErr.classification).toBe('unknown');
  });

  it('任何错误对象序列化后都不含 runtime token（日志/health 直接吐 err 也安全）', async () => {
    server.enqueueFault({ kind: 'status', status: 503, body: { detail: 'boom' } });
    const client = makeClient(await loadClient());
    const err = asWakuError(await captureAsync(() => client.insert(COLLECTIONS.outbox, chunkDoc())));

    const dump = `${err.message}|${JSON.stringify(err)}|${err.stack ?? ''}`;
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(sessionId);
  });
});

// ---------------------------------------------------------------------------
// 客户端前置校验：把平台的静默行为变成显式错误
// ---------------------------------------------------------------------------

describe('M2 · WakuDataClient 前置校验', () => {
  it('limit 超过 100 直接拒，不让服务端静默 clamp（否则调用方以为拿到 150 条）', async () => {
    const client = makeClient(await loadClient());
    const err = asWakuError(
      await captureAsync(() => client.query(COLLECTIONS.inbox, { limit: PLATFORM.QUERY_PAGE_LIMIT + 1 })),
    );

    expect(err.code).toBe('waku_invalid_request');
    expect(err.field).toBe('limit');
    expect(err.classification).toBe('permanent');
    expect(server.callsOf('query', COLLECTIONS.inbox)).toHaveLength(0);
  });

  it('doc 里带保留字段直接拒（平台是静默剥除 = 静默丢数据）', async () => {
    const client = makeClient(await loadClient());
    for (const reserved of ['key', 'owner', 'createdAt', 'docId', 'env']) {
      const err = asWakuError(
        await captureAsync(() => client.insert(COLLECTIONS.outbox, { ...chunkDoc(), [reserved]: 'x' })),
      );
      expect(err.code).toBe('waku_invalid_request');
      expect(err.field).toBe(reserved);
    }
    expect(server.callsOf('insert', COLLECTIONS.outbox)).toHaveLength(0);
  });

  it('json 字段超 8 KiB 在本地就拒，不浪费一次写额度', async () => {
    const client = makeClient(await loadClient());
    const huge = { ciphertext: 'A'.repeat(PLATFORM.JSON_FIELD_MAX_BYTES + 1) };
    const err = asWakuError(await captureAsync(() => client.insert(COLLECTIONS.outbox, chunkDoc({ payload: huge }))));

    expect(err.code).toBe('waku_invalid_request');
    expect(err.field).toBe('payload');
    expect(server.callsOf('insert', COLLECTIONS.outbox)).toHaveLength(0);
    expect(server.usage().writes).toBe(0);
  });

  it('整 doc 超 16 KiB 在本地就拒', async () => {
    const client = makeClient(await loadClient());
    const near = { ciphertext: 'A'.repeat(PLATFORM.JSON_FIELD_MAX_BYTES - 64) };
    const err = asWakuError(
      await captureAsync(() =>
        client.insert(COLLECTIONS.outbox, chunkDoc({ payload: near, nonce: 'B'.repeat(PLATFORM.DOC_MAX_BYTES) })),
      ),
    );
    expect(err.code).toBe('waku_invalid_request');
    expect(server.callsOf('insert', COLLECTIONS.outbox)).toHaveLength(0);
  });

  it('未知 query op 在本地就拒，不用一次读额度换一个 400', async () => {
    const client = makeClient(await loadClient());
    const err = asWakuError(
      await captureAsync(() =>
        client.query(COLLECTIONS.inbox, { filter: [{ field: 'routeId', op: 'startsWith', value: 'rt-' }] }),
      ),
    );

    expect(err.code).toBe('waku_invalid_request');
    expect(err.field).toBe('op');
    expect(server.usage().reads).toBe(0);
  });

  it('架构 §7 声明的字段全部可写；未声明字段由服务端拒（证明 fake 与 DDL 对齐）', async () => {
    const client = makeClient(await loadClient());
    const row = await client.insert(COLLECTIONS.outbox, chunkDoc());
    expect(Object.keys(row.doc).sort()).toEqual(Object.keys(MAILBOX_FIELDS).sort());

    const err = asWakuError(
      await captureAsync(() => client.insert(COLLECTIONS.outbox, { ...chunkDoc(), cwd: '/Users/aster' })),
    );
    expect(err.code).toBe('datastore_validation_failed');
    expect(err.classification).toBe('permanent');
  });
});
