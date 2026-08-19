/**
 * M4 · Core 组装层测试夹具（共用，不含用例）
 *
 * 三条设计决定，先写在这里，免得后面每个文件重复解释：
 *
 * 1. **密码学在测试侧独立实现一遍。** 下面的 `playerSeal/playerOpen/playerMessageKey/
 *    playerBootstrapKey/playerPairRouteId` 是照着 Playable 侧
 *    `waku-feed-codex-playable/src/protocol/{constants,crypto,envelope}.js` 逐字节手抄的，
 *    **故意不复用** M1 的 `channels/waku/{crypto,chunking}.ts`。
 *    复用同一份实现只能证明"自己和自己一致"；独立实现才能证明 daemon 与 Playable 真能互解。
 *
 * 2. **状态层用真件。** `openGatewayStore` / `createPairingService` / `createLocalRunnerAdapter`
 *    都是 M1 已落地的真模块，只把 db/masterKey 指到临时目录。重启恢复类用例靠真 SQLite 关库重开，
 *    不用内存桩糊弄。
 *
 * 3. **传输层是 §4.1 `ChannelAdapter` 抽象。** Core 不知道 Waku 的存在，
 *    所以这里注入 `FakeChannel`。`InboundEnvelope/OutboundEnvelope/MailboxOpener` 的形状
 *    与 M2 的 `mailbox-adapter` 契约逐字段对齐（adapter 负责组片与读写，
 *    密码学由 Core 提供的 opener 承担）。
 *
 * 时间与并发一律注入：`TestClock` 给 now()，`GatedAgent` 用手动 release 控制 turn 生命周期，
 * 全程不 sleep、不用真 timer。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { openGatewayStore, type GatewayStore } from '../../gateway/state/sqlite-store.js';
import {
  createPairingService,
  type IssuerContext,
  type PairingService,
} from '../../gateway/core/pairing-service.js';
import type { AgentEndpoint, TrustTier } from '../../gateway/contracts/runner.js';
import type { PairingScope } from '../../gateway/contracts/pairing.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHealth,
  AgentRequest,
} from '../../v6/contracts.js';

// ---------------------------------------------------------------------------
// 线协议常量（Playable src/protocol/constants.js 的镜像）
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;
export const KEY_INFO_NAMESPACE = 'waku-mailbox-v1';
export const PURPOSE_MESSAGE = 'msg';
export const PURPOSE_PAIR = 'pair';
export const PAIR_BOOTSTRAP_SALT = 'waku-pair-bootstrap-v1';
export const PAIR_ROUTE_PREFIX = 'pr_';
export const CHUNK_PLAINTEXT_BYTES = 4096;

/** Playable constants.js `KINDS`：第 8 个值 `status` 是本轮裁决的协议扩展。 */
export const MAILBOX_KINDS = [
  'pair',
  'turn',
  'control',
  'progress',
  'final',
  'error',
  'ack',
  'status',
] as const;

export type MailboxKind = (typeof MAILBOX_KINDS)[number];
export type MailboxDirection = 'to_agent' | 'to_player';

// ---------------------------------------------------------------------------
// SecurePayload：Playable src/protocol/envelope.js 的字段清单，一字不差
// ---------------------------------------------------------------------------

export type ControlOp = 'stop' | 'new' | 'resume';
export type AckStatus = 'received' | 'completed' | 'displayed';
export type ProgressStage = 'received' | 'queued' | 'running';
export type AgentState = 'online' | 'busy' | 'degraded' | 'offline';

