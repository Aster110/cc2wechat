/**
 * 分片封装与重组（架构 §6）。
 *
 * 明文按**字节**切（不是按字符），所以 emoji 会被切两半 —— 这是对的：
 * 重组后再整体 utf8 解码，跨码点边界照样原样还原。
 *
 * 结构校验与解密的分工：
 * - 方向 / keyVersion 不一致 → 结构错（`direction_mismatch` / `key_version_mismatch`），
 *   因为接收方的 pairing 状态说了算，不采信密文自称。
 * - 其余一切（换 routeId、换 messageId、换 kind、交换 chunkIndex、翻密文字节）
 *   → 一律走 AEAD 认证失败 `chunk_auth_failed`，因为这些字段全在 AAD 里。
 */
import {
  CHUNK_PLAINTEXT_BYTES,
  MAILBOX_PROTOCOL_VERSION,
  MAX_CHUNK_COUNT,
  MAX_CLOCK_SKEW_MS,
  MAX_MESSAGE_BYTES,
  type MailboxChunk,
  type MailboxDirection,
  type MailboxKind,
} from '../../contracts/envelope.js';
import { decodeBase64Url, gatewayError } from '../../contracts/validation.js';
import { NONCE_BYTES, aeadOpen, aeadSeal, buildChunkAad, deriveDirectionKey, randomNonce } from './crypto.js';

export { CHUNK_PLAINTEXT_BYTES, MAX_CHUNK_COUNT, MAX_MESSAGE_BYTES };

export interface SealMessageOptions {
  channelSecret: Uint8Array;
  pairingId: string;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  keyVersion: number;
  purpose: string;
  createdAt: number;
  expiresAt: number;
  plaintext: string;
}

export interface OpenMessageOptions {
  channelSecret: Uint8Array;
  pairingId: string;
  direction: MailboxDirection;
  purpose: string;
  keyVersion: number;
  now: number;
}

export async function sealMessage(options: SealMessageOptions): Promise<MailboxChunk[]> {
  if (
    !Number.isInteger(options.createdAt) ||
    !Number.isInteger(options.expiresAt) ||
    options.createdAt >= options.expiresAt
  ) {
    throw gatewayError('invalid_expiry', 'createdAt must be before expiresAt', 'expiresAt');
  }

  const plaintext = Buffer.from(options.plaintext, 'utf8');
  if (plaintext.length > MAX_MESSAGE_BYTES) {
    throw gatewayError('message_too_large', 'message exceeds the 64 KiB protocol limit', 'plaintext');
  }

  const chunkCount = Math.max(1, Math.ceil(plaintext.length / CHUNK_PLAINTEXT_BYTES));
  const key = await deriveDirectionKey({
    channelSecret: options.channelSecret,
    pairingId: options.pairingId,
    direction: options.direction,
    purpose: options.purpose,
    keyVersion: options.keyVersion,
  });

  const chunks: MailboxChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * CHUNK_PLAINTEXT_BYTES;
    const slice = plaintext.subarray(start, Math.min(start + CHUNK_PLAINTEXT_BYTES, plaintext.length));
    const nonce = randomNonce();
    const aad = buildChunkAad({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      routeId: options.routeId,
      messageId: options.messageId,
      direction: options.direction,
      kind: options.kind,
      chunkIndex,
      chunkCount,
      keyVersion: options.keyVersion,
    });
    const blob = aeadSeal(key, nonce, aad, slice);
    chunks.push({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      routeId: options.routeId,
      messageId: options.messageId,
      direction: options.direction,
      kind: options.kind,
      keyVersion: options.keyVersion,
      chunkIndex,
      chunkCount,
      createdAt: options.createdAt,
      expiresAt: options.expiresAt,
      nonce: Buffer.from(nonce).toString('base64url'),
      payload: { ciphertext: Buffer.from(blob).toString('base64url') },
    });
  }
  return chunks;
}

