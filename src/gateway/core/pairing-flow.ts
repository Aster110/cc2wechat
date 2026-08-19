/**
 * PairingFlow：pair_request → pair_accept 握手（架构 §5）。
 *
 * 这一层是**跨端字节级协议**，事实源是 Playable 侧
 * `waku-feed-codex-playable/src/protocol/{constants,crypto}.js`：
 *
 * - bootstrap 路由 = `pr_` + base64url(HKDF(ikm=utf8(token), salt=utf8('waku-pair-bootstrap-v1'),
 *   info=utf8('waku-mailbox-v1|route|pair|k1'), L=16))
 * - bootstrap 密钥 = 同 HKDF，info 里的 direction 换成 to_agent / to_player，L=32
 * - 正常流量的 purpose 是 `msg`，握手是 `pair` —— 两把钥匙永不通用
 *
 * 为什么路由要从 token 派生：一次性码本身不能进公共信箱（谁都看得见），
 * 但两端都得知道"在哪条路上碰头"。单向派生让知道 token 的人算得出路由，
 * 只看见路由的人算不回 token。
 *
 * 为什么这里自己写分片而不复用 `chunking.ts`：那边的密钥是
 * `HKDF(channelSecret, salt=pairingId)`，握手期**还没有** pairing，
 * 派生输入完全不同。共用会逼着 chunking 长出一个"有时不需要 pairing"的分支。
 */
import { hkdfSync } from 'node:crypto';

import type { ChannelDescriptor, DeliveryReceipt, IngressAck } from '../contracts/channel.js';
import {
  CHUNK_PLAINTEXT_BYTES,
  MAILBOX_PROTOCOL_VERSION,
  MAX_CHUNK_COUNT,
  NONCE_BYTES,
  type MailboxChunk,
  type MailboxDirection,
  type MailboxKind,
  type SecurePayload,
} from '../contracts/envelope.js';
import { decodeBase64Url, gatewayError, isGatewayError } from '../contracts/validation.js';
import {
  aeadOpen,
  aeadSeal,
  buildChunkAad,
  buildHkdfInfo,
  DERIVED_KEY_BYTES,
  randomNonce,
} from '../channels/waku/crypto.js';
import type { GatewayStore } from '../state/sqlite-store.js';
import type { PairingService } from './pairing-service.js';

// ---------------------------------------------------------------------------
// 冻结常量（与 Playable constants.js 逐字符对齐）
// ---------------------------------------------------------------------------

export const PAIR_BOOTSTRAP_SALT = 'waku-pair-bootstrap-v1';
export const PAIR_ROUTE_PREFIX = 'pr_';
export const PURPOSE_PAIR = 'pair';
/** 路由标签取 16 字节：128 bit 足够无碰撞，又比 32 字节的标签短一半。 */
export const PAIR_ROUTE_BYTES = 16;
export const PAIR_KEY_VERSION = 1;

/** 握手回执的寿命：玩家扫码到点开的窗口，短到过期的码不会一直躺在信箱里。 */
export const DEFAULT_PAIR_TTL_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

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

/** flow 只需要 channel 的 send；descriptor 只是为了让真 adapter 能直接塞进来。 */
export interface PairingFlowChannel {
  readonly descriptor?: ChannelDescriptor;
  send(envelope: OutboundEnvelope): Promise<DeliveryReceipt>;
}

export interface RegisterGrantInput {
  grantId: string;
  token: string;
  expiresAt: number;
}

export interface PairingFlow {
  /** 管理员签发 grant 后立刻登记：flow 由此算出 pr_ 路由并留住 bootstrap 材料。 */
  registerGrant(input: RegisterGrantInput): Promise<{ pairRouteId: string }>;
  /** 当前仍在等待握手的 pr_ 路由（交给 mailbox adapter 去轮询）。 */
  routes(): string[];
  /** ingress 的 opener 对 pr_ 路由的委托入口。 */
  openPairChunks(input: OpenInput): Promise<SecurePayload>;
  sealPairChunks(input: SealInput): Promise<MailboxChunk[]>;
  handle(envelope: InboundEnvelope): Promise<IngressAck>;
}

export interface PairedNotice {
  grantId: string;
  pairingId: string;
  principalId: string;
  endpointId: string;
  routeId: string;
}

