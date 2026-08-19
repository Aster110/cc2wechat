/**
 * Waku content-runtime datastore 客户端（架构 §3 硬边界 1 / 任务书 §4.2）。
 *
 * 这是 gateway **唯一**接触 Waku REST DTO 的地方：上层只看得到 `WakuRow` / `WakuPage`
 * 与被分类过的 `WakuDataError`，看不到 `detail.code`、摊平行、Retry-After header。
 *
 * 三条从平台真源抄来的、不能想当然的语义：
 * 1. 错误体是 `{"detail": ...}`，detail 既可能是**对象**（datastore_* / capability denied），
 *    也可能是**字符串**（401 `invalid or expired token`、403 origin）。两种都得能分类。
 * 2. **429 有两种**：`datastore_rate_limited`（带 Retry-After，退避有用）与
 *    `datastore_quota_exceeded`（行数满，退避没用，要人来清行）。混成一类 = 无限空转。
 * 3. **写请求的网络失败是 `unknown`，不是 `retryable`**：服务端可能已经落库，
 *    盲重发会在 append_only 集合里造重复行。读失败才可以直接重试。
 *
 * 另外把平台的两个"静默行为"提前变成显式错误（省一次额度换一个可读的报错）：
 * 保留字段自报会被**静默剥除**（= 静默丢数据）、limit 超 100 会被**静默 clamp**。
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------
// 平台常量（真源：waku-core config.py DATASTORE_*）
// ---------------------------------------------------------------------------

export const WAKU_QUERY_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const;
export type WakuQueryOp = (typeof WAKU_QUERY_OPS)[number];

export const WAKU_QUERY_PAGE_LIMIT = 100;
export const WAKU_QUERY_DEFAULT_LIMIT = 50;
export const WAKU_DOC_MAX_BYTES = 16 * 1024;
export const WAKU_JSON_FIELD_MAX_BYTES = 8 * 1024;

/** 客户端自报这些会被平台静默剥除，所以本地直接拒。 */
export const WAKU_RESERVED_FIELDS = [
  'id',
  'docId',
  'key',
  'owner',
  'createdAt',
  'updatedAt',
  'env',
] as const;

/** 429 既无 Retry-After header 也无 detail.retry_after_sec 时的兜底。 */
export const WAKU_DEFAULT_RETRY_AFTER_MS = 10_000;

// ---------------------------------------------------------------------------
// 传输层接缝（与真 fetch 结构兼容，便于注入 fake / 自定义 agent）
// ---------------------------------------------------------------------------

export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------------------
// 对上层的形状
// ---------------------------------------------------------------------------

export type WakuErrorClass = 'retryable' | 'permanent' | 'unknown' | 'auth' | 'rate-limited';
export type WakuVerb = 'insert' | 'upsert' | 'query' | 'delete';

export interface WakuDataError extends Error {
  name: 'WakuDataError';
  /** 平台 `detail.code`（datastore_* / content_runtime_*）或客户端自有 `waku_*`。 */
  code: string;
  classification: WakuErrorClass;
  status?: number;
  retryAfterMs?: number;
  retryAt?: number;
  verb: WakuVerb;
  collection: string;
  field?: string;
}

export interface WakuRowOwner {
  displayName: string;
  isMe: boolean;
}

export interface WakuRow {
  docId: string;
  createdAt: number;
  updatedAt: number;
  owner: WakuRowOwner;
  key?: string;
  /** 业务字段——元数据已被剥到同级，不混在这里。 */
  doc: Record<string, Json>;
}