export type SecurePayload =
  /** generation 在 daemon 侧必须是**可选**的：M1 已冻结的 turn 不含它，62 绿不能被打破。 */
  | { type: 'turn'; conversationId: string; text: string; clientSeq: number; generation?: number }
  | {
      type: 'control';
      op: ControlOp;
      conversationId: string;
      generation?: number;
      targetTurnId?: string;
    }
  | { type: 'ack'; ackMessageId: string; status: AckStatus }
  | {
      type: 'progress';
      conversationId: string;
      replyTo: string;
      stage: ProgressStage;
      text?: string;
    }
  | { type: 'final'; conversationId: string; replyTo: string; text: string }
  | { type: 'error'; code: string; message?: string; conversationId?: string; replyTo?: string }
  | { type: 'status'; agent: AgentState; at: number; queued?: number; running?: number }
  | { type: 'pair_request'; clientNonce: string; clientTimeMs: number; deviceLabel?: string }
  | {
      type: 'pair_accept';
      pairingId?: string;
      routeId?: string;
      channelSecret?: string;
      keyVersion?: number;
      endpointId?: string;
      principalId?: string;
      scopes?: string[];
      expiresAt?: number;
    }
  | { type: 'pair_reject'; code: string; message?: string };

// ---------------------------------------------------------------------------
// 信封与 opener（与 M2 mailbox-adapter 契约逐字段对齐）
// ---------------------------------------------------------------------------

export type MailboxChunk = {
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

export type InboundEnvelope = {
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

export type OutboundEnvelope = {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  expiresAt: number;
  payload: SecurePayload;
};

export type OpenInput = {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  chunks: MailboxChunk[];
};

export type SealInput = {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  payload: SecurePayload;
};

/** Core 提供给 Channel 的唯一密码学入口。 */
export type MailboxOpener = {
  open(input: OpenInput): Promise<SecurePayload>;
  seal(input: SealInput): Promise<MailboxChunk[]>;
};

/**
 * opener 失败的分类。`permanent` 决定 adapter 要不要把这行永久标 seen：
 * - AEAD 认证失败 / 未知路由 / 解出来不是合法 payload → true（伪造行，永久跳过）
 * - keyVersion 不匹配 → false（容未来 re-key，不能把将来能解的行钉死）
 */
export type OpenFailure = Error & { code: string; permanent: boolean };

export type IngressAck =
  | { status: 'accepted' }
  | { status: 'duplicate' }
  | { status: 'rejected'; code: string };

export type DeliveryReceipt =
  | { status: 'sent'; externalDeliveryId?: string }
  | { status: 'retryable'; code: string; retryAfterMs?: number }
  | { status: 'permanent-failure'; code: string }
  | { status: 'unknown'; code: string };

export type ChannelDescriptor = {
  type: 'waku';
  instanceId: string;
  protocolVersion: 1;
  capabilities: {
    progress: boolean;
    presence: boolean;
    attachments: boolean;
    maxMessageBytes: number;
  };
};

export type ComponentHealth = { ok: boolean; detail?: string };

export type ChannelAdapterApi = {
  readonly descriptor: ChannelDescriptor;
  start(sink: (envelope: InboundEnvelope) => Promise<IngressAck>): Promise<void>;
  send(envelope: OutboundEnvelope): Promise<DeliveryReceipt>;
  health(): Promise<ComponentHealth>;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Playable 侧密码学（独立实现，用来证明互操作）
// ---------------------------------------------------------------------------

function hkdf(ikm: Uint8Array, salt: string, info: string, lengthBytes: number): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      'sha256',
      ikm,
      Buffer.from(salt, 'utf8'),
      Buffer.from(info, 'utf8'),
      lengthBytes,
    ),
  );
}

/** `waku-mailbox-v1|<direction>|<purpose>|k<keyVersion>` */
export function keyInfo(direction: string, purpose: string, keyVersion: number): string {
  return `${KEY_INFO_NAMESPACE}|${direction}|${purpose}|k${keyVersion}`;
}

/** 长期方向密钥：ikm=channelSecret(32B)、salt=pairingId、purpose=msg。 */
export function playerMessageKey(input: {
  channelSecret: Uint8Array;
  pairingId: string;
  direction: MailboxDirection;
  keyVersion?: number;
}): Uint8Array {
  const keyVersion = input.keyVersion ?? 1;
  return hkdf(
    input.channelSecret,
    input.pairingId,
    keyInfo(input.direction, PURPOSE_MESSAGE, keyVersion),
    32,
  );
}