export interface PairingFlowOptions {
  store: GatewayStore;
  pairings: PairingService;
  channel: PairingFlowChannel;
  now(): number;
  newMessageId(): string;
  ttlMs?: number;
  /** 配对成功后的回调（bootstrap 用它把新 principal 登记进 admin 名单）。 */
  onPaired?(notice: PairedNotice): void;
}

export interface OpenFailure extends Error {
  code: string;
  /** true = 伪造行，adapter 可以永久标 seen；false = 将来也许能解（比如 re-key）。 */
  permanent: boolean;
}

export function openFailure(code: string, message: string, permanent: boolean): OpenFailure {
  const error = new Error(message) as OpenFailure;
  error.code = code;
  error.permanent = permanent;
  return error;
}

// ---------------------------------------------------------------------------
// 派生
// ---------------------------------------------------------------------------

function hkdfPair(token: string, direction: string, lengthBytes: number, keyVersion: number): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      'sha256',
      Buffer.from(token, 'utf8'),
      Buffer.from(PAIR_BOOTSTRAP_SALT, 'utf8'),
      buildHkdfInfo(direction, PURPOSE_PAIR, keyVersion),
      lengthBytes,
    ),
  );
}

/** `pr_` + base64url(HKDF(..., info=`...|route|pair|kN`, L=16))。 */
export async function derivePairRouteId(
  token: string,
  keyVersion: number = PAIR_KEY_VERSION,
): Promise<string> {
  const bytes = hkdfPair(token, 'route', PAIR_ROUTE_BYTES, keyVersion);
  return `${PAIR_ROUTE_PREFIX}${Buffer.from(bytes).toString('base64url')}`;
}

/** 一次性握手密钥：两个方向各一把，与长期 `msg` 密钥永不相等（purpose 进 info）。 */
export async function deriveBootstrapKey(input: {
  pairingToken: string;
  direction: MailboxDirection;
  keyVersion?: number;
}): Promise<Uint8Array> {
  return hkdfPair(
    input.pairingToken,
    input.direction,
    DERIVED_KEY_BYTES,
    input.keyVersion ?? PAIR_KEY_VERSION,
  );
}

// ---------------------------------------------------------------------------
// 裸密钥分片（握手期没有 pairing，用不了 chunking.ts 的派生路径）
// ---------------------------------------------------------------------------

function sealWithKey(key: Uint8Array, input: SealInput): MailboxChunk[] {
  const plaintext = Buffer.from(JSON.stringify(input.payload), 'utf8');
  const chunkCount = Math.max(1, Math.ceil(plaintext.length / CHUNK_PLAINTEXT_BYTES));
  if (chunkCount > MAX_CHUNK_COUNT) {
    throw gatewayError('message_too_large', 'pair payload exceeds the protocol limit', 'payload');
  }

  const chunks: MailboxChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * CHUNK_PLAINTEXT_BYTES;
    const slice = plaintext.subarray(
      start,
      Math.min(start + CHUNK_PLAINTEXT_BYTES, plaintext.length),
    );
    const nonce = randomNonce();
    const blob = aeadSeal(
      key,
      nonce,
      buildChunkAad({
        protocolVersion: MAILBOX_PROTOCOL_VERSION,
        routeId: input.routeId,
        messageId: input.messageId,
        direction: input.direction,
        kind: input.kind,
        chunkIndex,
        chunkCount,
        keyVersion: input.keyVersion,
      }),
      slice,
    );
    chunks.push({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      routeId: input.routeId,
      messageId: input.messageId,
      direction: input.direction,
      kind: input.kind,
      keyVersion: input.keyVersion,
      chunkIndex,
      chunkCount,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      nonce: Buffer.from(nonce).toString('base64url'),
      payload: { ciphertext: Buffer.from(blob).toString('base64url') },
    });
  }
  return chunks;
}