export interface WakuPage {
  rows: WakuRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface WakuFilter {
  field: string;
  op: string;
  value: Json;
}

export interface WakuQueryParams {
  filter?: WakuFilter[];
  sort?: string | [string, 'asc' | 'desc'];
  limit?: number;
  cursor?: string;
}

export interface RuntimeCredentials {
  token: string;
  sessionId: string;
  apiBaseUrl: string;
  origin: string;
  expiresAt: number;
  capabilities: readonly string[];
}

/** 凭证接缝：由 credential-provider 实现，client 只负责"用"与"401 时刷一次"。 */
export interface CredentialSeam {
  current(): Promise<RuntimeCredentials>;
  refresh(): Promise<void>;
}

export interface WakuDataClient {
  insert(collection: string, doc: Record<string, Json>): Promise<WakuRow>;
  upsert(collection: string, key: string, doc: Record<string, Json>): Promise<WakuRow>;
  query(collection: string, params: WakuQueryParams): Promise<WakuPage>;
  delete(collection: string, target: { docId: string } | { key: string }): Promise<{ ok: true }>;
}

export interface WakuDataClientOptions {
  credentials: CredentialSeam;
  fetchImpl: FetchLike;
  now: () => number;
  defaultRetryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// 错误构造与分类
// ---------------------------------------------------------------------------

interface WakuErrorInput {
  message: string;
  code: string;
  classification: WakuErrorClass;
  verb: WakuVerb;
  collection: string;
  status?: number;
  retryAfterMs?: number;
  retryAt?: number;
  field?: string;
}

function wakuError(input: WakuErrorInput): WakuDataError {
  const err = new Error(input.message) as WakuDataError;
  err.name = 'WakuDataError';
  err.code = input.code;
  err.classification = input.classification;
  err.verb = input.verb;
  err.collection = input.collection;
  if (input.status !== undefined) err.status = input.status;
  if (input.retryAfterMs !== undefined) err.retryAfterMs = input.retryAfterMs;
  if (input.retryAt !== undefined) err.retryAt = input.retryAt;
  if (input.field !== undefined) err.field = input.field;
  return err;
}

/** 鸭子类型判定：跨模块传过来的错误不一定是本模块造的实例。 */
function asClassified(error: unknown): Partial<WakuDataError> | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  return typeof record['classification'] === 'string' ? (record as Partial<WakuDataError>) : null;
}

export function classificationOf(error: unknown): WakuErrorClass {
  const hit = asClassified(error);
  return hit?.classification ?? 'unknown';
}

export function codeOf(error: unknown): string {
  const hit = asClassified(error);
  return typeof hit?.code === 'string' ? hit.code : 'waku_unclassified_error';
}

export function retryAfterMsOf(error: unknown): number | undefined {
  const hit = asClassified(error);
  const value = hit?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

const WRITE_VERBS: ReadonlySet<WakuVerb> = new Set<WakuVerb>(['insert', 'upsert', 'delete']);

function classifyStatus(status: number, code: string): WakuErrorClass {
  if (status === 401) return 'auth';
  if (status === 429) return code === 'datastore_rate_limited' ? 'rate-limited' : 'permanent';
  if (status === 408 || status === 425) return 'retryable';
  if (status >= 500) return 'retryable';
  return 'permanent';
}

// ---------------------------------------------------------------------------
// 本地前置校验
// ---------------------------------------------------------------------------

function invalidRequest(
  message: string,
  verb: WakuVerb,
  collection: string,
  field: string,
): WakuDataError {
  return wakuError({
    message,
    code: 'waku_invalid_request',
    classification: 'permanent',
    verb,
    collection,
    field,
  });
}

function jsonBytes(value: Json): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function assertWritableDoc(doc: Record<string, Json>, verb: WakuVerb, collection: string): void {
  for (const [name, value] of Object.entries(doc)) {
    if ((WAKU_RESERVED_FIELDS as readonly string[]).includes(name)) {
      // 平台是**静默剥除**保留字段，落库后你根本不知道自己丢了数据。
      throw invalidRequest(
        `field '${name}' is reserved by the platform and would be silently stripped`,
        verb,
        collection,
        name,
      );
    }
    if (typeof value === 'object' && value !== null && jsonBytes(value) > WAKU_JSON_FIELD_MAX_BYTES) {
      throw invalidRequest(
        `json field '${name}' exceeds ${WAKU_JSON_FIELD_MAX_BYTES} bytes`,
        verb,
        collection,
        name,
      );
    }
  }
  if (jsonBytes(doc) > WAKU_DOC_MAX_BYTES) {
    throw invalidRequest(`document exceeds ${WAKU_DOC_MAX_BYTES} bytes`, verb, collection, 'doc');
  }
}

const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function assertQueryParams(params: WakuQueryParams, collection: string): void {
  if (params.limit !== undefined) {
    if (!Number.isInteger(params.limit) || params.limit < 1) {
      throw invalidRequest('limit must be a positive integer', 'query', collection, 'limit');
    }
    if (params.limit > WAKU_QUERY_PAGE_LIMIT) {
      // 平台会静默 clamp 到 100，调用方却以为自己拿到了 150 条。
      throw invalidRequest(
        `limit must not exceed ${WAKU_QUERY_PAGE_LIMIT} (the platform silently clamps it)`,
        'query',
        collection,
        'limit',
      );
    }
  }
  for (const condition of params.filter ?? []) {
    if (typeof condition.field !== 'string' || condition.field.length === 0) {
      throw invalidRequest('filter items must be {field, op, value}', 'query', collection, 'field');
    }
    if (!(WAKU_QUERY_OPS as readonly string[]).includes(condition.op)) {
      throw invalidRequest(
        `unknown query op '${condition.op}'; allowed: ${WAKU_QUERY_OPS.join(', ')}`,
        'query',
        collection,
        'op',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 响应归一
// ---------------------------------------------------------------------------

function asRecord(value: Json | undefined): Record<string, Json> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
}

/** 摊平行 `{docId, createdAt, updatedAt, owner, ...doc, key?}` → `{...meta, doc}`。 */
function toRow(payload: Record<string, Json>): WakuRow {
  const doc: Record<string, Json> = {};
  for (const [name, value] of Object.entries(payload)) {
    if ((WAKU_RESERVED_FIELDS as readonly string[]).includes(name)) continue;
    doc[name] = value;
  }
  const ownerRecord = asRecord(payload['owner']) ?? {};
  const row: WakuRow = {
    docId: typeof payload['docId'] === 'string' ? payload['docId'] : '',
    createdAt: typeof payload['createdAt'] === 'number' ? payload['createdAt'] : 0,
    updatedAt: typeof payload['updatedAt'] === 'number' ? payload['updatedAt'] : 0,
    owner: {
      displayName:
        typeof ownerRecord['displayName'] === 'string' ? ownerRecord['displayName'] : 'Player',
      isMe: ownerRecord['isMe'] === true,
    },
    doc,
  };
  if (typeof payload['key'] === 'string') row.key = payload['key'];
  return row;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export function createWakuDataClient(options: WakuDataClientOptions): WakuDataClient {
  const { credentials, fetchImpl, now } = options;
  const defaultRetryAfterMs = options.defaultRetryAfterMs ?? WAKU_DEFAULT_RETRY_AFTER_MS;

  async function loadCredentials(verb: WakuVerb, collection: string): Promise<RuntimeCredentials> {
    try {
      return await credentials.current();
    } catch (cause) {
      throw wakuError({
        message: 'waku runtime credentials are unavailable',
        code: codeOfUnknown(cause, 'waku_credential_unavailable'),
        classification: 'auth',
        verb,
        collection,
      });
    }
  }

  async function call(
    verb: WakuVerb,
    collection: string,
    body: Record<string, Json>,
  ): Promise<Record<string, Json>> {
    const isWrite = WRITE_VERBS.has(verb);
    let refreshed = false;

    for (;;) {
      const cred = await loadCredentials(verb, collection);
      const url = `${cred.apiBaseUrl.replace(/\/+$/, '')}/content-runtime/data/${encodeURIComponent(
        collection,
      )}/${verb}`;

      let response: FetchResponseLike;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${cred.token}`,
            Origin: cred.origin,
            'X-Runtime-Session-Id': cred.sessionId,
          },
          body: JSON.stringify(body),
        });
      } catch {
        // 写请求没收到响应 ≠ 没落库：盲重发会造重复行，所以是 unknown 不是 retryable。
        throw wakuError({
          message: `waku ${verb} on ${collection} failed before a response arrived`,
          code: isWrite ? 'waku_write_unknown' : 'waku_network_error',
          classification: isWrite ? 'unknown' : 'retryable',
          verb,
          collection,
        });
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw wakuError({
          message: `waku ${verb} on ${collection} returned an unreadable body`,
          code: isWrite ? 'waku_write_unknown' : 'waku_bad_response',
          classification: isWrite ? 'unknown' : 'retryable',
          verb,
          collection,
          status: response.status,
        });
      }

      let parsed: Json;
      try {
        parsed = (text.length === 0 ? {} : JSON.parse(text)) as Json;
      } catch {
        // 200 + 一段 HTML（网关/代理插的）绝不能静默当成空对象。
        throw wakuError({
          message: `waku ${verb} on ${collection} returned a non-JSON body`,
          code: isWrite ? 'waku_write_unknown' : 'waku_bad_response',
          classification: isWrite ? 'unknown' : 'retryable',
          verb,
          collection,
          status: response.status,
        });
      }

      const payload = asRecord(parsed) ?? {};
      if (response.ok) return payload;

      const detail = payload['detail'];
      const detailObj = asRecord(detail);
      const code =
        typeof detailObj?.['code'] === 'string' ? detailObj['code'] : `http_${response.status}`;

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        try {
          await credentials.refresh();
        } catch {
          // mint 失败的细节留在 provider 的 health 里，错误里只说"刷不出来"。
          throw wakuError({
            message: 'waku runtime credentials could not be refreshed',
            code: 'waku_credential_refresh_failed',
            classification: 'auth',
            verb,
            collection,
            status: 401,
          });
        }
        continue;
      }

      throw httpError(response, verb, collection, code, detail, detailObj);
    }
  }

  function httpError(
    response: FetchResponseLike,
    verb: WakuVerb,
    collection: string,
    code: string,
    detail: Json | undefined,
    detailObj: Record<string, Json> | null,
  ): WakuDataError {
    const classification = classifyStatus(response.status, code);
    const base =
      typeof detailObj?.['message'] === 'string'
        ? detailObj['message']
        : typeof detail === 'string' && detail.length > 0
          ? detail
          : `waku ${verb} on ${collection} failed with HTTP ${response.status}`;
    const capability =
      typeof detailObj?.['capability'] === 'string'
        ? ` (missing capability: ${detailObj['capability']})`
        : '';

    if (classification !== 'rate-limited') {
      return wakuError({
        message: `${base}${capability}`,
        code,
        classification,
        verb,
        collection,
        status: response.status,
      });
    }

    const retryAfterMs = resolveRetryAfterMs(response, detailObj, defaultRetryAfterMs);
    return wakuError({
      message: `${base}${capability}`,
      code,
      classification,
      verb,
      collection,
      status: response.status,
      retryAfterMs,
      retryAt: now() + retryAfterMs,
    });
  }

  return {
    async insert(collection: string, doc: Record<string, Json>): Promise<WakuRow> {
      assertWritableDoc(doc, 'insert', collection);
      return toRow(await call('insert', collection, { doc }));
    },

    async upsert(collection: string, key: string, doc: Record<string, Json>): Promise<WakuRow> {
      if (!KEY_RE.test(key)) {
        throw invalidRequest('key must be 1-64 chars of [A-Za-z0-9._:-]', 'upsert', collection, 'key');
      }
      assertWritableDoc(doc, 'upsert', collection);
      return toRow(await call('upsert', collection, { key, doc }));
    },

    async query(collection: string, params: WakuQueryParams): Promise<WakuPage> {
      assertQueryParams(params, collection);
      const body: Record<string, Json> = {};
      if (params.filter !== undefined) body['filter'] = params.filter as unknown as Json;
      if (params.sort !== undefined) body['sort'] = params.sort as unknown as Json;
      if (params.limit !== undefined) body['limit'] = params.limit;
      if (params.cursor !== undefined && params.cursor.length > 0) body['cursor'] = params.cursor;

      const payload = await call('query', collection, body);
      const rawRows = payload['rows'];
      const rows = Array.isArray(rawRows)
        ? rawRows.map((row) => toRow(asRecord(row) ?? {}))
        : [];
      return {
        rows,
        nextCursor: typeof payload['nextCursor'] === 'string' ? payload['nextCursor'] : null,
        hasMore: payload['hasMore'] === true,
      };
    },

    async delete(
      collection: string,
      target: { docId: string } | { key: string },
    ): Promise<{ ok: true }> {
      const body: Record<string, Json> =
        'docId' in target ? { docId: target.docId } : { key: target.key };
      await call('delete', collection, body);
      return { ok: true };
    },
  };
}

function resolveRetryAfterMs(
  response: FetchResponseLike,
  detailObj: Record<string, Json> | null,
  fallbackMs: number,
): number {
  const header = response.headers.get('Retry-After');
  // HTTP-date 形式的 Retry-After 我们不解析（平台只发秒数）——回落默认值，绝不产出 NaN。
  if (header !== null && /^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  const fromBody = detailObj?.['retry_after_sec'];
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) {
    return fromBody * 1000;
  }
  return fallbackMs;
}

function codeOfUnknown(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>)['code'];
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return fallback;
}
