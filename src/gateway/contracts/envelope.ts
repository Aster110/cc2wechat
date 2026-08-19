/**
 * 加密信封与内部消息契约（架构 §6）。
 *
 * 这里只做**结构**校验，不碰密钥：解密在 `channels/waku/chunking.ts`。
 * 分片常量放在这一层，因为它同时是"线协议"和"解析边界"的事实来源；
 * chunking 只是把它们再导出一次，避免两处各写一个 4096。
 *
 * 时间一律 fail-closed：
 * - `now >= expiresAt` 视为已过期（到期点即失效，不是 +1ms 才失效）
 * - `createdAt >= expiresAt` 是签发方的结构错误
 * - 未来时间戳只容忍 `MAX_CLOCK_SKEW_MS` 这个常量窗口，调用方拿不到旋钮
 */
import {
  asRecord,
  gatewayError,
  optionalInteger,
  optionalString,
  requireBase64Url,
  requireExactNumber,
  requireInteger,
  requireLiteral,
  requireString,
  requireText,
  requireUuidV7,
  rejectUnknownKeys,
} from './validation.js';

export const MAILBOX_PROTOCOL_VERSION = 1;

export const MAILBOX_DIRECTIONS = ['to_agent', 'to_player'] as const;
export type MailboxDirection = (typeof MAILBOX_DIRECTIONS)[number];

export const MAILBOX_KINDS = [
  'pair',
  'turn',
  'control',
  'progress',
  'final',
  'error',
  'ack',
  /** Playable 侧的在线心跳行（agent_status_v1，按 routeId upsert）。 */
  'status',
] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

/** 每块明文按**字节**切；4 KiB 是为了让密文塞进 Waku 的 json 字段。 */
export const CHUNK_PLAINTEXT_BYTES = 4096;
export const MAX_CHUNK_COUNT = 16;
export const MAX_MESSAGE_BYTES = CHUNK_PLAINTEXT_BYTES * MAX_CHUNK_COUNT;

/** 96-bit 随机 nonce，每块独立。 */
export const NONCE_BYTES = 12;

/** 时钟不确定窗口：跨端（手机浏览器 vs 服务器）唯一容忍的偏移。 */
export const MAX_CLOCK_SKEW_MS = 30_000;

export interface MailboxChunk {
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
}

/**
 * 客户端能**发进来**的三类消息，也是 `parseSecurePayload` 的值域。
 *
 * `generation` 是可选的：M1 冻结的 turn 不含它（缺省按第 1 代处理），
 * 带上它的客户端才能表达"我开了新一代"。可选而不是必填，是为了让已发布的
 * Playable 不必同步升级就还能说话。
 */
export type InboundSecurePayload =
  | { type: 'turn'; conversationId: string; text: string; clientSeq: number; generation?: number }
  | {
      type: 'control';
      op: ControlOp;
      conversationId: string;
      generation?: number;
      targetTurnId?: string;
    }
  | { type: 'ack'; ackMessageId: string; status: AckStatus };

/** 握手期的两类消息：走 bootstrap 密钥，不走长期方向密钥。 */
export type PairingSecurePayload =
  | { type: 'pair_request'; clientNonce: string; clientTimeMs: number; deviceLabel?: string }
  | {
      type: 'pair_accept';
      pairingId: string;
      routeId: string;
      channelSecret: string;
      keyVersion: number;
      endpointId: string;
      principalId: string;
      scopes: string[];
    }
  | { type: 'pair_reject'; code: string; message?: string };

/** daemon 发出去的四类消息。Core 只封这些，永远不封 turn/control。 */
export type OutboundSecurePayload =
  | { type: 'progress'; conversationId: string; replyTo: string; stage: ProgressStage; text?: string }
  | { type: 'final'; conversationId: string; replyTo: string; text: string }
  | { type: 'error'; code: string; message?: string; conversationId?: string; replyTo?: string }
  | { type: 'status'; agent: AgentState; at: number; queued?: number; running?: number };

/** 线上可能出现的全部载荷。入站解析仍只认 `SECURE_PAYLOAD_TYPES` 那三种。 */
export type SecurePayload = InboundSecurePayload | PairingSecurePayload | OutboundSecurePayload;

export const CONTROL_OPS = ['stop', 'new', 'resume'] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export const ACK_STATUSES = ['received', 'completed', 'displayed'] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

