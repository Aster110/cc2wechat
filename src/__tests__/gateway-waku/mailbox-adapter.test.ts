/**
 * M2 · WakuMailboxAdapter（RED）
 *
 * 冻结对象：任务书 §4.2「轮询、分页、游标、分片组装、send/receipt」+「自适应轮询」
 * + §4.3/§4.4/§4.5 的全部矩阵；对上层暴露的是架构 §4.1 的 `ChannelAdapter`。
 *
 * 三条不可让步的边界：
 * 1. **adapter 不做密码学**。它只负责「把行拼成完整分片集合」交给注入的 opener，
 *    以及把 opener 封好的分片写进 Waku。InboundEnvelope 里不许出现 nonce / ciphertext。
 * 2. **direction 与 createdAt 不是客户端自报字段**。架构 §7 的 collection 字段表里
 *    没有 direction（由 collection 推出：inbox=to_agent、outbox=to_player），也没有
 *    createdAt（平台保留字段，客户端自报会被静默剥除，真值来自服务端行元数据）。
 *    direction 进 AAD，让客户端自报 = 自己给自己开跨方向重放的门。
 * 3. **平台 keyset cursor 绝不落库**。它把 filter/sort 编进 spec hash，路由集合一变就
 *    `datastore_invalid_cursor`；持久的是 `(lastCreatedAt,lastMessageId)`，平台 cursor
 *    只在单轮翻页里用。
 *
 * 本文件用 FakeWakuServer 做真实传输语义（限速/配额/policy/首页缓存/keyset 翻页），
 * 用一个薄的 TestDataClient 把它包成 data-client 的契约形状——adapter 的依赖全是构造注入。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  COLLECTIONS,
  FakeScheduler,
  FakeWakuServer,
  PLATFORM,
  captureAsync,
  lazyModule,
  type Json,
  type TimerSeam,
} from './fake-waku.js';

// ---------------------------------------------------------------------------
// 测试侧契约（M1 已冻结的形状只读镜像，不 import M1 测试）
// ---------------------------------------------------------------------------

type MailboxDirection = 'to_agent' | 'to_player';
type MailboxKind = 'pair' | 'turn' | 'control' | 'progress' | 'final' | 'error' | 'ack';

type MailboxChunk = {
  protocolVersion: number;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  keyVersion: number;
  chunkIndex: number;
  chunkCount: number;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  payload: { ciphertext: string };
};

type SecurePayload =
  | { type: 'turn'; conversationId: string; text: string; clientSeq: number }
  | { type: 'control'; op: 'stop' | 'new' | 'resume'; conversationId: string; targetTurnId?: string }
  | { type: 'ack'; ackMessageId: string; status: 'received' | 'completed' | 'displayed' };

type IngressAck = { status: 'accepted' } | { status: 'duplicate' } | { status: 'rejected'; code: string };

type DeliveryReceipt =
  | { status: 'sent'; externalDeliveryId?: string }
  | { status: 'retryable'; code: string; retryAfterMs?: number }
  | { status: 'permanent-failure'; code: string }
  | { status: 'unknown'; code: string };

type ChannelDescriptor = {
  type: 'waku';
  instanceId: string;
  protocolVersion: 1;
  capabilities: { progress: boolean; presence: boolean; attachments: boolean; maxMessageBytes: number };
};

type InboundEnvelope = {
  channel: 'waku';
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  createdAt: number;
  expiresAt: number;
  receivedAt: number;
  payload: SecurePayload;
};

type OutboundEnvelope = {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  expiresAt: number;
  payload: SecurePayload;
};

type OpenInput = {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  chunks: MailboxChunk[];
};

type SealInput = {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  payload: SecurePayload;
};

/** 密码学的唯一入口，由 M1 的 crypto/chunking 实现，adapter 只是调用方。 */
type MailboxOpener = {
  open(input: OpenInput): Promise<SecurePayload>;
  seal(input: SealInput): Promise<MailboxChunk[]>;
};

/** M1 chunk_assemblies 的窄投影（sqlite-store 实现它）。 */
type ChunkAssemblyStore = {
  save(chunk: MailboxChunk): 'inserted' | 'duplicate' | 'conflict';
  /** 齐块才返回（按 index 升序）并原子清理；未齐或已过期返回 null。 */
  take(messageId: string, now: number): MailboxChunk[] | null;
  drop(messageId: string): void;
};

type WakuRow = {
  docId: string;
  createdAt: number;
  updatedAt: number;
  owner: { displayName: string; isMe: boolean };
  key?: string;
  doc: Record<string, Json>;
};

type WakuPage = { rows: WakuRow[]; nextCursor: string | null; hasMore: boolean };
type WakuFilter = { field: string; op: string; value: Json };
type WakuQueryParams = { filter?: WakuFilter[]; sort?: string | [string, 'asc' | 'desc']; limit?: number; cursor?: string };

type WakuDataClientSeam = {
  insert(collection: string, doc: Record<string, Json>): Promise<WakuRow>;
  upsert(collection: string, key: string, doc: Record<string, Json>): Promise<WakuRow>;
  query(collection: string, params: WakuQueryParams): Promise<WakuPage>;
  delete(collection: string, target: { docId: string } | { key: string }): Promise<{ ok: true }>;
};

type MailboxCursor = { lastCreatedAt: number; lastMessageId: string };
type SeenKey = { collection: string; messageId: string; chunkIndex: number };

type WakuCursorStoreSeam = {
  scanFloor(collection: string): number | null;
  isDuplicate(key: SeenKey): boolean;
  advance(collection: string, row: { createdAt: number; messageId: string; chunkIndex: number }): void;
  reset(collection: string, reason: string): void;
  current(collection: string): MailboxCursor | null;
  lagMs(collection: string, now: number): number;
};

type CleanupReport = {
  deleted: string[];
  /** 平台只允许删自己的行——玩家的行永远删不掉，必须如实上报，不许冒充成功。 */
  notPermitted: string[];
  failed: Array<{ messageId: string; code: string }>;
};