/** 一次性握手密钥：ikm=utf8(token)、salt=固定 bootstrap salt、purpose=pair。 */
export function playerBootstrapKey(input: {
  token: string;
  direction: MailboxDirection;
  keyVersion?: number;
}): Uint8Array {
  const keyVersion = input.keyVersion ?? 1;
  return hkdf(
    new Uint8Array(Buffer.from(input.token, 'utf8')),
    PAIR_BOOTSTRAP_SALT,
    keyInfo(input.direction, PURPOSE_PAIR, keyVersion),
    32,
  );
}

/** `pr_` + base64url(HKDF(..., info=`...|route|pair|k1`, L=16))。 */
export function playerPairRouteId(token: string, keyVersion = 1): string {
  const bytes = hkdf(
    new Uint8Array(Buffer.from(token, 'utf8')),
    PAIR_BOOTSTRAP_SALT,
    keyInfo('route', PURPOSE_PAIR, keyVersion),
    16,
  );
  return `${PAIR_ROUTE_PREFIX}${Buffer.from(bytes).toString('base64url')}`;
}

export type ChunkHeader = {
  protocolVersion?: number;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  chunkIndex: number;
  chunkCount: number;
  keyVersion: number;
};

/** AAD = `v1|route|msg|dir|kind|idx|count|kN`，手拼管道串（不用 JSON，键序不稳）。 */
export function chunkAad(header: ChunkHeader): Buffer {
  return Buffer.from(
    [
      `v${header.protocolVersion ?? PROTOCOL_VERSION}`,
      header.routeId,
      header.messageId,
      header.direction,
      header.kind,
      header.chunkIndex,
      header.chunkCount,
      `k${header.keyVersion}`,
    ].join('|'),
    'utf8',
  );
}

export function playerSeal(input: {
  key: Uint8Array;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  keyVersion?: number;
  createdAt: number;
  expiresAt: number;
  payload: unknown;
}): MailboxChunk[] {
  const keyVersion = input.keyVersion ?? 1;
  const plaintext = Buffer.from(JSON.stringify(input.payload), 'utf8');
  const chunkCount = Math.max(1, Math.ceil(plaintext.length / CHUNK_PLAINTEXT_BYTES));

  const chunks: MailboxChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * CHUNK_PLAINTEXT_BYTES;
    const slice = plaintext.subarray(start, Math.min(start + CHUNK_PLAINTEXT_BYTES, plaintext.length));
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', input.key, nonce);
    cipher.setAAD(
      chunkAad({
        routeId: input.routeId,
        messageId: input.messageId,
        direction: input.direction,
        kind: input.kind,
        chunkIndex,
        chunkCount,
        keyVersion,
      }),
    );
    const body = Buffer.concat([cipher.update(slice), cipher.final()]);
    const blob = Buffer.concat([body, cipher.getAuthTag()]);
    chunks.push({
      protocolVersion: PROTOCOL_VERSION,
      routeId: input.routeId,
      messageId: input.messageId,
      direction: input.direction,
      kind: input.kind,
      keyVersion,
      chunkIndex,
      chunkCount,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      nonce: nonce.toString('base64url'),
      payload: { ciphertext: blob.toString('base64url') },
    });
  }
  return chunks;
}