function openWithKey(key: Uint8Array, chunks: readonly MailboxChunk[]): string {
  if (chunks.length === 0) {
    throw openFailure('chunk_missing', 'no chunks supplied for reassembly', true);
  }
  const chunkCount = chunks[0].chunkCount;
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_CHUNK_COUNT) {
    throw openFailure('chunk_count_conflict', 'chunkCount is outside the protocol range', true);
  }

  const byIndex = new Map<number, MailboxChunk>();
  for (const chunk of chunks) {
    if (chunk.chunkCount !== chunkCount) {
      throw openFailure('chunk_count_conflict', 'chunks disagree on chunkCount', true);
    }
    if (chunk.chunkIndex < 0 || chunk.chunkIndex >= chunkCount) {
      throw openFailure('chunk_index_out_of_range', 'chunkIndex is outside the assembly', true);
    }
    byIndex.set(chunk.chunkIndex, chunk);
  }
  if (byIndex.size !== chunkCount) {
    throw openFailure('chunk_missing', 'assembly is incomplete', false);
  }

  const parts: Buffer[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunk = byIndex.get(chunkIndex);
    if (chunk === undefined) {
      throw openFailure('chunk_missing', 'assembly is incomplete', false);
    }
    const nonce = decodeBase64Url(chunk.nonce);
    const blob = decodeBase64Url(chunk.payload.ciphertext);
    if (nonce === null || nonce.length !== NONCE_BYTES || blob === null) {
      throw openFailure('chunk_auth_failed', 'chunk failed authenticated decryption', true);
    }
    const opened = aeadOpen(
      key,
      nonce,
      buildChunkAad({
        protocolVersion: chunk.protocolVersion,
        routeId: chunk.routeId,
        messageId: chunk.messageId,
        direction: chunk.direction,
        kind: chunk.kind,
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        keyVersion: chunk.keyVersion,
      }),
      blob,
    );
    if (opened === null) {
      throw openFailure('chunk_auth_failed', 'chunk failed authenticated decryption', true);
    }
    parts.push(Buffer.from(opened));
  }
  return Buffer.concat(parts).toString('utf8');
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

interface PendingGrant {
  grantId: string;
  /** 明文一次性码：只活在内存里。进程重启后这张 grant 就再也配不上了（本来也只有一次机会）。 */
  token: string;
  expiresAt: number;
  /** 已经换出 pairing 的路由不再轮询，但还要能封回执（回执是握手后才发的）。 */
  retired: boolean;
}

/** 解出来的 pair_request 才算数：多一个字段都不认（客户端不得夹带策略）。 */
const PAIR_REQUEST_KEYS = ['type', 'clientNonce', 'clientTimeMs', 'deviceLabel'];

function asPairRequest(
  payload: SecurePayload,
): { clientNonce: string; deviceLabel?: string } | null {
  if (payload.type !== 'pair_request') return null;
  const record = payload as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PAIR_REQUEST_KEYS.includes(key)) return null;
  }
  if (typeof record.clientNonce !== 'string' || record.clientNonce.length === 0) return null;
  if (typeof record.clientTimeMs !== 'number') return null;
  const label = record.deviceLabel;
  if (label !== undefined && typeof label !== 'string') return null;
  return label === undefined
    ? { clientNonce: record.clientNonce }
    : { clientNonce: record.clientNonce, deviceLabel: label };
}

function codeOf(error: unknown): string {
  return isGatewayError(error) ? error.code : 'pairing_failed';
}