type MailboxHealth = {
  ok: boolean;
  state: 'running' | 'degraded' | 'stopped';
  cursorLagMs: number;
  pendingOutbox: number;
  rateLimitedCount: number;
  rejectedCount: number;
  lastPollAt: number | null;
};

type PollConfig = {
  activeMinMs: number;
  activeMaxMs: number;
  idleMinMs: number;
  idleMaxMs: number;
  idleAfterEmptyPolls: number;
};

type WakuMailboxAdapterApi = {
  readonly descriptor: ChannelDescriptor;
  start(sink: (envelope: InboundEnvelope) => Promise<IngressAck>): Promise<void>;
  send(envelope: OutboundEnvelope): Promise<DeliveryReceipt>;
  heartbeat(input: { routeId: string; payload: SecurePayload; keyVersion: number; expiresAt: number }): Promise<DeliveryReceipt>;
  cleanupOutbox(messageIds: string[]): Promise<CleanupReport>;
  cleanupInbox(messageIds: string[]): Promise<CleanupReport>;
  health(): Promise<MailboxHealth>;
  stop(): Promise<void>;
};

type WakuMailboxAdapterOptions = {
  instanceId: string;
  dataClient: WakuDataClientSeam;
  cursorStore: WakuCursorStoreSeam;
  assemblies: ChunkAssemblyStore;
  opener: MailboxOpener;
  now: () => number;
  timer: TimerSeam;
  routes: () => string[];
  /** 0..1 的抖动源，注入后轮询间隔完全确定。 */
  jitter?: () => number;
  polling?: Partial<PollConfig>;
};

type MailboxAdapterModule = {
  createWakuMailboxAdapter(options: WakuMailboxAdapterOptions): WakuMailboxAdapterApi;
  WAKU_COLLECTIONS: { inbox: string; outbox: string; status: string };
  WAKU_POLL_DEFAULTS: PollConfig;
};

const loadAdapter = lazyModule<MailboxAdapterModule>('../../gateway/channels/waku/mailbox-adapter.js');

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

type ClassifiedError = Error & {
  classification: 'retryable' | 'permanent' | 'unknown' | 'auth' | 'rate-limited';
  code: string;
  status?: number;
  retryAfterMs?: number;
};

function classified(
  message: string,
  classification: ClassifiedError['classification'],
  code: string,
  extra: { status?: number; retryAfterMs?: number } = {},
): ClassifiedError {
  const err = new Error(message) as ClassifiedError;
  return Object.assign(err, { classification, code, ...extra });
}

/** 把 FakeWakuServer 包成 data-client 契约的薄壳（真实语义，不是脚本化桩）。 */
class TestDataClient implements WakuDataClientSeam {
  private readonly server: FakeWakuServer;
  private readonly token: string;
  private readonly sessionId: string;
  private readonly origin: string;
  private readonly apiBaseUrl: string;

  constructor(server: FakeWakuServer, cfg: { token: string; sessionId: string; origin: string; apiBaseUrl: string }) {
    this.server = server;
    this.token = cfg.token;
    this.sessionId = cfg.sessionId;
    this.origin = cfg.origin;
    this.apiBaseUrl = cfg.apiBaseUrl;
  }

  insert(collection: string, doc: Record<string, Json>): Promise<WakuRow> {
    return this.call('insert', collection, { doc }).then((p) => toRow(p));
  }

  upsert(collection: string, key: string, doc: Record<string, Json>): Promise<WakuRow> {
    return this.call('upsert', collection, { key, doc }).then((p) => toRow(p));
  }

  query(collection: string, params: WakuQueryParams): Promise<WakuPage> {
    const body: Record<string, Json> = {};
    if (params.filter) body['filter'] = params.filter as unknown as Json;
    if (params.sort !== undefined) body['sort'] = params.sort as unknown as Json;
    if (params.limit !== undefined) body['limit'] = params.limit;
    if (params.cursor !== undefined) body['cursor'] = params.cursor;
    return this.call('query', collection, body).then((p) => {
      const rows = Array.isArray(p['rows']) ? p['rows'] : [];
      return {
        rows: rows.map((r) => toRow(r as Record<string, Json>)),
        nextCursor: typeof p['nextCursor'] === 'string' ? p['nextCursor'] : null,
        hasMore: p['hasMore'] === true,
      };
    });
  }

  delete(collection: string, target: { docId: string } | { key: string }): Promise<{ ok: true }> {
    return this.call('delete', collection, { ...target }).then(() => ({ ok: true as const }));
  }