/** 解出**原始 JSON**（不做 schema 校验）——这样断言的是真实线上字段，而不是被解析器补齐后的形状。 */
export function playerOpen(input: {
  key: Uint8Array;
  chunks: readonly MailboxChunk[];
}): Record<string, unknown> {
  const ordered = [...input.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const parts: Buffer[] = [];
  for (const chunk of ordered) {
    const nonce = Buffer.from(chunk.nonce, 'base64url');
    const blob = Buffer.from(chunk.payload.ciphertext, 'base64url');
    const body = blob.subarray(0, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', input.key, nonce);
    decipher.setAAD(
      chunkAad({
        protocolVersion: chunk.protocolVersion,
        routeId: chunk.routeId,
        messageId: chunk.messageId,
        direction: chunk.direction,
        kind: chunk.kind,
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        keyVersion: chunk.keyVersion,
      }),
    );
    decipher.setAuthTag(tag);
    parts.push(Buffer.concat([decipher.update(body), decipher.final()]));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('decrypted payload is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 时钟、ID、tick
// ---------------------------------------------------------------------------

export const T0 = 1_760_000_000_000;

export class TestClock {
  private value: number;

  constructor(start: number = T0) {
    this.value = start;
  }

  readonly now = (): number => this.value;

  advance(ms: number): number {
    this.value += ms;
    return this.value;
  }

  set(ms: number): void {
    this.value = ms;
  }
}

/** 确定性 UUIDv7（满足 M1 冻结的 `^[0-9a-f]{8}-[0-9a-f]{4}-7...` 正则）。 */
export function makeUuidV7(prefix = '0198f4c1'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const tail = counter.toString(16).padStart(12, '0');
    return `${prefix}-1111-7000-8000-${tail}`;
  };
}

export const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 让已排队的微任务/立即任务跑完。不是 sleep：不推进任何时钟。 */
export function tick(times = 2): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  return chain;
}

/** 动态 import：变量 specifier 让 tsc 不做静态解析，模块缺失时在运行期 RED。 */
export function lazyModule<T>(specifier: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = import(specifier) as Promise<T>;
    return cached;
  };
}

export async function captureAsync(fn: () => Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await fn();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error('expected the call to reject, but it resolved');
}

// ---------------------------------------------------------------------------
// 真 SQLite store
// ---------------------------------------------------------------------------

export interface TestStore {
  store: GatewayStore;
  /** 关库重开（真崩溃重启语义），返回新的 store 实例。 */
  reopen(): GatewayStore;
  cleanup(): void;
  readonly dbPath: string;
}

const openDirs: string[] = [];

export function openTestStore(): TestStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-core-'));
  openDirs.push(dir);
  const dbPath = path.join(dir, 'gateway.db');
  const masterKeyPath = path.join(dir, 'master.key');

  let current = openGatewayStore({ dbPath, masterKeyPath });

  const handle: TestStore = {
    get store() {
      return current;
    },
    dbPath,
    reopen(): GatewayStore {
      current.close();
      current = openGatewayStore({ dbPath, masterKeyPath });
      return current;
    },
    cleanup(): void {
      try {
        current.close();
      } catch {
        /* 已关就算了 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}

export const ADMIN_ISSUER: IssuerContext = { kind: 'server-session' };

export function makePairingService(store: GatewayStore, clock: TestClock): PairingService {
  return createPairingService({
    store,
    now: clock.now,
    // 可信身份靠对象 identity，不靠字段（M1 冻结的模型）。
    authorizeIssuer: async (context) =>
      context === ADMIN_ISSUER
        ? { allowed: true, maxTrustTier: 'admin-bypass' }
        : { allowed: false, code: 'issuer_not_authorized' },
  });
}

export interface SeedEndpointInput {
  id: string;
  trustTier?: TrustTier;
  status?: 'active' | 'disabled';
  workspacePolicyId?: string;
  runnerProfileId?: string;
}

export function seedEndpoint(store: GatewayStore, input: SeedEndpointInput): AgentEndpoint {
  const endpoint: AgentEndpoint = {
    id: input.id,
    runnerProfileId: input.runnerProfileId ?? 'local-729a',
    workspacePolicyId: input.workspacePolicyId ?? 'admin-home',
    trustTier: input.trustTier ?? 'admin-bypass',
    status: input.status ?? 'active',
  };
  store.transaction((tx) => tx.upsertEndpoint(endpoint));
  return endpoint;
}

export interface SeededPairing {
  pairingId: string;
  principalId: string;
  deviceId: string;
  routeId: string;
  endpointId: string;
  keyVersion: number;
  scopes: PairingScope[];
  /** 明文一次性 token —— 只有测试拿得到（真实世界里只展示一次）。 */
  token: string;
  channelSecret: Uint8Array;
  /** Playable 侧独立派生的两把长期方向密钥。 */
  toAgentKey: Uint8Array;
  toPlayerKey: Uint8Array;
}

export const ALL_SCOPES: PairingScope[] = [
  'chat.send',
  'conversation.new',
  'conversation.stop',
  'conversation.resume',
  'artifact.read',
];

/** 走真 PairingService 完成一次配对（grant 签发 + 原子消费），拿到真 pairing 与真密钥。 */
export async function seedPairing(
  store: GatewayStore,
  clock: TestClock,
  options: { endpointId: string; scopes?: PairingScope[]; deviceLabel?: string } = {
    endpointId: 'aster-admin',
  },
): Promise<SeededPairing> {
  const service = makePairingService(store, clock);
  const scopes = options.scopes ?? ALL_SCOPES;
  const grant = await service.createGrant(
    { endpointId: options.endpointId, scopes, expiresAt: clock.now() + 600_000 },
    ADMIN_ISSUER,
  );
  const consumed = await service.consumeGrant({
    token: grant.token,
    deviceLabel: options.deviceLabel ?? 'playable',
  });

  return {
    pairingId: consumed.pairingId,
    principalId: consumed.principalId,
    deviceId: consumed.deviceId,
    routeId: consumed.routeId,
    endpointId: consumed.endpointId,
    keyVersion: consumed.keyVersion,
    scopes: [...consumed.scopes],
    token: grant.token,
    channelSecret: consumed.channelSecret,
    toAgentKey: playerMessageKey({
      channelSecret: consumed.channelSecret,
      pairingId: consumed.pairingId,
      direction: 'to_agent',
      keyVersion: consumed.keyVersion,
    }),
    toPlayerKey: playerMessageKey({
      channelSecret: consumed.channelSecret,
      pairingId: consumed.pairingId,
      direction: 'to_player',
      keyVersion: consumed.keyVersion,
    }),
  };
}

// ---------------------------------------------------------------------------
// FakeChannelAdapter（§4.1）
// ---------------------------------------------------------------------------

export class FakeChannel implements ChannelAdapterApi {
  readonly descriptor: ChannelDescriptor = {
    type: 'waku',
    instanceId: 'waku-test',
    protocolVersion: 1,
    capabilities: {
      progress: true,
      presence: true,
      attachments: false,
      maxMessageBytes: 65_536,
    },
  };

  readonly sent: OutboundEnvelope[] = [];
  /** 按序消费的脚本化回执；空了就默认 sent。 */
  readonly receipts: DeliveryReceipt[] = [];
  /** send 时的观察钩子（比如用来断言"outbox 行此刻已经落库"）。 */
  onSend: ((envelope: OutboundEnvelope) => void) | null = null;
  sink: ((envelope: InboundEnvelope) => Promise<IngressAck>) | null = null;
  stopped = false;
  healthy = true;

  async start(sink: (envelope: InboundEnvelope) => Promise<IngressAck>): Promise<void> {
    this.sink = sink;
  }

  async send(envelope: OutboundEnvelope): Promise<DeliveryReceipt> {
    this.sent.push(envelope);
    this.onSend?.(envelope);
    const scripted = this.receipts.shift();
    return scripted ?? { status: 'sent', externalDeliveryId: `doc_${this.sent.length}` };
  }

  async health(): Promise<ComponentHealth> {
    return { ok: this.healthy };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  ofKind(kind: MailboxKind): OutboundEnvelope[] {
    return this.sent.filter((envelope) => envelope.kind === kind);
  }

  payloads(kind: MailboxKind): SecurePayload[] {
    return this.ofKind(kind).map((envelope) => envelope.payload);
  }

  reset(): void {
    this.sent.length = 0;
    this.receipts.length = 0;
  }
}

// ---------------------------------------------------------------------------
// FakeAgentAdapter（v6 契约）：手动闸门控制每一轮的生命周期
// ---------------------------------------------------------------------------

export class AgentTurn {
  readonly request: AgentRequest;
  readonly signal: AbortSignal;
  aborted = false;
  finished = false;

  private readonly queue: AgentEvent[] = [];
  private ended = false;
  private wake: (() => void) | null = null;

  constructor(request: AgentRequest, signal: AbortSignal) {
    this.request = request;
    this.signal = signal;
    signal.addEventListener('abort', () => {
      this.aborted = true;
      this.nudge();
    });
  }

  emit(event: AgentEvent): void {
    this.queue.push(event);
    this.nudge();
  }

  /** 正常收尾（相当于 Agent 自然结束这一轮）。 */
  end(): void {
    this.ended = true;
    this.nudge();
  }

  private nudge(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *stream(): AsyncIterable<AgentEvent> {
    for (;;) {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next !== undefined) yield next;
      }
      if (this.ended || this.aborted) {
        this.finished = true;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export class FakeAgent implements AgentAdapter {
  readonly name = 'codex';
  readonly persistent = true;

  readonly turns: AgentTurn[] = [];
  readonly resets: string[] = [];
  healthCalls = 0;
  shutdownCalls = 0;
  ok = true;

  /**
   * 非闸门模式（默认）：run() 立刻吐 started + final 然后结束，
   * 用于"我只关心结果不关心时序"的用例。
   */
  autoReply: ((request: AgentRequest) => AgentEvent[]) | null = (request) => [
    { type: 'started', providerSessionId: `thread_${request.conversationId}` },
    { type: 'final', text: `echo:${request.text}` },
  ];

  private waiters: Array<{ index: number; resolve: (turn: AgentTurn) => void }> = [];

  async *run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const turn = new AgentTurn(request, signal);
    this.turns.push(turn);
    this.settleWaiters();

    const auto = this.autoReply;
    if (auto !== null) {
      for (const event of auto(request)) turn.emit(event);
      turn.end();
    }
    yield* turn.stream();
  }

  async reset(conversationId: string): Promise<void> {
    this.resets.push(conversationId);
  }

  async health(): Promise<AgentHealth> {
    this.healthCalls += 1;
    return { ok: this.ok, detail: this.ok ? 'fake-agent' : 'fake-agent down' };
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  /** 切到闸门模式：run() 挂着不结束，直到测试显式 emit/end。 */
  gate(): void {
    this.autoReply = null;
  }

  waitForTurn(index: number): Promise<AgentTurn> {
    const existing = this.turns[index];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<AgentTurn>((resolve) => {
      this.waiters.push({ index, resolve });
    });
  }

  private settleWaiters(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      const turn = this.turns[waiter.index];
      if (turn !== undefined) waiter.resolve(turn);
      else this.waiters.push(waiter);
    }
  }
}

// ---------------------------------------------------------------------------
// 泄密扫描
// ---------------------------------------------------------------------------

/**
 * 断言一段可序列化输出里不含任何机密。
 * routeId 只允许出现"短前缀"形态（≤8 字符），完整 routeId 算泄漏（架构 §12）。
 */
export function assertNoSecrets(
  value: unknown,
  secrets: { token?: string; channelSecret?: Uint8Array; routeId?: string; text?: string }[],
): void {
  const serialized = JSON.stringify(value) ?? '';
  for (const entry of secrets) {
    if (entry.token !== undefined && serialized.includes(entry.token)) {
      throw new Error('output leaked a pairing token');
    }
    if (entry.channelSecret !== undefined) {
      const b64 = Buffer.from(entry.channelSecret).toString('base64url');
      const hex = Buffer.from(entry.channelSecret).toString('hex');
      if (serialized.includes(b64) || serialized.includes(hex)) {
        throw new Error('output leaked a channel secret');
      }
    }
    if (entry.routeId !== undefined && serialized.includes(entry.routeId)) {
      throw new Error('output leaked a full routeId');
    }
    if (entry.text !== undefined && entry.text.length > 0 && serialized.includes(entry.text)) {
      throw new Error('output leaked user message text');
    }
  }
}

export function freshSecret(bytes = 32): Uint8Array {
  return new Uint8Array(randomBytes(bytes));
}

/**
 * 一次性配对 token 的形状：base64url，长度落在 Playable 冻结的 22–128 区间内。
 * 24 字节 = 192 bit，和真 PairingService 铸的那把同规格；每次调用都新随机，
 * 测试里绝不出现写死的"密钥"。
 */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** 客户端 nonce：16 字节随机 base64url。 */
export function randomNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function keysOf(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}