export async function openMessage(
  chunks: readonly MailboxChunk[],
  options: OpenMessageOptions,
): Promise<string> {
  if (chunks.length === 0) {
    throw gatewayError('chunk_missing', 'no chunks supplied for reassembly');
  }

  // 1. 接收方状态说了算的两个字段：不采信密文自称。
  for (const chunk of chunks) {
    if (chunk.direction !== options.direction) {
      throw gatewayError('direction_mismatch', 'chunk direction does not match the reader');
    }
    if (chunk.keyVersion !== options.keyVersion) {
      throw gatewayError('key_version_mismatch', 'chunk keyVersion does not match the pairing');
    }
  }

  // 2. chunkCount 必须全局一致，且不得超过协议上界。
  const chunkCount = chunks[0].chunkCount;
  for (const chunk of chunks) {
    if (chunk.chunkCount !== chunkCount) {
      throw gatewayError('chunk_count_conflict', 'chunks disagree on chunkCount');
    }
  }
  if (!Number.isInteger(chunkCount) || chunkCount < 1) {
    throw gatewayError('chunk_count_conflict', 'chunkCount is not a positive integer');
  }
  if (chunkCount > MAX_CHUNK_COUNT) {
    throw gatewayError('too_many_chunks', 'chunkCount exceeds the protocol limit');
  }

  // 3. 时间 fail-closed。
  for (const chunk of chunks) {
    if (options.now >= chunk.expiresAt) {
      throw gatewayError('message_expired', 'message is already expired');
    }
    if (chunk.createdAt >= chunk.expiresAt) {
      throw gatewayError('invalid_expiry', 'createdAt must be before expiresAt');
    }
    if (chunk.createdAt - options.now > MAX_CLOCK_SKEW_MS) {
      throw gatewayError('clock_skew_exceeded', 'createdAt is too far in the future');
    }
  }

  // 4. 折叠完全相同的重复块；同 index 内容不一致 = 冲突，不猜哪个是真的。
  const byIndex = new Map<number, MailboxChunk>();
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunkCount) {
      throw gatewayError('chunk_index_out_of_range', 'chunkIndex is outside the assembly');
    }
    const seen = byIndex.get(chunk.chunkIndex);
    if (seen === undefined) {
      byIndex.set(chunk.chunkIndex, chunk);
    } else if (!isSameChunk(seen, chunk)) {
      throw gatewayError('chunk_conflict', 'two different chunks claim the same chunkIndex');
    }
  }
  if (byIndex.size !== chunkCount) {
    throw gatewayError('chunk_missing', 'assembly is incomplete');
  }

  // 5. 逐块解密。AAD 覆盖全部业务头，任何篡改都在这一步暴露。
  const key = await deriveDirectionKey({
    channelSecret: options.channelSecret,
    pairingId: options.pairingId,
    direction: options.direction,
    purpose: options.purpose,
    keyVersion: options.keyVersion,
  });

  const parts: Buffer[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunk = byIndex.get(chunkIndex);
    if (chunk === undefined) {
      throw gatewayError('chunk_missing', 'assembly is incomplete');
    }
    const nonce = decodeBase64Url(chunk.nonce);
    const blob = decodeBase64Url(chunk.payload.ciphertext);
    if (nonce === null || nonce.length !== NONCE_BYTES || blob === null) {
      throw gatewayError('chunk_auth_failed', 'chunk failed authenticated decryption');
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
      throw gatewayError('chunk_auth_failed', 'chunk failed authenticated decryption');
    }
    parts.push(Buffer.from(opened));
  }

  return Buffer.concat(parts).toString('utf8');
}

function isSameChunk(a: MailboxChunk, b: MailboxChunk): boolean {
  return (
    a.protocolVersion === b.protocolVersion &&
    a.routeId === b.routeId &&
    a.messageId === b.messageId &&
    a.direction === b.direction &&
    a.kind === b.kind &&
    a.keyVersion === b.keyVersion &&
    a.chunkIndex === b.chunkIndex &&
    a.chunkCount === b.chunkCount &&
    a.createdAt === b.createdAt &&
    a.expiresAt === b.expiresAt &&
    a.nonce === b.nonce &&
    a.payload.ciphertext === b.payload.ciphertext
  );
}