export const PROGRESS_STAGES = ['received', 'queued', 'running'] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export const AGENT_STATES = ['online', 'busy', 'degraded', 'offline'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** 入站白名单。出站/握手类型**故意不在**这里：玩家伪造一条 final 不该被解析成功。 */
export const SECURE_PAYLOAD_TYPES = ['turn', 'control', 'ack'] as const;
export type SecurePayloadType = (typeof SECURE_PAYLOAD_TYPES)[number];

const CHUNK_KEYS = [
  'protocolVersion',
  'routeId',
  'messageId',
  'direction',
  'kind',
  'keyVersion',
  'chunkIndex',
  'chunkCount',
  'createdAt',
  'expiresAt',
  'nonce',
  'payload',
] as const;

const TURN_KEYS = ['type', 'conversationId', 'text', 'clientSeq', 'generation'] as const;
const CONTROL_KEYS = ['type', 'op', 'conversationId', 'generation', 'targetTurnId'] as const;
const ACK_KEYS = ['type', 'ackMessageId', 'status'] as const;

/**
 * 解析一个入站/出站分片头。`now` 显式传入，不读墙钟 —— 过期判定必须可测。
 */
export function parseMailboxChunk(input: unknown, now: number): MailboxChunk {
  const record = asRecord(input, 'chunk');
  rejectUnknownKeys(record, CHUNK_KEYS);

  const protocolVersion = requireExactNumber(
    record,
    'protocolVersion',
    'protocolVersion',
    MAILBOX_PROTOCOL_VERSION,
  );
  const routeId = requireString(record, 'routeId', 'routeId');
  const messageId = requireUuidV7(record, 'messageId', 'messageId');
  const direction = requireLiteral(record, 'direction', 'direction', MAILBOX_DIRECTIONS);
  const kind = requireLiteral(record, 'kind', 'kind', MAILBOX_KINDS);
  const keyVersion = requireInteger(record, 'keyVersion', 'keyVersion', 1);

  const chunkIndex = requireInteger(record, 'chunkIndex', 'chunkIndex', 0);
  const chunkCount = requireInteger(record, 'chunkCount', 'chunkCount', 1, MAX_CHUNK_COUNT);
  if (chunkIndex >= chunkCount) {
    throw gatewayError('invalid_input', 'chunkIndex must be below chunkCount', 'chunkIndex');
  }

  const createdAt = requireInteger(record, 'createdAt', 'createdAt', 0);
  const expiresAt = requireInteger(record, 'expiresAt', 'expiresAt', 0);
  if (now >= expiresAt) {
    throw gatewayError('message_expired', 'chunk is already expired', 'expiresAt');
  }
  if (createdAt >= expiresAt) {
    throw gatewayError('invalid_expiry', 'createdAt must be before expiresAt', 'createdAt');
  }
  if (createdAt - now > MAX_CLOCK_SKEW_MS) {
    throw gatewayError('clock_skew_exceeded', 'createdAt is too far in the future', 'createdAt');
  }

  const nonce = requireBase64Url(record, 'nonce', 'nonce', NONCE_BYTES);

  const payloadRecord = asRecord(record.payload, 'payload');
  rejectUnknownKeys(payloadRecord, ['ciphertext'], 'payload.');
  const ciphertext = requireBase64Url(payloadRecord, 'ciphertext', 'payload.ciphertext');

  return {
    protocolVersion,
    routeId,
    messageId,
    direction,
    kind,
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
 * 解密后的内部消息。Playable 不得声明 cwd / repo / trustTier / runnerNode /
 * endpointId / workspacePolicyId —— 这些一律由服务端从 endpoint 解析（架构 §3 硬边界 3）。
 */
export function parseSecurePayload(input: unknown): SecurePayload {
  const record = asRecord(input, 'payload');
  const type = requireLiteral(record, 'type', 'type', SECURE_PAYLOAD_TYPES);

  // generation 缺省时**不写进结果**：M1 冻结的 turn 是四个键，凭空多一个键会让
  // 按字段清单断言的用例（两端各一套）全线错位。
  if (type === 'turn') {
    rejectUnknownKeys(record, TURN_KEYS);
    const turn: SecurePayload = {
      type,
      conversationId: requireString(record, 'conversationId', 'conversationId'),
      text: requireText(record, 'text', 'text'),
      clientSeq: requireInteger(record, 'clientSeq', 'clientSeq', 0),
    };
    const generation = optionalInteger(record, 'generation', 'generation', 1);
    return generation === undefined ? turn : { ...turn, generation };
  }

  if (type === 'control') {
    rejectUnknownKeys(record, CONTROL_KEYS);
    const op = requireLiteral(record, 'op', 'op', CONTROL_OPS);
    const conversationId = requireString(record, 'conversationId', 'conversationId');
    const targetTurnId = optionalString(record, 'targetTurnId', 'targetTurnId');
    const generation = optionalInteger(record, 'generation', 'generation', 1);
    const control: SecurePayload = { type, op, conversationId };
    return {
      ...control,
      ...(generation === undefined ? {} : { generation }),
      ...(targetTurnId === undefined ? {} : { targetTurnId }),
    };
  }

  rejectUnknownKeys(record, ACK_KEYS);
  return {
    type,
    ackMessageId: requireString(record, 'ackMessageId', 'ackMessageId'),
    status: requireLiteral(record, 'status', 'status', ACK_STATUSES),
  };
}