export function createPairingFlow(options: PairingFlowOptions): PairingFlow {
  const { store, pairings, channel, now } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_PAIR_TTL_MS;

  const pending = new Map<string, PendingGrant>();

  /** 过期即清：退役的路由也一起清掉，免得内存里长期挂着一堆死 token。 */
  function evictExpired(): void {
    const at = now();
    for (const [routeId, entry] of pending) {
      if (at >= entry.expiresAt) pending.delete(routeId);
    }
  }

  function entryFor(routeId: string): PendingGrant | null {
    evictExpired();
    return pending.get(routeId) ?? null;
  }

  async function reject(routeId: string, code: string): Promise<IngressAck> {
    // pair_reject 只有 code，没有 message：这条回执发在公开路由上，
    // 多一个字的解释就是多一份给攻击者的信息。
    await channel.send({
      routeId,
      messageId: options.newMessageId(),
      kind: 'pair',
      keyVersion: PAIR_KEY_VERSION,
      expiresAt: now() + ttlMs,
      payload: { type: 'pair_reject', code },
    });
    return { status: 'rejected', code };
  }

  return {
    async registerGrant(input: RegisterGrantInput): Promise<{ pairRouteId: string }> {
      const pairRouteId = await derivePairRouteId(input.token);
      pending.set(pairRouteId, {
        grantId: input.grantId,
        token: input.token,
        expiresAt: input.expiresAt,
        retired: false,
      });
      return { pairRouteId };
    },

    routes(): string[] {
      evictExpired();
      const open: string[] = [];
      for (const [routeId, entry] of pending) {
        if (!entry.retired) open.push(routeId);
      }
      return open;
    },

    async openPairChunks(input: OpenInput): Promise<SecurePayload> {
      const entry = entryFor(input.routeId);
      // 不做"全信箱试解"：没登记过的 pr_ 路由直接判死，不给攻击者拿信箱当预言机的机会。
      if (entry === null || entry.retired) {
        throw openFailure('unknown_pair_route', 'no pending grant for this pair route', true);
      }

      const key = await deriveBootstrapKey({
        pairingToken: entry.token,
        direction: input.direction,
        keyVersion: input.keyVersion,
      });
      const plaintext = openWithKey(key, input.chunks);

      const parsed: unknown = JSON.parse(plaintext);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw openFailure('invalid_pair_request', 'pair payload is not a JSON object', true);
      }
      return parsed as SecurePayload;
    },

    async sealPairChunks(input: SealInput): Promise<MailboxChunk[]> {
      // 退役的路由仍要能封：pair_accept 是在 grant 被消费之后才发出去的。
      const entry = pending.get(input.routeId);
      if (entry === undefined) {
        throw openFailure('unknown_pair_route', 'no pending grant for this pair route', true);
      }
      const key = await deriveBootstrapKey({
        pairingToken: entry.token,
        direction: input.direction,
        keyVersion: input.keyVersion,
      });
      return sealWithKey(key, input);
    },

    async handle(envelope: InboundEnvelope): Promise<IngressAck> {
      // 这里**不先清过期**：刚过期的握手要能收到一条明确的 grant_expired，
      // 而不是被当成陌生路由静默丢掉——玩家那头会一直转圈。
      const entry = pending.get(envelope.routeId) ?? null;
      if (entry === null || entry.retired) {
        // 未登记 / 已用掉的路由：静默拒绝，一个字节都不回。
        return { status: 'rejected', code: 'unknown_pair_route' };
      }

      const request = asPairRequest(envelope.payload);
      if (request === null) {
        // 路由对但内容不是握手：同样不回话，免得把"这条路由是活的"确认给对方。
        return { status: 'rejected', code: 'invalid_pair_request' };
      }

      // 到这里对方已经证明持有 token（AEAD 过了），可以给出有内容的回执了。
      if (now() >= entry.expiresAt) {
        pending.delete(envelope.routeId);
        return reject(envelope.routeId, 'grant_expired');
      }

      const grant = store.getGrant(entry.grantId);
      if (grant === null) {
        pending.delete(envelope.routeId);
        return reject(envelope.routeId, 'grant_not_found');
      }
      // endpoint 可能在签发之后被 disable：拒绝配对，但**不烧掉** grant ——
      // 管理员把 endpoint 打开后，同一个码还能用。
      const endpoint = store.getEndpoint(grant.endpointId);
      if (endpoint === null) return reject(envelope.routeId, 'endpoint_not_found');
      if (endpoint.status !== 'active') return reject(envelope.routeId, 'endpoint_disabled');

      let consumed;
      try {
        consumed = await pairings.consumeGrant(
          request.deviceLabel === undefined
            ? { token: entry.token }
            : { token: entry.token, deviceLabel: request.deviceLabel },
        );
      } catch (error) {
        return reject(envelope.routeId, codeOf(error));
      }

      // 消费成功即退役：同一条 pair_request 重放只会撞上 unknown_pair_route。
      entry.retired = true;
      options.onPaired?.({
        grantId: entry.grantId,
        pairingId: consumed.pairingId,
        principalId: consumed.principalId,
        endpointId: consumed.endpointId,
        routeId: consumed.routeId,
      });

      const accept: SecurePayload = {
        type: 'pair_accept',
        pairingId: consumed.pairingId,
        routeId: consumed.routeId,
        channelSecret: Buffer.from(consumed.channelSecret).toString('base64url'),
        keyVersion: consumed.keyVersion,
        endpointId: consumed.endpointId,
        principalId: consumed.principalId,
        scopes: [...consumed.scopes],
      };

      await channel.send({
        // 回执发回**握手路由**：此刻玩家还不知道长期路由，只能在这条路上听。
        routeId: envelope.routeId,
        messageId: options.newMessageId(),
        kind: 'pair',
        keyVersion: PAIR_KEY_VERSION,
        expiresAt: now() + ttlMs,
        payload: accept,
      });

      return { status: 'accepted' };
    },
  };
}
