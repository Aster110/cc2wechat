/**
 * Fake Waku content-runtime datastore（M2 测试用内存实现，**不是** 被测代码）
 *
 * 行为模型逐条抄自平台真源，不是猜的：
 * - 路由/请求 DTO：`waku-core/app/routes/datastore.py`
 *   POST `{apiBaseUrl}/content-runtime/data/{collection}/{verb}`，body camelCase
 *   （doc / key / docId / filter / sort / limit / cursor / patch / field / delta / all）。
 * - 语义/错误码/限速/缓存：`waku-core/app/services/datastore_service.py`
 * - 分页 keyset 与 cursor 编码：`waku-core/app/services/datastore_engine.py`
 *
 * 关键真实语义（本文件即这些事实的可执行副本）：
 * 1. 错误体是 `{"detail": {...}}`；`_http()` 把 `exc.details` **摊平**进 detail，
 *    所以限速的 `retry_after_sec` 在 `detail.retry_after_sec`，不是 `detail.details.*`；
 *    `Retry-After` header **只有** `datastore_rate_limited` 才带。
 * 2. `datastore_quota_exceeded` 也是 429，但**没有** Retry-After —— 429 ≠ 一定可退避重试。
 * 3. 401 的 detail 是**字符串**（`"invalid or expired token"`），不是对象。
 * 4. 保留字段（id/docId/key/owner/createdAt/updatedAt/env）客户端自报会被**静默剥除**，
 *    不是报错——客户端指望它们落库就是静默丢数据。
 * 5. `append_only` 拒 upsert/update/inc（403 datastore_policy_denied），
 *    insert 与「删自己的行」放行；删别人的行 → 404「you can only delete your own rows」。
 * 6. query 单页上限 100（超出静默 clamp，不报错），默认 50，默认排序 `-createdAt`。
 * 7. 公共读首页 5s 进程内缓存：**仅当** env=published 且未按 owner 过滤 且 cursor 为空。
 *    draft 分区不缓存（M2/M3 感觉不到，M4 切 published 才会撞上）。
 * 8. 行返回是**摊平**的：`{docId, createdAt, updatedAt, owner:{...}, ...doc, key?}`，
 *    doc 字段和元数据混在同一层。
 */

// ---------------------------------------------------------------------------
// 传输层接缝（与真 fetch 结构兼容，见各 test 里的编译期断言）
// ---------------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type FetchResponseLike = {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type FetchInitLike = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

class FakeResponse implements FetchResponseLike {
  private readonly bodyText: string;
  private readonly headerMap: Record<string, string>;
  readonly status: number;

  constructor(status: number, body: Json, headers: Record<string, string> = {}) {
    this.status = status;
    this.bodyText = JSON.stringify(body);
    this.headerMap = {};
    for (const [k, v] of Object.entries(headers)) this.headerMap[k.toLowerCase()] = v;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  get headers(): { get(name: string): string | null } {
    const map = this.headerMap;
    return {
      get(name: string): string | null {
        const hit = map[name.toLowerCase()];
        return hit === undefined ? null : hit;
      },
    };
  }

  text(): Promise<string> {
    return Promise.resolve(this.bodyText);
  }
}

/** 200 但 body 不是合法 JSON（网关/代理插了一段 HTML 之类）。 */
class RawResponse implements FetchResponseLike {
  readonly status: number;
  private readonly raw: string;

