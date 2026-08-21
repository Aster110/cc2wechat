/**
 * Waku mailbox 通道适配器（架构 §4.1 ChannelAdapter / 任务书 §4.2）。
 *
 * 三条不可让步的边界：
 * 1. **adapter 不做密码学**。它只把"拼齐的分片集合"交给注入的 opener，再把 opener 封好的
 *    分片写进 Waku。`InboundEnvelope` 里不许出现 nonce / ciphertext。
 * 2. **direction 与 createdAt 不是客户端自报字段**。direction 由 collection 推出
 *    （inbox=to_agent、outbox/status=to_player）并进 AAD；createdAt 取平台行元数据
 *    （客户端自报会被静默剥除）。自报 direction = 自己给自己开跨方向重放的门。
 * 3. **平台 keyset cursor 绝不落库**。它把 filter/sort 编进 spec hash，路由集合一变
 *    （新配对上线）旧 cursor 立刻 `datastore_invalid_cursor`；持久的是
 *    `(lastCreatedAt,lastMessageId)`，平台 nextCursor 只在单轮翻页里用。
 *
 * 还要对抗平台的两个真实坑：
 * - published 分区公共读**首页 5s 缓存**会藏住新消息 → 靠 cursorStore 的回扫窗兜底，
 *   最终一致且不重（去重键是 `(collection,messageId,chunkIndex)`）。
 * - 读额度 300/分钟 → 一轮轮询用 `op:"in"` 一次带上全部 active routeId，不是每人一次。
 */
import { randomBytes } from 'node:crypto';

import {
  CHANNEL_PROTOCOL_VERSION,
  type ChannelDescriptor,
  type DeliveryReceipt,
  type IngressAck,
} from '../../contracts/channel.js';
import {
  MAILBOX_KINDS,
  MAILBOX_PROTOCOL_VERSION,
  MAX_CHUNK_COUNT,
  MAX_MESSAGE_BYTES,
  NONCE_BYTES,
  type MailboxChunk,
  type MailboxDirection,
  type MailboxKind,
  type SecurePayload,
} from '../../contracts/envelope.js';
import { decodeBase64Url } from '../../contracts/validation.js';
import {
  WAKU_DEFAULT_RETRY_AFTER_MS,
  WAKU_QUERY_PAGE_LIMIT,
  classificationOf,
  codeOf,
  retryAfterMsOf,
  type Json,
  type WakuFilter,
  type WakuQueryParams,
  type WakuRow,
} from './data-client.js';
import type { WakuCursorStore } from './cursor-store.js';

// ---------------------------------------------------------------------------
// 冻结常量
// ---------------------------------------------------------------------------

export const WAKU_COLLECTIONS = {
  inbox: 'agent_inbox_v1',
  outbox: 'agent_outbox_v1',
  status: 'agent_status_v1',
} as const;

export interface PollConfig {
  activeMinMs: number;
  activeMaxMs: number;
  idleMinMs: number;
  idleMaxMs: number;
  idleAfterEmptyPolls: number;
}

export const WAKU_POLL_DEFAULTS: PollConfig = {
  activeMinMs: 1000,
  activeMaxMs: 2000,
  // 空闲档不是"省"，是延迟地板：用户隔几小时发第一条，正撞在这个间隙里。
  // 实测旧值（10~30s）冷启平均白等 ~20s，而这一档只值 ~11 读/min（读预算的 3.6%）。
  idleMinMs: 3_000,
  idleMaxMs: 8_000,
  idleAfterEmptyPolls: 3,
};

/** 单轮轮询最多翻的页数——防止游标坏掉时一轮把读额度烧干。 */
const MAX_PAGES_PER_POLL = 20;

// ---------------------------------------------------------------------------
// 注入接缝
// ---------------------------------------------------------------------------

export interface InboundEnvelope {
  channel: 'waku';
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  createdAt: number;
  expiresAt: number;
  receivedAt: number;
  payload: SecurePayload;
}

export interface OutboundEnvelope {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  expiresAt: number;
  payload: SecurePayload;
}

export interface OpenInput {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  chunks: MailboxChunk[];
}

export interface SealInput {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  payload: SecurePayload;
}

/** 密码学的唯一入口（M1 crypto/chunking 实现），adapter 只是调用方。 */
export interface MailboxOpener {
  open(input: OpenInput): Promise<SecurePayload>;
  seal(input: SealInput): Promise<MailboxChunk[]>;
}

