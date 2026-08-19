/**
 * Waku mailbox 的密码学原语（架构 §6）。
 *
 * 这是**跨端字节级协议**：浏览器 Playable 侧要用 WebCrypto 实现同一份规范，
 * 所以每个串都手拼、每个长度都写死，任何"看起来等价"的改写都会让两端对不上。
 *
 * 冻结点：
 * - HKDF-SHA256：ikm = channelSecret(32B raw)、salt = utf8(pairingId)、L = 32
 *   info = utf8(`waku-mailbox-v1|{direction}|{purpose}|k{keyVersion}`)
 * - AEAD：AES-256-GCM，nonce 12B 随机（每块独立）
 *   密文 = cipherbytes || authTag(16B)，与 WebCrypto 的 `encrypt()` 输出对齐
 *   （Node 侧要手工把 getAuthTag() 拼到尾巴上）
 * - AAD = utf8(`v{protocolVersion}|{routeId}|{messageId}|{direction}|{kind}|{chunkIndex}|{chunkCount}|k{keyVersion}`)
 *   手拼管道串，不用 JSON —— 键序不稳定，跨端会不一致
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { MailboxDirection, MailboxKind } from '../../contracts/envelope.js';
import { gatewayError } from '../../contracts/validation.js';

export const NONCE_BYTES = 12;
export const AUTH_TAG_BYTES = 16;
export const DERIVED_KEY_BYTES = 32;
export const CHANNEL_SECRET_BYTES = 32;
export const HKDF_INFO_PREFIX = 'waku-mailbox-v1';
export const AEAD_ALGORITHM = 'aes-256-gcm';

export interface DeriveDirectionKeyOptions {
  channelSecret: Uint8Array;
  pairingId: string;
  direction: MailboxDirection;
  purpose: string;
  keyVersion: number;
}

export interface ChunkAadInput {
  protocolVersion: number;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  chunkIndex: number;
  chunkCount: number;
  keyVersion: number;
}

export function buildHkdfInfo(direction: string, purpose: string, keyVersion: number): Uint8Array {
  return new Uint8Array(
    Buffer.from(`${HKDF_INFO_PREFIX}|${direction}|${purpose}|k${keyVersion}`, 'utf8'),
  );
}

/**
 * 方向密钥：同一对 pairing 的 to_agent / to_player 必须是**不同**的密钥，
 * 否则任何一端都能伪造对面的消息。purpose 与 keyVersion 同样进 info，做隔离与轮换。
 */
export async function deriveDirectionKey(options: DeriveDirectionKeyOptions): Promise<Uint8Array> {
  if (options.channelSecret.length !== CHANNEL_SECRET_BYTES) {
    throw gatewayError('invalid_channel_secret', 'channelSecret must be 32 bytes', 'channelSecret');
  }
  if (options.pairingId.length === 0) {
    throw gatewayError('invalid_pairing_id', 'pairingId must not be empty', 'pairingId');
  }
  const derived = hkdfSync(
    'sha256',
    options.channelSecret,
    Buffer.from(options.pairingId, 'utf8'),
    buildHkdfInfo(options.direction, options.purpose, options.keyVersion),
    DERIVED_KEY_BYTES,
  );
  return new Uint8Array(derived);
}

export function buildChunkAad(input: ChunkAadInput): Uint8Array {
  const aad =
    `v${input.protocolVersion}` +
    `|${input.routeId}` +
    `|${input.messageId}` +
    `|${input.direction}` +
    `|${input.kind}` +
    `|${input.chunkIndex}` +
    `|${input.chunkCount}` +
    `|k${input.keyVersion}`;
  return new Uint8Array(Buffer.from(aad, 'utf8'));
}

export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(NONCE_BYTES));
}

/** 返回 `cipherbytes || authTag`，与 WebCrypto 的输出布局一致。 */
export function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv(AEAD_ALGORITHM, key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]));
}

/**
 * 认证失败返回 `null` 而不是 throw：调用方各自知道该报哪个 code
 * （mailbox 分片报 `chunk_auth_failed`，凭据封装报 `credential_auth_failed`），
 * 且失败原因绝不进消息体。
 */
export function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  blob: Uint8Array,
): Uint8Array | null {
  if (blob.length < AUTH_TAG_BYTES) return null;
  const body = blob.subarray(0, blob.length - AUTH_TAG_BYTES);
  const tag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  try {
    const decipher = createDecipheriv(AEAD_ALGORITHM, key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    return null;
  }
}