  constructor(status: number, raw: string) {
    this.status = status;
    this.raw = raw;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  get headers(): { get(name: string): string | null } {
    return { get: () => null };
  }

  text(): Promise<string> {
    return Promise.resolve(this.raw);
  }
}

// ---------------------------------------------------------------------------
// 平台常量（真源：config.py DATASTORE_*）
// ---------------------------------------------------------------------------

export const PLATFORM = {
  QUERY_PAGE_LIMIT: 100,
  QUERY_DEFAULT_LIMIT: 50,
  DOC_MAX_BYTES: 16 * 1024,
  JSON_FIELD_MAX_BYTES: 8 * 1024,
  STRING_FIELD_MAX_CHARS: 1024,
  WRITE_PER_MIN: 60,
  READ_PER_MIN: 300,
  PUBLIC_READ_CACHE_TTL_MS: 5000,
  ROWS_PER_OWNER_COLLECTION: 2000,
  ROWS_PER_OWNER_PROJECT: 5000,
  ROWS_PER_PROJECT: 100_000,
  DELETE_MANY_MAX_ROWS: 200,
  RATE_LIMIT_RETRY_AFTER_SEC: 10,
} as const;

export const QUERY_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export const RESERVED_FIELDS = ['id', 'docId', 'key', 'owner', 'createdAt', 'updatedAt', 'env'] as const;

export type AccessPolicy = 'owner_private' | 'public_read_owner_write' | 'append_only' | 'global_shared';
export type FieldType = 'string' | 'number' | 'boolean' | 'json' | 'timestamp' | 'ref';

export type FieldSpec = { type: FieldType; indexed?: boolean; private?: boolean; readonly?: boolean };

/** 架构 §7 冻结的三集合字段声明（daemon 侧 DDL 的事实副本）。 */
export const MAILBOX_FIELDS: Record<string, FieldSpec> = {
  protocolVersion: { type: 'number' },
  routeId: { type: 'string', indexed: true },
  messageId: { type: 'string', indexed: true },
  kind: { type: 'string' },
  expiresAt: { type: 'timestamp', indexed: true },
  chunkIndex: { type: 'number' },
  chunkCount: { type: 'number' },
  keyVersion: { type: 'number' },
  nonce: { type: 'string' },
  payload: { type: 'json' },
};

export const COLLECTIONS = {
  inbox: 'agent_inbox_v1',
  outbox: 'agent_outbox_v1',
  status: 'agent_status_v1',
} as const;

// ---------------------------------------------------------------------------
// 内部行模型
// ---------------------------------------------------------------------------

export type FakeRow = {
  docId: string;
  owner: string;
  env: 'draft' | 'published';
  key: string | null;
  createdAt: number;
  updatedAt: number;
  doc: Record<string, Json>;
};

type FakeCollection = {
  name: string;
  policy: AccessPolicy;
  fields: Record<string, FieldSpec>;
  rows: FakeRow[];
};

export type RecordedRequest = {
  url: string;
  method: string;
  collection: string;
  verb: string;
  headers: Record<string, string>;
  body: Record<string, Json>;
  at: number;
};

export type Fault =
  | { kind: 'network'; message?: string; match?: FaultMatch; applyWrite?: boolean }
  | { kind: 'status'; status: number; body: Json; headers?: Record<string, string>; match?: FaultMatch }
  | { kind: 'garbage-body'; status?: number; raw?: string; match?: FaultMatch };

export type FaultMatch = { verb?: string; collection?: string };

export type FakeWakuOptions = {
  apiBaseUrl: string;
  origin: string;
  /** daemon 自己的平台 user_id（rate-limit key 与 owner 判定都用它）。 */
  userId: string;
  now: () => number;
  env?: 'draft' | 'published';
  writePerMin?: number;
  readPerMin?: number;
  publicReadCacheTtlMs?: number;
  rowsPerOwnerCollection?: number;
};

export type IssuedToken = { token: string; sessionId: string; expiresAt: number; scopes: string[] };

const WRITE_VERBS = new Set(['insert', 'upsert', 'update', 'inc', 'delete', 'deleteMany']);
const READ_VERBS = new Set(['get', 'query', 'count']);

function stableStringify(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hash8(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = ((h * 33) ^ input.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function byteLength(value: Json): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export class FakeWakuServer {
  private readonly opts: Required<Omit<FakeWakuOptions, 'now'>> & { now: () => number };
  private readonly collections = new Map<string, FakeCollection>();
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly cache = new Map<string, { expiresAt: number; payload: Json }>();
  private readonly rateEvents: Array<{ kind: 'r' | 'w'; at: number }> = [];
  private readonly faults: Fault[] = [];
  private seq = 0;

  readonly requests: RecordedRequest[] = [];

  constructor(options: FakeWakuOptions) {
    this.opts = {
      apiBaseUrl: options.apiBaseUrl.replace(/\/+$/, ''),
      origin: options.origin,
      userId: options.userId,
      now: options.now,
      env: options.env ?? 'draft',
      writePerMin: options.writePerMin ?? PLATFORM.WRITE_PER_MIN,
      readPerMin: options.readPerMin ?? PLATFORM.READ_PER_MIN,
      publicReadCacheTtlMs: options.publicReadCacheTtlMs ?? PLATFORM.PUBLIC_READ_CACHE_TTL_MS,
      rowsPerOwnerCollection: options.rowsPerOwnerCollection ?? PLATFORM.ROWS_PER_OWNER_COLLECTION,
    };
  }

  // ── 声明与种子数据 ──────────────────────────────────────────────

  defineCollection(name: string, policy: AccessPolicy, fields: Record<string, FieldSpec> = MAILBOX_FIELDS): void {
    this.collections.set(name, { name, policy, fields, rows: [] });
  }

  defineMailboxCollections(): void {
    this.defineCollection(COLLECTIONS.inbox, 'append_only');
    this.defineCollection(COLLECTIONS.outbox, 'append_only');
    this.defineCollection(COLLECTIONS.status, 'public_read_owner_write');
  }

  /** 直接落行（模拟"玩家写进来的"）——绕过限速与 policy，只做基本字段填充。 */
  seed(collection: string, input: { owner: string; doc: Record<string, Json>; createdAt: number; key?: string }): string {
    const col = this.requireCollection(collection);
    this.seq += 1;
    const docId = `dsr_${String(this.seq).padStart(6, '0')}`;
    col.rows.push({
      docId,
      owner: input.owner,
      env: this.opts.env,
      key: input.key ?? null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      doc: { ...input.doc },
    });
    return docId;
  }

  rows(collection: string): FakeRow[] {
    return this.requireCollection(collection).rows.map((r) => ({ ...r, doc: { ...r.doc } }));
  }

  rowCount(collection: string): number {
    return this.requireCollection(collection).rows.length;
  }

  // ── 凭证 ────────────────────────────────────────────────────────

  issueToken(input: { token: string; sessionId: string; expiresAt: number; scopes?: string[] }): IssuedToken {
    const issued: IssuedToken = {
      token: input.token,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt,
      scopes: input.scopes ?? ['datastore.read', 'datastore.write'],
    };
    this.tokens.set(issued.token, issued);
    return issued;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  // ── 故障注入与观测 ──────────────────────────────────────────────

  enqueueFault(fault: Fault): void {
    this.faults.push(fault);
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  /** 已消耗的限速额度（真实语义：delete / upsert 也计写）。 */
  usage(windowMs = 60_000): { reads: number; writes: number } {
    const floor = this.opts.now() - windowMs;
    const live = this.rateEvents.filter((e) => e.at > floor);
    return {
      reads: live.filter((e) => e.kind === 'r').length,
      writes: live.filter((e) => e.kind === 'w').length,
    };
  }

  callsOf(verb: string, collection?: string): RecordedRequest[] {
    return this.requests.filter((r) => r.verb === verb && (collection === undefined || r.collection === collection));
  }

  // ── fetch 接缝 ──────────────────────────────────────────────────

  readonly fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;

    const prefix = `${this.opts.apiBaseUrl}/content-runtime/data/`;
    if (!url.startsWith(prefix)) {
      return new FakeResponse(404, { detail: 'Not Found' });
    }
    const [rawCollection, verb] = url.slice(prefix.length).split('/');
    const collection = decodeURIComponent(rawCollection ?? '');
    const body = this.parseBody(init.body);

    this.requests.push({
      url,
      method: init.method,
      collection,
      verb: verb ?? '',
      headers,
      body,
      at: this.opts.now(),
    });

    const fault = this.takeFault(verb ?? '', collection);
    if (fault && fault.kind === 'network') {
      if (fault.applyWrite) {
        // 「服务端已落库，客户端只看到断连」——unknown 语义的唯一正确构造方式。
        await this.dispatch(collection, verb ?? '', body, headers);
      }
      throw new Error(fault.message ?? 'fetch failed');
    }
    if (fault && fault.kind === 'status') {
      return new FakeResponse(fault.status, fault.body, fault.headers);
    }
    if (fault && fault.kind === 'garbage-body') {
      return new RawResponse(fault.status ?? 200, fault.raw ?? '<html>502 Bad Gateway</html>');
    }

    if (init.method !== 'POST') return new FakeResponse(405, { detail: 'Method Not Allowed' });
    return this.dispatch(collection, verb ?? '', body, headers);
  };

  // ── 内部实现 ────────────────────────────────────────────────────

  private parseBody(raw: string | undefined): Record<string, Json> {
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, Json>;
  }

  private takeFault(verb: string, collection: string): Fault | null {
    const idx = this.faults.findIndex((f) => {
      const m = f.match;
      if (!m) return true;
      if (m.verb !== undefined && m.verb !== verb) return false;
      if (m.collection !== undefined && m.collection !== collection) return false;
      return true;
    });
    if (idx < 0) return null;
    return this.faults.splice(idx, 1)[0];
  }

  private requireCollection(name: string): FakeCollection {
    const col = this.collections.get(name);
    if (!col) throw new Error(`fake-waku: collection '${name}' was never defined in this test`);
    return col;
  }

  private err(code: string, message: string, status = 400, extra: Record<string, Json> = {}): FakeResponse {
    const detail: Record<string, Json> = { code, message, ...extra };
    const headers =
      code === 'datastore_rate_limited'
        ? { 'Retry-After': String(extra['retry_after_sec'] ?? PLATFORM.RATE_LIMIT_RETRY_AFTER_SEC) }
        : undefined;
    return new FakeResponse(status, { detail }, headers);
  }

  private async dispatch(
    collection: string,
    verb: string,
    body: Record<string, Json>,
    headers: Record<string, string>,
  ): Promise<FetchResponseLike> {
    // ① 鉴权（runtime_gate：坏/过期凭据 → 401 字符串 detail）
    const auth = headers['authorization'] ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!token) return new FakeResponse(401, { detail: 'unauthenticated' });
    const issued = this.tokens.get(token);
    if (!issued || issued.expiresAt <= this.opts.now()) {
      return new FakeResponse(401, { detail: 'invalid or expired token' });
    }

    // ② Origin 绑定（bootstrap 时钉的 origin；不匹配 → 403 字符串 detail）
    const origin = headers['origin'];
    if (!origin || origin !== this.opts.origin) {
      return new FakeResponse(403, { detail: `origin '${origin ?? ''}' not allowed here` });
    }

    // ③ capability gate
    const needed = WRITE_VERBS.has(verb) ? 'datastore.write' : 'datastore.read';
    if (!READ_VERBS.has(verb) && !WRITE_VERBS.has(verb)) {
      return new FakeResponse(404, { detail: 'Not Found' });
    }
    if (!issued.scopes.includes(needed)) {
      return new FakeResponse(403, { detail: { code: 'content_runtime_capability_denied', capability: needed } });
    }

    // ④ session pin：带了 X-Runtime-Session-Id 就必须是自己的 active session
    const pinned = headers['x-runtime-session-id'];
    if (pinned !== undefined && pinned !== issued.sessionId) {
      return this.err(
        'datastore_scope_required',
        'runtime session not found or not yours (X-Runtime-Session-Id)',
        400,
      );
    }

    const col = this.collections.get(collection);
    if (!col) {
      return this.err(
        'datastore_not_found',
        `collection '${collection}' is not declared for this content (author must waku_data_define it)`,
        404,
      );
    }

    // ⑤ 限速（真实 key 是 {kind}:{user_id}:{scope}，daemon 是单一 user_id）
    const kind: 'r' | 'w' = WRITE_VERBS.has(verb) ? 'w' : 'r';
    const limit = kind === 'w' ? this.opts.writePerMin : this.opts.readPerMin;
    const used = kind === 'w' ? this.usage().writes : this.usage().reads;
    if (used >= limit) {
      return this.err('datastore_rate_limited', 'too many datastore requests; retry shortly', 429, {
        retry_after_sec: PLATFORM.RATE_LIMIT_RETRY_AFTER_SEC,
      });
    }
    this.rateEvents.push({ kind, at: this.opts.now() });

    switch (verb) {
      case 'insert':
        return this.doInsert(col, body);
      case 'upsert':
        return this.doUpsert(col, body);
      case 'query':
        return this.doQuery(col, body);
      case 'get':
        return this.doGet(col, body);
      case 'delete':
        return this.doDelete(col, body);
      case 'deleteMany':
        return this.doDeleteMany(col, body);
      case 'count':
        return this.doCount(col, body);
      case 'update':
      case 'inc':
        if (col.policy === 'append_only') {
          return this.err(
            'datastore_policy_denied',
            `collection '${col.name}' is append_only: rows cannot be modified (insert/delete-own only)`,
            403,
          );
        }
        return this.err('datastore_validation_failed', 'fake-waku: verb not modelled', 400);
      default:
        return new FakeResponse(404, { detail: 'Not Found' });
    }
  }

  /** 平台 `_validate_doc`：保留字段静默剥除；未声明字段报错；类型/大小校验。 */
  private validateDoc(col: FakeCollection, raw: Json): Record<string, Json> | FakeResponse {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return this.err('datastore_validation_failed', 'doc must be an object');
    }
    const doc = raw as Record<string, Json>;
    const clean: Record<string, Json> = {};
    for (const [name, value] of Object.entries(doc)) {
      if ((RESERVED_FIELDS as readonly string[]).includes(name)) continue; // 静默剥除
      const spec = col.fields[name];
      if (!spec) {
        return this.err('datastore_validation_failed', `field '${name}' is not declared in collection '${col.name}'`, 400, {
          declared: Object.keys(col.fields).sort(),
        });
      }
      if (value === null) {
        clean[name] = null;
        continue;
      }
      const coerced = this.coerce(name, spec.type, value);
      if (coerced instanceof FakeResponse) return coerced;
      clean[name] = coerced;
    }
    if (byteLength(clean) > PLATFORM.DOC_MAX_BYTES) {
      return this.err('datastore_validation_failed', `document exceeds ${PLATFORM.DOC_MAX_BYTES} bytes`);
    }
    return clean;
  }

  private coerce(name: string, type: FieldType, value: Json): Json | FakeResponse {
    if (type === 'string' || type === 'ref') {
      if (typeof value !== 'string') return this.err('datastore_validation_failed', `field '${name}' must be a string`);
      if (type === 'string' && value.length > PLATFORM.STRING_FIELD_MAX_CHARS) {
        return this.err('datastore_validation_failed', `field '${name}' exceeds ${PLATFORM.STRING_FIELD_MAX_CHARS} chars`);
      }
      return value;
    }
    if (type === 'number' || type === 'timestamp') {
      if (typeof value !== 'number') return this.err('datastore_validation_failed', `field '${name}' must be a number`);
      return value;
    }
    if (type === 'boolean') {
      if (typeof value !== 'boolean') return this.err('datastore_validation_failed', `field '${name}' must be a boolean`);
      return value;
    }
    if (value === null || typeof value !== 'object') {
      return this.err('datastore_validation_failed', `field '${name}' must be a JSON object/array`);
    }
    if (byteLength({ v: value }) > PLATFORM.JSON_FIELD_MAX_BYTES) {
      return this.err('datastore_validation_failed', `json field '${name}' exceeds ${PLATFORM.JSON_FIELD_MAX_BYTES} bytes`);
    }
    return value;
  }

  private rowPayload(col: FakeCollection, row: FakeRow): Record<string, Json> {
    const isMe = row.owner === this.opts.userId;
    const out: Record<string, Json> = {
      docId: row.docId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      owner: { displayName: 'Player', isMe },
      ...row.doc,
    };
    if (isMe && row.key) out['key'] = row.key;
    return out;
  }

  private doInsert(col: FakeCollection, body: Record<string, Json>): FetchResponseLike {
    const clean = this.validateDoc(col, body['doc'] ?? {});
    if (clean instanceof FakeResponse) return clean;
    const mine = col.rows.filter((r) => r.owner === this.opts.userId).length;
    if (mine >= this.opts.rowsPerOwnerCollection) {
      return this.err(
        'datastore_quota_exceeded',
        `per-player row limit for this collection reached (${this.opts.rowsPerOwnerCollection})`,
        429,
      );
    }
    this.seq += 1;
    const now = this.opts.now();
    const row: FakeRow = {
      docId: `dsr_${String(this.seq).padStart(6, '0')}`,
      owner: this.opts.userId,
      env: this.opts.env,
      key: null,
      createdAt: now,
      updatedAt: now,
      doc: clean,
    };
    col.rows.push(row);
    return new FakeResponse(200, this.rowPayload(col, row));
  }

  private doUpsert(col: FakeCollection, body: Record<string, Json>): FetchResponseLike {
    if (col.policy === 'append_only') {
      return this.err(
        'datastore_policy_denied',
        `collection '${col.name}' is append_only: rows cannot be modified (insert/delete-own only)`,
        403,
      );
    }
    const key = body['key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(key)) {
      return this.err('datastore_validation_failed', 'key must be 1-64 chars of [A-Za-z0-9._:-]');
    }
    const clean = this.validateDoc(col, body['doc'] ?? {});
    if (clean instanceof FakeResponse) return clean;
    const now = this.opts.now();
    const existing = col.rows.find((r) => r.owner === this.opts.userId && r.key === key);
    if (existing) {
      existing.doc = clean;
      existing.updatedAt = now;
      return new FakeResponse(200, this.rowPayload(col, existing));
    }
    this.seq += 1;
    const row: FakeRow = {
      docId: `dsr_${String(this.seq).padStart(6, '0')}`,
      owner: this.opts.userId,
      env: this.opts.env,
      key,
      createdAt: now,
      updatedAt: now,
      doc: clean,
    };
    col.rows.push(row);
    return new FakeResponse(200, this.rowPayload(col, row));
  }

  private doGet(col: FakeCollection, body: Record<string, Json>): FetchResponseLike {
    const docId = body['docId'];
    const key = body['key'];
    const row =
      typeof key === 'string'
        ? col.rows.find((r) => r.owner === this.opts.userId && r.key === key)
        : typeof docId === 'string'
          ? col.rows.find((r) => r.docId === docId)
          : undefined;
    if (!row) return this.err('datastore_not_found', 'document not found', 404);
    return new FakeResponse(200, this.rowPayload(col, row));
  }

  private doDelete(col: FakeCollection, body: Record<string, Json>): FetchResponseLike {
    const docId = body['docId'];
    const key = body['key'];
    const idx =
      typeof key === 'string'
        ? col.rows.findIndex((r) => r.owner === this.opts.userId && r.key === key)
        : typeof docId === 'string'
          ? col.rows.findIndex((r) => r.docId === docId)
          : -2;
    if (idx === -2) return this.err('datastore_validation_failed', 'docId or key is required');
    if (idx < 0) return this.err('datastore_not_found', 'document not found', 404);
    const row = col.rows[idx];
    if (row.owner !== this.opts.userId && col.policy !== 'global_shared') {
      return this.err('datastore_not_found', 'document not found (you can only delete your own rows)', 404);
    }
    col.rows.splice(idx, 1);
    return new FakeResponse(200, { ok: true });
  }

  private doDeleteMany(col: FakeCollection, body: Record<string, Json>): FetchResponseLike {
    const spec = this.buildSpec(col, body);
    if (spec instanceof FakeResponse) return spec;
    if (spec.where.length === 0 && body['all'] !== true) {
      return this.err(
        'datastore_validation_failed',
        'deleteMany requires a filter (or explicit all:true to clear the collection)',
      );
    }
    const batch = Math.min(
      typeof body['limit'] === 'number' ? body['limit'] : PLATFORM.DELETE_MANY_MAX_ROWS,
      PLATFORM.DELETE_MANY_MAX_ROWS,
    );
    const victims = col.rows
      .filter((r) => r.owner === this.opts.userId && this.matches(col, r, spec.where))
      .slice(0, batch);
    for (const v of victims) col.rows.splice(col.rows.indexOf(v), 1);
    return new FakeResponse(200, { deleted: victims.length, hasMore: victims.length >= batch });
  }

  private doCount(col: FakeCollection, body: Record<string, Json>): FetchResponseLike {
    const spec = this.buildSpec(col, body);
    if (spec instanceof FakeResponse) return spec;
    const value = col.rows.filter((r) => this.matches(col, r, spec.where)).length;
    return new FakeResponse(200, { count: value });
  }

  private doQuery(col: FakeCollection, body: Record<string, Json>): FetchResponseLike {
    const spec = this.buildSpec(col, body);
    if (spec instanceof FakeResponse) return spec;

    const specHash = hash8(
      stableStringify([col.name, this.opts.env, spec.ownerEq, spec.where as unknown as Json, [spec.sortField, spec.sortDir]]),
    );

    const cacheable = spec.ownerEq === null && this.opts.env === 'published' && spec.cursor === null;
    const cacheKey = `q:${col.name}:${specHash}`;
    if (cacheable) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > this.opts.now()) return new FakeResponse(200, hit.payload);
    }

    let pool = col.rows.filter((r) => this.matches(col, r, spec.where));
    if (spec.ownerEq !== null) pool = pool.filter((r) => r.owner === spec.ownerEq);

    const dir = spec.sortDir === 'desc' ? -1 : 1;
    const sortValue = (r: FakeRow): number | string =>
      spec.sortField === 'createdAt' ? r.createdAt : this.numOrStr(r.doc[spec.sortField]);
    pool.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.docId < b.docId ? -1 * dir : a.docId > b.docId ? 1 * dir : 0;
    });