/** M1 chunk_assemblies 的窄投影（sqlite-store 实现它）。 */
export interface ChunkAssemblyStore {
  save(chunk: MailboxChunk): 'inserted' | 'duplicate' | 'conflict';
  /** 齐块才返回（按 index 升序）并原子清理；未齐或已过期返回 null。 */
  take(messageId: string, now: number): MailboxChunk[] | null;
  drop(messageId: string): void;
}

/** data-client 的窄投影：adapter 只需要这四个动词。 */
export interface WakuDataClientSeam {
  insert(collection: string, doc: Record<string, Json>): Promise<WakuRow>;
  upsert(collection: string, key: string, doc: Record<string, Json>): Promise<WakuRow>;
  query(
    collection: string,
    params: WakuQueryParams,
  ): Promise<{ rows: WakuRow[]; nextCursor: string | null; hasMore: boolean }>;
  delete(collection: string, target: { docId: string } | { key: string }): Promise<{ ok: true }>;
}

export interface TimerSeam {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface CleanupReport {
  deleted: string[];
  /** 平台只允许删自己的行——玩家的行永远删不掉，必须如实上报，不许冒充成功。 */
  notPermitted: string[];
  failed: Array<{ messageId: string; code: string }>;
}

export interface MailboxHealth {
  ok: boolean;
  state: 'running' | 'degraded' | 'stopped';
  cursorLagMs: number;
  pendingOutbox: number;
  rateLimitedCount: number;
  rejectedCount: number;
  lastPollAt: number | null;
}

export type InboundSink = (envelope: InboundEnvelope) => Promise<IngressAck>;

export interface WakuMailboxAdapter {
  readonly descriptor: ChannelDescriptor;
  start(sink: InboundSink): Promise<void>;
  send(envelope: OutboundEnvelope): Promise<DeliveryReceipt>;
  heartbeat(input: {
    routeId: string;
    payload: SecurePayload;
    keyVersion: number;
    expiresAt: number;
  }): Promise<DeliveryReceipt>;
  cleanupOutbox(messageIds: string[]): Promise<CleanupReport>;
  cleanupInbox(messageIds: string[]): Promise<CleanupReport>;
  health(): Promise<MailboxHealth>;
  stop(): Promise<void>;
}

export interface WakuMailboxAdapterOptions {
  instanceId: string;
  dataClient: WakuDataClientSeam;
  cursorStore: WakuCursorStore;
  assemblies: ChunkAssemblyStore;
  opener: MailboxOpener;
  now: () => number;
  timer: TimerSeam;
  routes: () => string[];
  /** 0..1 的抖动源，注入后轮询间隔完全确定。 */
  jitter?: () => number;
  polling?: Partial<PollConfig>;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

type RowOutcome = 'delivered' | 'skipped' | 'sink-failed';

export function createWakuMailboxAdapter(
  options: WakuMailboxAdapterOptions,
): WakuMailboxAdapter {
  const { dataClient, cursorStore, assemblies, opener, now, timer } = options;
  const jitter = options.jitter ?? Math.random;
  const config = mergePollConfig(options.polling);

  const descriptor: ChannelDescriptor = {
    type: 'waku',
    instanceId: options.instanceId,
    protocolVersion: CHANNEL_PROTOCOL_VERSION,
    capabilities: {
      progress: true,
      presence: true,
      attachments: false,
      maxMessageBytes: MAX_MESSAGE_BYTES,
    },
  };

  let lifecycle: 'idle' | 'running' | 'stopped' = 'idle';
  let sink: InboundSink | null = null;
  let timerHandle: number | null = null;
  let consecutiveEmptyPolls = 0;
  let degraded = false;
  let lastPollAt: number | null = null;
  let rateLimitedCount = 0;
  let rejectedCount = 0;
  /** 有分片可能没写完的出站消息：messageId → 还欠几块。 */
  const unresolvedOutbox = new Map<string, number>();

  // ── 轮询调度 ────────────────────────────────────────────────────

  function clearTimer(): void {
    if (timerHandle !== null) {
      timer.clearTimeout(timerHandle);
      timerHandle = null;
    }
  }

  function schedule(delayMs: number): void {
    if (lifecycle !== 'running') return;
    clearTimer();
    timerHandle = timer.setTimeout(() => {
      timerHandle = null;
      void runPoll();
    }, Math.max(0, Math.round(delayMs)));
  }

  function nextDelay(): number {
    const idle = consecutiveEmptyPolls > config.idleAfterEmptyPolls;
    const min = idle ? config.idleMinMs : config.activeMinMs;
    const max = idle ? config.idleMaxMs : config.activeMaxMs;
    const ratio = Math.min(1, Math.max(0, jitter()));
    return Math.round(min + ratio * (max - min));
  }

  async function runPoll(): Promise<void> {
    if (lifecycle !== 'running') return;
    lastPollAt = now();
    try {
      const delivered = await pollOnce();
      degraded = false;
      consecutiveEmptyPolls = delivered > 0 ? 0 : consecutiveEmptyPolls + 1;
      schedule(nextDelay());
    } catch (error) {
      handlePollFailure(error);
    }
  }

  function handlePollFailure(error: unknown): void {
    const classification = classificationOf(error);
    const code = codeOf(error);

    if (classification === 'rate-limited') {
      rateLimitedCount += 1;
      // 平台说等多久就等多久——自适应节奏在这里让位，cursor / pending 一概不动。
      schedule(retryAfterMsOf(error) ?? WAKU_DEFAULT_RETRY_AFTER_MS);
      return;
    }
    if (classification === 'auth') {
      // 凭证问题不等于 runner 问题：只报 degraded，游标与 pending 全留着。
      degraded = true;
    }
    if (code === 'datastore_invalid_cursor') {
      // 平台 cursor 把 filter/sort 编进了 spec hash，路由集合一变就失效——放大回扫窗重扫。
      cursorStore.reset(WAKU_COLLECTIONS.inbox, code);
    }
    consecutiveEmptyPolls += 1;
    schedule(nextDelay());
  }

  // ── 入站 ────────────────────────────────────────────────────────

  async function pollOnce(): Promise<number> {
    const collection = WAKU_COLLECTIONS.inbox;
    const activeRoutes = options.routes();
    if (activeRoutes.length === 0) return 0;

    const floor = cursorStore.scanFloor(collection);
    const filter: WakuFilter[] = [
      { field: 'routeId', op: 'in', value: [...activeRoutes] },
    ];
    if (floor !== null) filter.push({ field: 'createdAt', op: 'gt', value: floor });

    let cursor: string | undefined;
    let delivered = 0;

    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
      const params: WakuQueryParams = {
        filter,
        sort: 'createdAt',
        limit: WAKU_QUERY_PAGE_LIMIT,
      };
      if (cursor !== undefined) params.cursor = cursor;

      const result = await dataClient.query(collection, params);
      for (const row of result.rows) {
        const outcome = await consumeRow(row, activeRoutes);
        if (outcome === 'delivered') delivered += 1;
        // sink 挂了就地停轮：保序 + 不推进游标，下一轮从同一行重投。
        if (outcome === 'sink-failed') return delivered;
      }
      if (!result.hasMore || result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return delivered;
  }

  async function consumeRow(row: WakuRow, activeRoutes: readonly string[]): Promise<RowOutcome> {
    const collection = WAKU_COLLECTIONS.inbox;
    const rawMessageId = row.doc['messageId'];
    const rawChunkIndex = row.doc['chunkIndex'];

    if (
      typeof rawMessageId === 'string' &&
      typeof rawChunkIndex === 'number' &&
      cursorStore.isDuplicate({ collection, messageId: rawMessageId, chunkIndex: rawChunkIndex })
    ) {
      return 'skipped';
    }

    const rawRouteId = row.doc['routeId'];
    // 不在 active routes 里的行一概不碰（服务端已经过滤过，这是第二道）。
    if (typeof rawRouteId !== 'string' || !activeRoutes.includes(rawRouteId)) return 'skipped';

    const chunk = toChunk(row);
    if (chunk === null || now() >= chunk.expiresAt) {
      // 公共 append-only 集合谁都能写：垃圾行只计数不炸循环，并标记已见免得每轮重算。
      rejectedCount += 1;
      markRowSeen(row, rawMessageId, rawChunkIndex);
      return 'skipped';
    }

    const saved = assemblies.save(chunk);
    if (saved === 'conflict') {
      // 同 index 不同密文 / chunkCount 打架：不猜哪个是真的，整条丢。
      rejectedCount += 1;
      assemblies.drop(chunk.messageId);
      return 'skipped';
    }

    const complete = assemblies.take(chunk.messageId, now());
    if (complete === null) return 'skipped'; // 缺块：已到的分片留着，下轮补齐

    const head = complete[0];
    let payload: SecurePayload;
    try {
      payload = await opener.open({
        routeId: chunk.routeId,
        messageId: chunk.messageId,
        kind: chunk.kind,
        keyVersion: chunk.keyVersion,
        direction: 'to_agent',
        createdAt: head.createdAt,
        expiresAt: head.expiresAt,
        chunks: complete,
      });
    } catch {
      // 解不开就不是 Agent 该看的东西（错 key / 篡改 AAD）：只丢这一条。
      rejectedCount += 1;
      advanceAll(complete);
      return 'skipped';
    }

    const envelope: InboundEnvelope = {
      channel: 'waku',
      routeId: chunk.routeId,
      messageId: chunk.messageId,
      kind: chunk.kind,
      keyVersion: chunk.keyVersion,
      createdAt: head.createdAt,
      expiresAt: head.expiresAt,
      receivedAt: now(),
      payload,
    };

    let ack: IngressAck;
    try {
      ack = await sink!(envelope);
    } catch {
      return 'sink-failed';
    }

    // accepted / duplicate / rejected 都算"这行处理完了"：游标必须前进，
    // 否则重放或垃圾行会把游标钉死在原地，无限重投。
    if (ack.status === 'rejected') rejectedCount += 1;
    advanceAll(complete);
    return 'delivered';
  }

  function advanceAll(chunks: readonly MailboxChunk[]): void {
    for (const chunk of chunks) {
      cursorStore.advance(WAKU_COLLECTIONS.inbox, {
        createdAt: chunk.createdAt,
        messageId: chunk.messageId,
        chunkIndex: chunk.chunkIndex,
      });
    }
  }

  function markRowSeen(row: WakuRow, rawMessageId: Json | undefined, rawChunkIndex: Json | undefined): void {
    if (
      typeof rawMessageId !== 'string' ||
      rawMessageId.length === 0 ||
      typeof rawChunkIndex !== 'number' ||
      !Number.isInteger(rawChunkIndex) ||
      rawChunkIndex < 0
    ) {
      return; // 连去重键都拼不出来的行，只能靠时间游标走过去
    }
    cursorStore.advance(WAKU_COLLECTIONS.inbox, {
      createdAt: row.createdAt,
      messageId: rawMessageId,
      chunkIndex: rawChunkIndex,
    });
  }

  // ── 出站 ────────────────────────────────────────────────────────

  function receiptFor(error: unknown): DeliveryReceipt {
    const classification = classificationOf(error);
    const code = codeOf(error);
    if (classification === 'rate-limited') {
      rateLimitedCount += 1;
      const retryAfterMs = retryAfterMsOf(error);
      return retryAfterMs === undefined
        ? { status: 'retryable', code }
        : { status: 'retryable', code, retryAfterMs };
    }
    if (classification === 'retryable' || classification === 'auth') {
      return { status: 'retryable', code };
    }
    if (classification === 'unknown') return { status: 'unknown', code };
    return { status: 'permanent-failure', code };
  }

  async function existingChunkIndexes(collection: string, messageId: string): Promise<Set<number>> {
    const page = await dataClient.query(collection, {
      filter: [{ field: 'messageId', op: 'eq', value: messageId }],
      limit: WAKU_QUERY_PAGE_LIMIT,
    });
    const indexes = new Set<number>();
    for (const row of page.rows) {
      if (!row.owner.isMe) continue;
      const index = row.doc['chunkIndex'];
      if (typeof index === 'number') indexes.add(index);
    }
    return indexes;
  }

  async function writeChunks(
    collection: string,
    messageId: string,
    chunks: readonly MailboxChunk[],
  ): Promise<DeliveryReceipt> {
    if (chunks.length === 0 || chunks.length > MAX_CHUNK_COUNT) {
      unresolvedOutbox.delete(messageId);
      return { status: 'permanent-failure', code: 'waku_message_too_large' };
    }

    let already: Set<number> = new Set();
    if (unresolvedOutbox.has(messageId)) {
      // 上次这条消息写到一半（unknown / 限速），先看服务端到底落了哪几块，
      // 只补缺失的——重发绝不换 messageId，也绝不在 append_only 里造重复行。
      try {
        already = await existingChunkIndexes(collection, messageId);
      } catch (error) {
        return receiptFor(error);
      }
    }

    const missing = chunks.filter((chunk) => !already.has(chunk.chunkIndex));
    unresolvedOutbox.set(messageId, missing.length);

    let firstDocId: string | undefined;
    for (const chunk of missing) {
      try {
        const row = await dataClient.insert(collection, chunkToDoc(chunk));
        if (firstDocId === undefined) firstDocId = row.docId;
        unresolvedOutbox.set(messageId, Math.max(0, (unresolvedOutbox.get(messageId) ?? 1) - 1));
      } catch (error) {
        return receiptFor(error);
      }
    }

    unresolvedOutbox.delete(messageId);
    return firstDocId === undefined
      ? { status: 'sent' }
      : { status: 'sent', externalDeliveryId: firstDocId };
  }

  // ── 清理 ────────────────────────────────────────────────────────

  async function cleanup(collection: string, messageIds: readonly string[]): Promise<CleanupReport> {
    const report: CleanupReport = { deleted: [], notPermitted: [], failed: [] };

    for (const messageId of messageIds) {
      let rows: WakuRow[];
      try {
        const page = await dataClient.query(collection, {
          filter: [{ field: 'messageId', op: 'eq', value: messageId }],
          limit: WAKU_QUERY_PAGE_LIMIT,
        });
        rows = page.rows;
      } catch (error) {
        report.failed.push({ messageId, code: codeOf(error) });
        continue;
      }

      const mine = rows.filter((row) => row.owner.isMe);
      // 玩家写的行 daemon 永远删不掉（平台只允许删自己的），如实上报，不冒充清理成功。
      if (rows.length > mine.length) report.notPermitted.push(messageId);
      if (mine.length === 0) continue;

      let failed = false;
      for (const row of mine) {
        try {
          await dataClient.delete(collection, { docId: row.docId });
        } catch (error) {
          report.failed.push({ messageId, code: codeOf(error) });
          failed = true;
          break;
        }
      }
      if (!failed) report.deleted.push(messageId);
    }

    return report;
  }

  // ── 对外 API ────────────────────────────────────────────────────

  return {
    descriptor,

    async start(nextSink: InboundSink): Promise<void> {
      if (lifecycle === 'running') {
        throw new Error('waku mailbox adapter is already started');
      }
      if (lifecycle === 'stopped') {
        throw new Error('waku mailbox adapter has been stopped');
      }
      sink = nextSink;
      lifecycle = 'running';
      await runPoll();
    },

    async send(envelope: OutboundEnvelope): Promise<DeliveryReceipt> {
      if (lifecycle === 'stopped') {
        return { status: 'permanent-failure', code: 'waku_mailbox_stopped' };
      }
      let chunks: MailboxChunk[];
      try {
        chunks = await opener.seal({
          routeId: envelope.routeId,
          messageId: envelope.messageId,
          kind: envelope.kind,
          keyVersion: envelope.keyVersion,
          direction: 'to_player',
          createdAt: now(),
          expiresAt: envelope.expiresAt,
          payload: envelope.payload,
        });
      } catch {
        return { status: 'permanent-failure', code: 'waku_seal_failed' };
      }
      return writeChunks(WAKU_COLLECTIONS.outbox, envelope.messageId, chunks);
    },

    async heartbeat(input: {
      routeId: string;
      payload: SecurePayload;
      keyVersion: number;
      expiresAt: number;
    }): Promise<DeliveryReceipt> {
      if (lifecycle === 'stopped') {
        return { status: 'permanent-failure', code: 'waku_mailbox_stopped' };
      }
      const createdAt = now();
      let chunks: MailboxChunk[];
      try {
        chunks = await opener.seal({
          routeId: input.routeId,
          messageId: uuidV7(createdAt),
          kind: 'status',
          keyVersion: input.keyVersion,
          direction: 'to_player',
          createdAt,
          expiresAt: input.expiresAt,
          payload: input.payload,
        });
      } catch {
        return { status: 'permanent-failure', code: 'waku_seal_failed' };
      }
      // 心跳按 key=routeId upsert，所以必须是单块：多块会互相顶掉，只剩最后一块。
      if (chunks.length !== 1) {
        return { status: 'permanent-failure', code: 'waku_heartbeat_too_large' };
      }
      try {
        const row = await dataClient.upsert(
          WAKU_COLLECTIONS.status,
          input.routeId,
          chunkToDoc(chunks[0]),
        );
        return { status: 'sent', externalDeliveryId: row.docId };
      } catch (error) {
        return receiptFor(error);
      }
    },

    cleanupOutbox(messageIds: string[]): Promise<CleanupReport> {
      return cleanup(WAKU_COLLECTIONS.outbox, messageIds);
    },

    cleanupInbox(messageIds: string[]): Promise<CleanupReport> {
      return cleanup(WAKU_COLLECTIONS.inbox, messageIds);
    },

    health(): Promise<MailboxHealth> {
      const state: MailboxHealth['state'] =
        lifecycle !== 'running' ? 'stopped' : degraded ? 'degraded' : 'running';
      return Promise.resolve({
        ok: state === 'running',
        state,
        cursorLagMs: cursorStore.lagMs(WAKU_COLLECTIONS.inbox, now()),
        pendingOutbox: unresolvedOutbox.size,
        rateLimitedCount,
        rejectedCount,
        lastPollAt,
      });
    },

    stop(): Promise<void> {
      lifecycle = 'stopped';
      sink = null;
      clearTimer();
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// 行 ↔ 分片
// ---------------------------------------------------------------------------

/** 密文只查字符集：规范性由解密那一步的 base64url 严格解码兜底。 */
const CIPHERTEXT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 平台行 → 分片。`direction` 由 collection 推出、`createdAt` 取行元数据，
 * 两者都不采信 doc 里的自报值（平台也根本不会存它们）。
 */
function toChunk(row: WakuRow): MailboxChunk | null {
  const doc = row.doc;

  if (doc['protocolVersion'] !== MAILBOX_PROTOCOL_VERSION) return null;

  const routeId = doc['routeId'];
  if (typeof routeId !== 'string' || routeId.length === 0) return null;

  // messageId 只做"能当去重键用"的下限校验：它整个进 AAD，伪造的 id 会在解密那步暴露，
  // 严格的 UUIDv7 形状校验留给 Core 侧的 parseMailboxChunk（M1 契约层）。
  const messageId = doc['messageId'];
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 128) {
    return null;
  }

  const kind = doc['kind'];
  if (typeof kind !== 'string' || !(MAILBOX_KINDS as readonly string[]).includes(kind)) return null;

  const keyVersion = doc['keyVersion'];
  if (typeof keyVersion !== 'number' || !Number.isInteger(keyVersion) || keyVersion < 1) return null;

  const chunkCount = doc['chunkCount'];
  if (
    typeof chunkCount !== 'number' ||
    !Number.isInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > MAX_CHUNK_COUNT
  ) {
    return null;
  }

  const chunkIndex = doc['chunkIndex'];
  if (
    typeof chunkIndex !== 'number' ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= chunkCount
  ) {
    return null;
  }

  const expiresAt = doc['expiresAt'];
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) return null;

  const nonce = doc['nonce'];
  const nonceBytes = decodeBase64Url(nonce);
  if (typeof nonce !== 'string' || nonceBytes === null || nonceBytes.length !== NONCE_BYTES) {
    return null;
  }

  const payload = doc['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const ciphertext = (payload as Record<string, Json>)['ciphertext'];
  if (typeof ciphertext !== 'string' || !CIPHERTEXT_RE.test(ciphertext)) return null;

  const createdAt = row.createdAt;
  if (!Number.isInteger(createdAt) || createdAt >= expiresAt) return null;

  return {
    protocolVersion: MAILBOX_PROTOCOL_VERSION,
    routeId,
    messageId,
    direction: 'to_agent',
    kind: kind as MailboxKind,
    keyVersion,
    chunkIndex,
    chunkCount,
    createdAt,
    expiresAt,
    nonce,
    payload: { ciphertext },
  };
}

/**
 * 分片 → 行 doc。**不写 direction / createdAt**：架构 §7 的字段表里没有 direction
 * （由 collection 派生），createdAt 是平台保留字段（自报会被静默剥除）。
 */
function chunkToDoc(chunk: MailboxChunk): Record<string, Json> {
  return {
    protocolVersion: chunk.protocolVersion,
    routeId: chunk.routeId,
    messageId: chunk.messageId,
    kind: chunk.kind,
    keyVersion: chunk.keyVersion,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    expiresAt: chunk.expiresAt,
    nonce: chunk.nonce,
    payload: { ciphertext: chunk.payload.ciphertext },
  };
}

function mergePollConfig(overrides: Partial<PollConfig> | undefined): PollConfig {
  const merged: PollConfig = { ...WAKU_POLL_DEFAULTS };
  if (!overrides) return merged;
  for (const key of Object.keys(WAKU_POLL_DEFAULTS) as Array<keyof PollConfig>) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
  }
  return merged;
}

/** UUIDv7（心跳行需要一个可排序的 messageId；Playable 侧按 v7 校验）。 */
function uuidV7(nowMs: number): string {
  const bytes = randomBytes(16);
  const timestamp = Math.max(0, Math.floor(nowMs));
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