  private async call(verb: string, collection: string, body: Record<string, Json>): Promise<Record<string, Json>> {
    const isWrite = verb !== 'query' && verb !== 'get' && verb !== 'count';
    let response;
    try {
      response = await this.server.fetch(`${this.apiBaseUrl}/content-runtime/data/${collection}/${verb}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          Origin: this.origin,
          'X-Runtime-Session-Id': this.sessionId,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw classified(
        `waku ${verb} transport failure`,
        isWrite ? 'unknown' : 'retryable',
        isWrite ? 'waku_write_unknown' : 'waku_network_error',
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    let parseOk = true;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parseOk = false;
    }
    if (!parseOk) {
      throw classified('waku returned a non-JSON body', isWrite ? 'unknown' : 'retryable', 'waku_bad_response', {
        status: response.status,
      });
    }
    const payload = (parsed ?? {}) as Record<string, Json>;
    if (response.ok) return payload;

    const detail = payload['detail'];
    const detailObj = detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, Json>) : null;
    const code = typeof detailObj?.['code'] === 'string' ? String(detailObj['code']) : `http_${response.status}`;
    const message = typeof detailObj?.['message'] === 'string' ? String(detailObj['message']) : String(detail ?? 'waku error');

    if (response.status === 429 && code === 'datastore_rate_limited') {
      const header = response.headers.get('Retry-After');
      const fromHeader = header !== null && /^\d+$/.test(header) ? Number(header) : null;
      const fromBody = typeof detailObj?.['retry_after_sec'] === 'number' ? Number(detailObj['retry_after_sec']) : null;
      const sec = fromHeader ?? fromBody ?? PLATFORM.RATE_LIMIT_RETRY_AFTER_SEC;
      throw classified(message, 'rate-limited', code, { status: 429, retryAfterMs: sec * 1000 });
    }
    if (response.status === 401) throw classified(message, 'auth', 'waku_unauthorized', { status: 401 });
    if (response.status >= 500) throw classified(message, 'retryable', code, { status: response.status });
    const capability = typeof detailObj?.['capability'] === 'string' ? ` (${String(detailObj['capability'])})` : '';
    throw classified(`${message}${capability}`, 'permanent', code, { status: response.status });
  }
}

function toRow(payload: Record<string, Json>): WakuRow {
  const { docId, createdAt, updatedAt, owner, key, ...doc } = payload;
  const ownerObj = owner !== null && typeof owner === 'object' && !Array.isArray(owner) ? (owner as Record<string, Json>) : {};
  const row: WakuRow = {
    docId: String(docId),
    createdAt: Number(createdAt),
    updatedAt: Number(updatedAt),
    owner: { displayName: String(ownerObj['displayName'] ?? 'Player'), isMe: ownerObj['isMe'] === true },
    doc: doc as Record<string, Json>,
  };
  if (typeof key === 'string') row.key = key;
  return row;
}

class MemoryCursorStore implements WakuCursorStoreSeam {
  readonly advanced: Array<{ collection: string; createdAt: number; messageId: string; chunkIndex: number }> = [];
  readonly resets: string[] = [];
  private cursors = new Map<string, MailboxCursor>();
  private seen = new Set<string>();
  overlapMs = 30_000;

  scanFloor(collection: string): number | null {
    const cur = this.cursors.get(collection);
    return cur ? cur.lastCreatedAt - this.overlapMs : null;
  }

  isDuplicate(key: SeenKey): boolean {
    return this.seen.has(`${key.collection} ${key.messageId} ${key.chunkIndex}`);
  }

  advance(collection: string, row: { createdAt: number; messageId: string; chunkIndex: number }): void {
    this.advanced.push({ collection, ...row });
    this.seen.add(`${collection} ${row.messageId} ${row.chunkIndex}`);
    const cur = this.cursors.get(collection);
    if (!cur || row.createdAt > cur.lastCreatedAt || (row.createdAt === cur.lastCreatedAt && row.messageId > cur.lastMessageId)) {
      this.cursors.set(collection, { lastCreatedAt: row.createdAt, lastMessageId: row.messageId });
    }
  }

  reset(collection: string, reason: string): void {
    this.resets.push(`${collection}:${reason}`);
  }

  current(collection: string): MailboxCursor | null {
    return this.cursors.get(collection) ?? null;
  }

  lagMs(collection: string, now: number): number {
    const cur = this.cursors.get(collection);
    return cur ? now - cur.lastCreatedAt : 0;
  }
}

class MemoryAssemblies implements ChunkAssemblyStore {
  private store = new Map<string, Map<number, MailboxChunk>>();
  private counts = new Map<string, number>();

  save(chunk: MailboxChunk): 'inserted' | 'duplicate' | 'conflict' {
    const known = this.counts.get(chunk.messageId);
    if (known !== undefined && known !== chunk.chunkCount) return 'conflict';
    this.counts.set(chunk.messageId, chunk.chunkCount);
    const bucket = this.store.get(chunk.messageId) ?? new Map<number, MailboxChunk>();
    const existing = bucket.get(chunk.chunkIndex);
    if (existing) {
      return existing.payload.ciphertext === chunk.payload.ciphertext ? 'duplicate' : 'conflict';
    }
    bucket.set(chunk.chunkIndex, chunk);
    this.store.set(chunk.messageId, bucket);
    return 'inserted';
  }

  take(messageId: string, now: number): MailboxChunk[] | null {
    const bucket = this.store.get(messageId);
    const count = this.counts.get(messageId);
    if (!bucket || count === undefined || bucket.size < count) return null;
    const chunks = [...bucket.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (chunks.some((c) => now >= c.expiresAt)) {
      this.drop(messageId);
      return null;
    }
    this.drop(messageId);
    return chunks;
  }

  drop(messageId: string): void {
    this.store.delete(messageId);
    this.counts.delete(messageId);
  }

  pendingChunks(messageId: string): number {
    return this.store.get(messageId)?.size ?? 0;
  }
}

class StubOpener implements MailboxOpener {
  readonly openCalls: OpenInput[] = [];
  readonly sealCalls: SealInput[] = [];
  readonly openFailures = new Set<string>();
  sealChunkCount = 1;

  open(input: OpenInput): Promise<SecurePayload> {
    this.openCalls.push(input);
    if (this.openFailures.has(input.messageId)) return Promise.reject(new Error('AEAD tag mismatch'));
    return Promise.resolve({ type: 'turn', conversationId: 'conv-1', text: `plain:${input.messageId}`, clientSeq: input.chunks.length });
  }

  seal(input: SealInput): Promise<MailboxChunk[]> {
    this.sealCalls.push(input);
    const count = this.sealChunkCount;
    const chunks: MailboxChunk[] = [];
    for (let i = 0; i < count; i += 1) {
      chunks.push({
        protocolVersion: 1,
        routeId: input.routeId,
        messageId: input.messageId,
        direction: input.direction,
        kind: input.kind,
        keyVersion: input.keyVersion,
        chunkIndex: i,
        chunkCount: count,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        nonce: randomBytes(12).toString('base64url'),
        payload: { ciphertext: `ct-${input.messageId}-${i}` },
      });
    }
    return Promise.resolve(chunks);
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const API_BASE = 'https://aicap.example.test/api';
const ORIGIN = 'http://127.0.0.1:47311';
const DAEMON_USER = 'usr_daemon';
const PLAYER_USER = 'usr_player';
const ROUTE_A = 'rt-alpha';
const ROUTE_B = 'rt-bravo';
const T0 = 1_760_000_000_000;
const TTL = 10 * 60 * 1000;

function uuid(tag: string): string {
  return `0198f4c1-1111-7000-8000-${tag.padStart(12, '0')}`;
}

let scheduler: FakeScheduler;
let server: FakeWakuServer;
let dataClient: TestDataClient;
let cursorStore: MemoryCursorStore;
let assemblies: MemoryAssemblies;
let opener: StubOpener;
let routes: string[];
let token: string;
let sessionId: string;
let received: InboundEnvelope[];
let sinkResult: IngressAck;
let sinkError: Error | null;

function makeServer(env: 'draft' | 'published' = 'draft', overrides: { writePerMin?: number; publicReadCacheTtlMs?: number } = {}): FakeWakuServer {
  const s = new FakeWakuServer({
    apiBaseUrl: API_BASE,
    origin: ORIGIN,
    userId: DAEMON_USER,
    now: scheduler.now,
    env,
    writePerMin: overrides.writePerMin,
    publicReadCacheTtlMs: overrides.publicReadCacheTtlMs,
  });
  s.defineMailboxCollections();
  s.issueToken({ token, sessionId, expiresAt: T0 + 3_600_000 });
  return s;
}

function chunkDoc(input: {
  routeId: string;
  messageId: string;
  kind?: MailboxKind;
  chunkIndex?: number;
  chunkCount?: number;
  expiresAt?: number;
  ciphertext?: string;
}): Record<string, Json> {
  return {
    protocolVersion: 1,
    routeId: input.routeId,
    messageId: input.messageId,
    kind: input.kind ?? 'turn',
    expiresAt: input.expiresAt ?? T0 + TTL,
    chunkIndex: input.chunkIndex ?? 0,
    chunkCount: input.chunkCount ?? 1,
    keyVersion: 1,
    nonce: randomBytes(12).toString('base64url'),
    payload: { ciphertext: input.ciphertext ?? `ct-${input.messageId}-${input.chunkIndex ?? 0}` },
  };
}

function seedInbound(input: Parameters<typeof chunkDoc>[0] & { createdAt: number; owner?: string }): string {
  return server.seed(COLLECTIONS.inbox, {
    owner: input.owner ?? PLAYER_USER,
    createdAt: input.createdAt,
    doc: chunkDoc(input),
  });
}

async function makeAdapter(overrides: Partial<WakuMailboxAdapterOptions> = {}): Promise<WakuMailboxAdapterApi> {
  const mod = await loadAdapter();
  return mod.createWakuMailboxAdapter({
    instanceId: 'waku-729a',
    dataClient,
    cursorStore,
    assemblies,
    opener,
    now: scheduler.now,
    timer: scheduler,
    routes: () => routes,
    jitter: () => 0,
    ...overrides,
  });
}

const sink = (envelope: InboundEnvelope): Promise<IngressAck> => {
  if (sinkError) return Promise.reject(sinkError);
  received.push(envelope);
  return Promise.resolve(sinkResult);
};

beforeEach(() => {
  scheduler = new FakeScheduler(T0);
  token = `rt_${randomBytes(24).toString('base64url')}`;
  sessionId = `rts_${randomBytes(8).toString('hex')}`;
  server = makeServer();
  dataClient = new TestDataClient(server, { token, sessionId, origin: ORIGIN, apiBaseUrl: API_BASE });
  cursorStore = new MemoryCursorStore();
  assemblies = new MemoryAssemblies();
  opener = new StubOpener();
  routes = [ROUTE_A];
  received = [];
  sinkResult = { status: 'accepted' };
  sinkError = null;
});

// ---------------------------------------------------------------------------
// 描述符与生命周期
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter 描述符与生命周期', () => {
  it('descriptor 与架构 §4.1 一致，maxMessageBytes 是 64 KiB 协议上限', async () => {
    const adapter = await makeAdapter();
    expect(adapter.descriptor.type).toBe('waku');
    expect(adapter.descriptor.protocolVersion).toBe(1);
    expect(adapter.descriptor.instanceId).toBe('waku-729a');
    expect(adapter.descriptor.capabilities.progress).toBe(true);
    expect(adapter.descriptor.capabilities.attachments).toBe(false);
    expect(adapter.descriptor.capabilities.maxMessageBytes).toBe(64 * 1024);
  });

  it('collection 名与轮询默认值就是架构 §7 / 任务书 §4.2 写死的那些', async () => {
    const mod = await loadAdapter();
    expect(mod.WAKU_COLLECTIONS).toEqual({
      inbox: COLLECTIONS.inbox,
      outbox: COLLECTIONS.outbox,
      status: COLLECTIONS.status,
    });
    expect(mod.WAKU_POLL_DEFAULTS.activeMinMs).toBe(1000);
    expect(mod.WAKU_POLL_DEFAULTS.activeMaxMs).toBe(2000);
    expect(mod.WAKU_POLL_DEFAULTS.idleMinMs).toBe(10_000);
    expect(mod.WAKU_POLL_DEFAULTS.idleMaxMs).toBe(30_000);
  });

  it('start 先跑完一轮再 resolve，stop 后清空所有排期', async () => {
    seedInbound({ routeId: ROUTE_A, messageId: uuid('a1'), createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);

    expect(received).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(1);

    await adapter.stop();
    expect(scheduler.pendingCount).toBe(0);
  });

  it('重复 start 拒绝（729a 只能有一个 mailbox 消费者）', async () => {
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await captureAsync(() => adapter.start(sink));
    await adapter.stop();
  });

  it('stop 之后 send 不再写 Waku，返回 permanent-failure', async () => {
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    const receipt = await adapter.send({
      routeId: ROUTE_A,
      messageId: uuid('f1'),
      kind: 'final',
      keyVersion: 1,
      expiresAt: T0 + TTL,
      payload: { type: 'ack', ackMessageId: uuid('a1'), status: 'completed' },
    });
    expect(receipt.status).toBe('permanent-failure');
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 入站：查询形状、分页、组装
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter 入站轮询', () => {
  it('一次轮询用 op:"in" 带上全部 active routeId（读额度只有 300/分钟，不能每人一次）', async () => {
    routes = [ROUTE_A, ROUTE_B];
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    const calls = server.callsOf('query', COLLECTIONS.inbox);
    expect(calls).toHaveLength(1);
    const filter = calls[0].body['filter'];
    expect(Array.isArray(filter)).toBe(true);
    const routeCond = (filter as Array<Record<string, Json>>).find((f) => f['field'] === 'routeId');
    expect(routeCond?.['op']).toBe('in');
    expect(routeCond?.['value']).toEqual([ROUTE_A, ROUTE_B]);
    expect(calls[0].body['sort']).toBe('createdAt');
    expect(calls[0].body['limit']).toBe(PLATFORM.QUERY_PAGE_LIMIT);
  });

  it('有游标时按 createdAt 下界回扫，且下界来自 cursorStore.scanFloor', async () => {
    cursorStore.advance(COLLECTIONS.inbox, { createdAt: T0, messageId: uuid('a0'), chunkIndex: 0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    const filter = server.callsOf('query', COLLECTIONS.inbox)[0].body['filter'] as Array<Record<string, Json>>;
    const timeCond = filter.find((f) => f['field'] === 'createdAt');
    expect(timeCond?.['op']).toBe('gt');
    expect(timeCond?.['value']).toBe(cursorStore.scanFloor(COLLECTIONS.inbox));
  });

  it('单块消息：opener 拿到完整分片集合，Core 拿到解出的 SecurePayload', async () => {
    const messageId = uuid('a1');
    seedInbound({ routeId: ROUTE_A, messageId, createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(opener.openCalls).toHaveLength(1);
    expect(opener.openCalls[0].chunks.map((c) => c.chunkIndex)).toEqual([0]);
    expect(received).toHaveLength(1);
    expect(received[0].messageId).toBe(messageId);
    expect(received[0].routeId).toBe(ROUTE_A);
    expect(received[0].payload).toEqual({ type: 'turn', conversationId: 'conv-1', text: `plain:${messageId}`, clientSeq: 1 });
  });

  it('direction 由 collection 推出、createdAt 取平台行元数据——都不是客户端自报字段', async () => {
    const messageId = uuid('a1');
    // 客户端在 doc 里自报 createdAt / direction：平台会剥掉 createdAt，direction 根本没这个字段。
    server.seed(COLLECTIONS.inbox, {
      owner: PLAYER_USER,
      createdAt: T0 + 4_242,
      doc: chunkDoc({ routeId: ROUTE_A, messageId }),
    });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(opener.openCalls[0].direction).toBe('to_agent');
    expect(opener.openCalls[0].chunks[0].direction).toBe('to_agent');
    expect(opener.openCalls[0].chunks[0].createdAt).toBe(T0 + 4_242);
    expect(received[0].createdAt).toBe(T0 + 4_242);
  });

  it('InboundEnvelope 不带任何密文材料（nonce / ciphertext 不许漏进 Core）', async () => {
    seedInbound({ routeId: ROUTE_A, messageId: uuid('a1'), createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    const dump = JSON.stringify(received[0]);
    expect(dump).not.toContain('ciphertext');
    expect(dump).not.toContain('nonce');
    expect(Object.keys(received[0]).sort()).toEqual([
      'channel',
      'createdAt',
      'expiresAt',
      'keyVersion',
      'kind',
      'messageId',
      'payload',
      'receivedAt',
      'routeId',
    ]);
  });

  it('多页：翻页用平台 nextCursor，按 createdAt 顺序交给 Core，且平台 cursor 绝不落库', async () => {
    for (let i = 0; i < 120; i += 1) {
      seedInbound({ routeId: ROUTE_A, messageId: uuid(`b${i}`), createdAt: T0 + i });
    }
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    const calls = server.callsOf('query', COLLECTIONS.inbox);
    expect(calls).toHaveLength(2);
    expect(calls[0].body['cursor']).toBeUndefined();
    expect(typeof calls[1].body['cursor']).toBe('string');

    expect(received).toHaveLength(120);
    expect(received.map((e) => e.createdAt)).toEqual([...received.map((e) => e.createdAt)].sort((a, b) => a - b));
    // 落库的只有 (createdAt,messageId,chunkIndex)——没有任何平台 cursor 串。
    for (const entry of cursorStore.advanced) {
      expect(typeof entry.messageId).toBe('string');
      expect(entry.messageId).not.toContain('eyJ');
    }
  });

  it('分片跨页：chunk0 与 chunk1 落在不同页，收齐后才 open 一次、投递一次', async () => {
    const messageId = uuid('c1');
    for (let i = 0; i < 99; i += 1) {
      seedInbound({ routeId: ROUTE_A, messageId: uuid(`d${i}`), createdAt: T0 + i });
    }
    seedInbound({ routeId: ROUTE_A, messageId, chunkIndex: 0, chunkCount: 2, createdAt: T0 + 200 });
    seedInbound({ routeId: ROUTE_A, messageId, chunkIndex: 1, chunkCount: 2, createdAt: T0 + 201 });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(server.callsOf('query', COLLECTIONS.inbox).length).toBeGreaterThan(1);
    const opened = opener.openCalls.filter((c) => c.messageId === messageId);
    expect(opened).toHaveLength(1);
    expect(opened[0].chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect(received.filter((e) => e.messageId === messageId)).toHaveLength(1);
  });

  it('缺块的消息不进 Core，但已到的分片被持久（下轮补齐即可，不必重扫全表）', async () => {
    const messageId = uuid('e1');
    seedInbound({ routeId: ROUTE_A, messageId, chunkIndex: 0, chunkCount: 2, createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);

    expect(received).toHaveLength(0);
    expect(opener.openCalls).toHaveLength(0);
    expect(assemblies.pendingChunks(messageId)).toBe(1);

    seedInbound({ routeId: ROUTE_A, messageId, chunkIndex: 1, chunkCount: 2, createdAt: T0 + 10 });
    await scheduler.advance(1000);
    await adapter.stop();

    expect(received.filter((e) => e.messageId === messageId)).toHaveLength(1);
  });

  it('冲突重复块（同 index 不同密文 / chunkCount 打架）被丢弃，不交 Core 且轮询不中断', async () => {
    const bad = uuid('f1');
    seedInbound({ routeId: ROUTE_A, messageId: bad, chunkIndex: 0, chunkCount: 2, createdAt: T0, ciphertext: 'ct-one' });
    seedInbound({ routeId: ROUTE_A, messageId: bad, chunkIndex: 0, chunkCount: 2, createdAt: T0 + 1, ciphertext: 'ct-two' });
    seedInbound({ routeId: ROUTE_A, messageId: uuid('f2'), createdAt: T0 + 2 });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    const health = await adapter.health();
    await adapter.stop();

    expect(received.map((e) => e.messageId)).toEqual([uuid('f2')]);
    expect(health.rejectedCount).toBeGreaterThan(0);
    expect(health.state).toBe('running');
  });

  it('过期消息（now >= expiresAt）不进 Core', async () => {
    seedInbound({ routeId: ROUTE_A, messageId: uuid('g1'), createdAt: T0 - 1000, expiresAt: T0 });
    seedInbound({ routeId: ROUTE_A, messageId: uuid('g2'), createdAt: T0, expiresAt: T0 + TTL });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(received.map((e) => e.messageId)).toEqual([uuid('g2')]);
  });

  it('opener 解密失败（错 key/AAD）不当成 Agent 回复，只丢这一条', async () => {
    const bad = uuid('h1');
    opener.openFailures.add(bad);
    seedInbound({ routeId: ROUTE_A, messageId: bad, createdAt: T0 });
    seedInbound({ routeId: ROUTE_A, messageId: uuid('h2'), createdAt: T0 + 1 });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(received.map((e) => e.messageId)).toEqual([uuid('h2')]);
  });
});

// ---------------------------------------------------------------------------
// 幂等、垃圾行、路由隔离
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter 幂等与隔离', () => {
  it('回扫窗内重新扫到的同一行被去重，不再打扰 Core', async () => {
    seedInbound({ routeId: ROUTE_A, messageId: uuid('i1'), createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await scheduler.advance(1000);
    await adapter.stop();

    expect(server.callsOf('query', COLLECTIONS.inbox).length).toBeGreaterThan(1);
    expect(received).toHaveLength(1);
    expect(opener.openCalls).toHaveLength(1);
  });

  it('sink 回 duplicate 时游标照样推进（否则重放会把游标钉死在原地）', async () => {
    sinkResult = { status: 'duplicate' };
    seedInbound({ routeId: ROUTE_A, messageId: uuid('j1'), createdAt: T0 + 50 });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(cursorStore.current(COLLECTIONS.inbox)?.lastCreatedAt).toBe(T0 + 50);
  });

  it('sink 回 rejected 也推进游标并计数（垃圾行不能被无限重投）', async () => {
    sinkResult = { status: 'rejected', code: 'pairing_revoked' };
    seedInbound({ routeId: ROUTE_A, messageId: uuid('k1'), createdAt: T0 + 60 });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    const health = await adapter.health();
    await adapter.stop();

    expect(cursorStore.current(COLLECTIONS.inbox)?.lastCreatedAt).toBe(T0 + 60);
    expect(health.rejectedCount).toBe(1);
  });

  it('sink 抛错时游标不推进（下一轮重投），轮询循环不死', async () => {
    sinkError = new Error('sqlite is locked');
    seedInbound({ routeId: ROUTE_A, messageId: uuid('l1'), createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);

    expect(cursorStore.current(COLLECTIONS.inbox)).toBeNull();
    expect(scheduler.pendingCount).toBe(1);

    sinkError = null;
    await scheduler.advance(1000);
    await adapter.stop();
    expect(received).toHaveLength(1);
  });

  it('两个 routeId 交错时各归各的；不在 routes 里的行一概不碰', async () => {
    routes = [ROUTE_A, ROUTE_B];
    seedInbound({ routeId: ROUTE_A, messageId: uuid('m1'), createdAt: T0 });
    seedInbound({ routeId: ROUTE_B, messageId: uuid('m2'), createdAt: T0 + 1 });
    seedInbound({ routeId: 'rt-stranger', messageId: uuid('m3'), createdAt: T0 + 2 });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(received.map((e) => e.routeId)).toEqual([ROUTE_A, ROUTE_B]);
    expect(received.map((e) => e.messageId)).not.toContain(uuid('m3'));
  });

  it('公共 append-only 集合里的垃圾行（缺字段/坏值）跳过并计数，合法行照常投递', async () => {
    server.seed(COLLECTIONS.inbox, {
      owner: PLAYER_USER,
      createdAt: T0,
      doc: { protocolVersion: 1, routeId: ROUTE_A, messageId: 'not-a-uuid', kind: 'turn', expiresAt: T0 + TTL, chunkIndex: 0, chunkCount: 0, keyVersion: 1, nonce: '', payload: { ciphertext: '' } },
    });
    seedInbound({ routeId: ROUTE_A, messageId: uuid('n2'), createdAt: T0 + 1 });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    const health = await adapter.health();
    await adapter.stop();

    expect(received.map((e) => e.messageId)).toEqual([uuid('n2')]);
    expect(health.rejectedCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// published env 的 5s 首页缓存
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter 对抗公共读首页缓存', () => {
  it('published 分区下 5s 缓存会藏住新消息，但靠回扫游标最终不重不漏', async () => {
    server = makeServer('published');
    dataClient = new TestDataClient(server, { token, sessionId, origin: ORIGIN, apiBaseUrl: API_BASE });
    seedInbound({ routeId: ROUTE_A, messageId: uuid('p1'), createdAt: T0 });

    const adapter = await makeAdapter();
    await adapter.start(sink); // T0：读到 p1，游标 → T0
    expect(received.map((e) => e.messageId)).toEqual([uuid('p1')]);

    await scheduler.advance(2000); // T0+2000：空轮，这一轮的结果进了 5s 缓存
    expect(received).toHaveLength(1);

    seedInbound({ routeId: ROUTE_A, messageId: uuid('p2'), createdAt: T0 + 3000 });
    await scheduler.advance(2000); // T0+4000：命中缓存 → 看不见 p2（这就是那个坑）
    expect(received).toHaveLength(1);

    await scheduler.advance(20_000); // 缓存过期后，回扫窗内重新扫到 p2
    await adapter.stop();

    expect(received.map((e) => e.messageId)).toEqual([uuid('p1'), uuid('p2')]);
  });
});

// ---------------------------------------------------------------------------
// 出站 send / receipt
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter 出站投递', () => {
  const outbound: OutboundEnvelope = {
    routeId: ROUTE_A,
    messageId: uuid('o1'),
    kind: 'final',
    keyVersion: 1,
    expiresAt: T0 + TTL,
    payload: { type: 'ack', ackMessageId: uuid('a1'), status: 'completed' },
  };

  it('seal → 逐块 insert outbox → receipt sent，externalDeliveryId 是首块 docId', async () => {
    opener.sealChunkCount = 2;
    const adapter = await makeAdapter();
    const receipt = await adapter.send(outbound);

    expect(receipt.status).toBe('sent');
    expect(opener.sealCalls[0].direction).toBe('to_player');
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(2);
    if (receipt.status === 'sent') {
      expect(receipt.externalDeliveryId).toBe(server.rows(COLLECTIONS.outbox)[0].docId);
    }
  });

  it('429 → retryable 并把 Retry-After 透传给上层（不自己吞掉退避信息）', async () => {
    server.enqueueFault({
      kind: 'status',
      status: 429,
      match: { verb: 'insert' },
      body: { detail: { code: 'datastore_rate_limited', message: 'slow down', retry_after_sec: 12 } },
      headers: { 'Retry-After': '12' },
    });
    const adapter = await makeAdapter();
    const receipt = await adapter.send(outbound);

    expect(receipt.status).toBe('retryable');
    if (receipt.status === 'retryable') expect(receipt.retryAfterMs).toBe(12_000);
  });

  it('5xx → retryable', async () => {
    server.enqueueFault({ kind: 'status', status: 503, match: { verb: 'insert' }, body: { detail: 'unavailable' } });
    const adapter = await makeAdapter();
    expect((await adapter.send(outbound)).status).toBe('retryable');
  });

  it('policy/配额类错误 → permanent-failure（重试再多次也没用）', async () => {
    server.enqueueFault({
      kind: 'status',
      status: 403,
      match: { verb: 'insert' },
      body: { detail: { code: 'datastore_policy_denied', message: 'append_only' } },
    });
    const adapter = await makeAdapter();
    expect((await adapter.send(outbound)).status).toBe('permanent-failure');
  });

  it('写超时返 unknown；重发**不换 messageId**，且只补缺失的分片不造重复行', async () => {
    opener.sealChunkCount = 2;
    // 第一块落库了但客户端没收到响应，第二块根本没发出去。
    server.enqueueFault({ kind: 'network', match: { verb: 'insert' }, applyWrite: true });

    const adapter = await makeAdapter();
    const first = await adapter.send(outbound);
    expect(first.status).toBe('unknown');
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(1);

    const second = await adapter.send(outbound);
    expect(second.status).toBe('sent');
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(2);

    const written = server.rows(COLLECTIONS.outbox);
    expect(new Set(written.map((r) => String(r.doc['messageId'])))).toEqual(new Set([outbound.messageId]));
    expect(written.map((r) => Number(r.doc['chunkIndex'])).sort()).toEqual([0, 1]);
  });

  it('超过 16 块 / 64 KiB 协议上限的消息直接 permanent-failure，不发一半', async () => {
    opener.sealChunkCount = 17;
    const adapter = await makeAdapter();
    const receipt = await adapter.send(outbound);

    expect(receipt.status).toBe('permanent-failure');
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(0);
  });

  it('写额度打满时是 retryable 而不是丢件，pending 计数可见', async () => {
    server = makeServer('draft', { writePerMin: 1 });
    dataClient = new TestDataClient(server, { token, sessionId, origin: ORIGIN, apiBaseUrl: API_BASE });
    opener.sealChunkCount = 2;

    const adapter = await makeAdapter();
    const receipt = await adapter.send(outbound);
    const health = await adapter.health();

    expect(receipt.status).toBe('retryable');
    expect(health.rateLimitedCount).toBeGreaterThan(0);
    expect(health.pendingOutbox).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 心跳与 ack 清理
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter 心跳与清理', () => {
  it('心跳走 upsert（按 routeId 作 key），重复心跳行数不涨', async () => {
    const adapter = await makeAdapter();
    const beat = {
      routeId: ROUTE_A,
      keyVersion: 1,
      expiresAt: T0 + TTL,
      payload: { type: 'ack' as const, ackMessageId: uuid('a1'), status: 'received' as const },
    };
    await adapter.heartbeat(beat);
    await scheduler.advance(30_000);
    await adapter.heartbeat(beat);
    await adapter.stop();

    expect(server.callsOf('upsert', COLLECTIONS.status)).toHaveLength(2);
    expect(server.callsOf('insert', COLLECTIONS.status)).toHaveLength(0);
    expect(server.rowCount(COLLECTIONS.status)).toBe(1);
    expect(server.callsOf('upsert', COLLECTIONS.status)[0].body['key']).toBe(ROUTE_A);
  });

  it('玩家 ack 后 daemon 删掉自己的 outbox 行，报告里列出被删的 messageId', async () => {
    const adapter = await makeAdapter();
    await adapter.send({
      routeId: ROUTE_A,
      messageId: uuid('q1'),
      kind: 'final',
      keyVersion: 1,
      expiresAt: T0 + TTL,
      payload: { type: 'ack', ackMessageId: uuid('a1'), status: 'completed' },
    });
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(1);

    const report = await adapter.cleanupOutbox([uuid('q1')]);
    expect(report.deleted).toEqual([uuid('q1')]);
    expect(report.notPermitted).toEqual([]);
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(0);
  });

  it('玩家的 inbox 行 daemon 删不掉：如实报 notPermitted，绝不冒充清理成功', async () => {
    const messageId = uuid('r1');
    seedInbound({ routeId: ROUTE_A, messageId, createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);

    const report = await adapter.cleanupInbox([messageId]);
    await adapter.stop();

    expect(report.deleted).toEqual([]);
    expect(report.notPermitted).toEqual([messageId]);
    expect(server.rowCount(COLLECTIONS.inbox)).toBe(1);
  });

  it('清理时的传输故障进 failed，不被算成 deleted', async () => {
    const adapter = await makeAdapter();
    await adapter.send({
      routeId: ROUTE_A,
      messageId: uuid('s1'),
      kind: 'final',
      keyVersion: 1,
      expiresAt: T0 + TTL,
      payload: { type: 'ack', ackMessageId: uuid('a1'), status: 'completed' },
    });
    server.enqueueFault({ kind: 'status', status: 503, match: { verb: 'delete' }, body: { detail: 'unavailable' } });

    const report = await adapter.cleanupOutbox([uuid('s1')]);
    expect(report.deleted).toEqual([]);
    expect(report.failed.map((f) => f.messageId)).toEqual([uuid('s1')]);
    expect(server.rowCount(COLLECTIONS.outbox)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 自适应轮询
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter 自适应轮询', () => {
  it('有消息时下一轮排在 active 区间（jitter=0 → 下界）', async () => {
    seedInbound({ routeId: ROUTE_A, messageId: uuid('t1'), createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);

    expect(scheduler.pendingDelays()).toEqual([1000]);
    await adapter.stop();
  });

  it('jitter=1 时取 active 上界（抖动源是注入的，不是 Math.random）', async () => {
    seedInbound({ routeId: ROUTE_A, messageId: uuid('t2'), createdAt: T0 });
    const adapter = await makeAdapter({ jitter: () => 1 });
    await adapter.start(sink);

    expect(scheduler.pendingDelays()).toEqual([2000]);
    await adapter.stop();
  });

  it('连续空轮逐步退到 idle 区间，来消息立刻回 active', async () => {
    const adapter = await makeAdapter({ polling: { idleAfterEmptyPolls: 2 } });
    await adapter.start(sink);
    expect(scheduler.pendingDelays()).toEqual([1000]);

    await scheduler.advance(1000);
    await scheduler.advance(1000);
    expect(scheduler.pendingDelays()).toEqual([10_000]);

    seedInbound({ routeId: ROUTE_A, messageId: uuid('u1'), createdAt: scheduler.now() + 1 });
    await scheduler.advance(10_000);
    expect(received).toHaveLength(1);
    expect(scheduler.pendingDelays()).toEqual([1000]);
    await adapter.stop();
  });

  it('429 时下一轮听 Retry-After（压过自适应节奏），且 cursor 不丢', async () => {
    cursorStore.advance(COLLECTIONS.inbox, { createdAt: T0, messageId: uuid('v0'), chunkIndex: 0 });
    server.enqueueFault({
      kind: 'status',
      status: 429,
      match: { verb: 'query' },
      body: { detail: { code: 'datastore_rate_limited', message: 'slow down', retry_after_sec: 9 } },
      headers: { 'Retry-After': '9' },
    });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    const health = await adapter.health();

    expect(scheduler.pendingDelays()).toEqual([9000]);
    expect(health.rateLimitedCount).toBe(1);
    expect(cursorStore.current(COLLECTIONS.inbox)).toEqual({ lastCreatedAt: T0, lastMessageId: uuid('v0') });
    await adapter.stop();
  });

  it('datastore_invalid_cursor 触发 cursorStore.reset 并在下一轮重扫，不是硬崩', async () => {
    cursorStore.advance(COLLECTIONS.inbox, { createdAt: T0, messageId: uuid('w0'), chunkIndex: 0 });
    server.enqueueFault({
      kind: 'status',
      status: 400,
      match: { verb: 'query' },
      body: { detail: { code: 'datastore_invalid_cursor', message: 'cursor does not match query' } },
    });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();

    expect(cursorStore.resets.some((r) => r.includes('datastore_invalid_cursor'))).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('401 让 mailbox 进 degraded 但不丢 cursor/pending（凭证问题不等于 runner 问题）', async () => {
    server.enqueueFault({ kind: 'status', status: 401, match: { verb: 'query' }, body: { detail: 'invalid or expired token' } });
    cursorStore.advance(COLLECTIONS.inbox, { createdAt: T0, messageId: uuid('x0'), chunkIndex: 0 });

    const adapter = await makeAdapter();
    await adapter.start(sink);
    const health = await adapter.health();
    await adapter.stop();

    expect(health.state).toBe('degraded');
    expect(health.ok).toBe(false);
    expect(cursorStore.current(COLLECTIONS.inbox)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// health 脱敏
// ---------------------------------------------------------------------------

describe('M2 · WakuMailboxAdapter health', () => {
  it('health 给出 cursorLag / pendingOutbox / 429 计数，且不含 token 与完整 routeId', async () => {
    seedInbound({ routeId: ROUTE_A, messageId: uuid('y1'), createdAt: T0 });
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await scheduler.advance(1200);
    const health = await adapter.health();
    await adapter.stop();

    expect(health.ok).toBe(true);
    expect(health.state).toBe('running');
    expect(health.cursorLagMs).toBeGreaterThanOrEqual(1200);
    expect(health.pendingOutbox).toBe(0);
    expect(health.lastPollAt).not.toBeNull();

    const dump = JSON.stringify(health);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(sessionId);
    expect(dump).not.toContain(ROUTE_A);
    expect(dump).not.toContain('plain:');
  });

  it('stop 之后 health 是 stopped，且不再产生任何 Waku 请求', async () => {
    const adapter = await makeAdapter();
    await adapter.start(sink);
    await adapter.stop();
    const before = server.requests.length;

    await scheduler.advance(60_000);
    const health = await adapter.health();

    expect(health.state).toBe('stopped');
    expect(server.requests.length).toBe(before);
  });
});