    if (spec.cursor !== null) {
      let decoded: { v: Json; id: string; h?: string };
      try {
        const parsed: unknown = JSON.parse(Buffer.from(spec.cursor, 'base64url').toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || !('v' in parsed) || !('id' in parsed)) {
          throw new Error('bad cursor shape');
        }
        decoded = parsed as { v: Json; id: string; h?: string };
      } catch {
        return this.err('datastore_invalid_cursor', 'malformed cursor');
      }
      if (decoded.h !== specHash) return this.err('datastore_invalid_cursor', 'cursor does not match query');
      const boundary = this.numOrStr(decoded.v);
      pool = pool.filter((r) => {
        const v = sortValue(r);
        if (v === boundary) return dir === 1 ? r.docId > decoded.id : r.docId < decoded.id;
        return dir === 1 ? v > boundary : v < boundary;
      });
    }

    const hasMore = pool.length > spec.limit;
    const page = pool.slice(0, spec.limit);
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ v: sortValue(last), id: last.docId, h: specHash }),
        'utf8',
      ).toString('base64url');
    }
    const payload: Json = {
      rows: page.map((r) => this.rowPayload(col, r)) as unknown as Json,
      nextCursor,
      hasMore,
    };
    if (cacheable) {
      this.cache.set(cacheKey, { expiresAt: this.opts.now() + this.opts.publicReadCacheTtlMs, payload });
    }
    return new FakeResponse(200, payload);
  }

  private numOrStr(value: Json): number | string {
    if (typeof value === 'number' || typeof value === 'string') return value;
    return '';
  }

  private buildSpec(
    col: FakeCollection,
    body: Record<string, Json>,
  ):
    | { where: Array<{ field: string; op: QueryOp; value: Json }>; ownerEq: string | null; sortField: string; sortDir: 'asc' | 'desc'; limit: number; cursor: string | null }
    | FakeResponse {
    const rawFilter = body['filter'];
    const where: Array<{ field: string; op: QueryOp; value: Json }> = [];
    let ownerEq: string | null = null;
    if (Array.isArray(rawFilter)) {
      for (const item of rawFilter) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          return this.err('datastore_validation_failed', 'where items must be {field, op, value}');
        }
        const rec = item as Record<string, Json>;
        const field = rec['field'];
        const op = (rec['op'] ?? 'eq') as string;
        const value = rec['value'] ?? null;
        if (!(QUERY_OPS as readonly string[]).includes(op)) {
          return this.err('datastore_validation_failed', `unknown op '${op}'`, 400, { allowed: [...QUERY_OPS] });
        }
        if (field === 'owner') {
          if (op !== 'eq' || value !== 'me') {
            return this.err('datastore_validation_failed', 'owner filter only supports {field:"owner",op:"eq",value:"me"}');
          }
          ownerEq = this.opts.userId;
          continue;
        }
        if (typeof field !== 'string') {
          return this.err('datastore_validation_failed', 'where items must be {field, op, value}');
        }
        if (field !== 'createdAt') {
          const spec = col.fields[field];
          if (!spec) {
            return this.err('datastore_validation_failed', `cannot filter on undeclared field '${field}'`, 400, {
              declared: Object.keys(col.fields).sort(),
              system: ['owner', 'createdAt'],
            });
          }
          if (spec.type === 'json') return this.err('datastore_validation_failed', 'json fields are not filterable');
          if (op === 'contains' && spec.type !== 'string') {
            return this.err('datastore_validation_failed', 'contains only applies to string fields');
          }
        }
        where.push({ field, op: op as QueryOp, value });
      }
    }

    let sortField = 'createdAt';
    let sortDir: 'asc' | 'desc' = 'desc';
    const sort = body['sort'];
    if (typeof sort === 'string' && sort.length > 0) {
      sortField = sort.startsWith('-') ? sort.slice(1) : sort;
      sortDir = sort.startsWith('-') ? 'desc' : 'asc';
    } else if (Array.isArray(sort) && sort.length === 2) {
      sortField = String(sort[0]);
      sortDir = String(sort[1]).toLowerCase() === 'desc' ? 'desc' : 'asc';
    } else if (sort !== undefined && sort !== null) {
      return this.err('datastore_validation_failed', 'sort must be "field" | "-field" | [field, dir]');
    }
    if (sortField !== 'createdAt') {
      const spec = col.fields[sortField];
      if (!spec || !spec.indexed) {
        return this.err('datastore_invalid_sort', `sort field '${sortField}' must be an indexed field or createdAt`);
      }
    }

    const rawLimit = body['limit'];
    let limit = typeof rawLimit === 'number' ? rawLimit : PLATFORM.QUERY_DEFAULT_LIMIT;
    limit = Math.min(limit, PLATFORM.QUERY_PAGE_LIMIT);
    if (limit < 1) limit = 1;

    const rawCursor = body['cursor'];
    const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null;

    return { where, ownerEq, sortField, sortDir, limit, cursor };
  }

  private matches(col: FakeCollection, row: FakeRow, where: Array<{ field: string; op: QueryOp; value: Json }>): boolean {
    for (const cond of where) {
      const actual: Json = cond.field === 'createdAt' ? row.createdAt : (row.doc[cond.field] ?? null);
      if (!this.matchOne(actual, cond.op, cond.value)) return false;
    }
    return true;
  }

  private matchOne(actual: Json, op: QueryOp, expected: Json): boolean {
    switch (op) {
      case 'eq':
        return actual === expected;
      case 'ne':
        return actual !== expected;
      case 'gt':
        return this.numOrStr(actual) > this.numOrStr(expected);
      case 'gte':
        return this.numOrStr(actual) >= this.numOrStr(expected);
      case 'lt':
        return this.numOrStr(actual) < this.numOrStr(expected);
      case 'lte':
        return this.numOrStr(actual) <= this.numOrStr(expected);
      case 'in':
        return Array.isArray(expected) && expected.some((v) => v === actual);
      case 'contains':
        return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
      default:
        return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 注入式时钟 / 定时器（自适应轮询测试不真 sleep）
// ---------------------------------------------------------------------------

export type TimerHandle = number;

export type TimerSeam = {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export class FakeScheduler implements TimerSeam {
  private t: number;
  private nextId = 1;
  private tasks: Array<{ id: TimerHandle; at: number; fn: () => void }> = [];

  constructor(startMs: number) {
    this.t = startMs;
  }

  now = (): number => this.t;

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.tasks = this.tasks.filter((task) => task.id !== handle);
  }

  /** 已排期但未触发的延迟（ms），用于断言自适应轮询间隔。 */
  pendingDelays(): number[] {
    return this.tasks.map((task) => task.at - this.t).sort((a, b) => a - b);
  }

  get pendingCount(): number {
    return this.tasks.length;
  }

  /** 推进虚拟时间并跑到期任务，每个任务后排空微任务队列。 */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((task) => task.id !== due.id);
      this.t = due.at;
      due.fn();
      await flush();
    }
    this.t = target;
    await flush();
  }

  /** 只排空微任务，不推进时间。 */
  async settle(): Promise<void> {
    await flush();
  }
}

export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** 让"未实现的模块"在运行期才炸（tsc 不静态解析变量 specifier）。 */
export function lazyModule<T>(specifier: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = import(specifier) as Promise<T>;
    return cached;
  };
}

/** 捕获异步抛出的错误，保留结构化字段供断言。 */
export async function captureAsync(fn: () => Promise<unknown>): Promise<Record<string, unknown> & Error> {
  try {
    await fn();
  } catch (e) {
    return e as Record<string, unknown> & Error;
  }
  throw new Error('expected the call to throw, but it resolved');
}
