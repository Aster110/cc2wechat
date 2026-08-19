/**
 * Channel 契约（架构 §4.1）。
 *
 * 回执词表被冻结成常量：实现不得自造第五种 IngressAck / DeliveryReceipt，
 * 否则上游的重试/去重判定会出现没人处理的分支。
 */
import {
  asRecord,
  requireBoolean,
  requireExactNumber,
  requireInteger,
  requireLiteral,
  requireString,
  rejectUnknownKeys,
} from './validation.js';

export const CHANNEL_TYPES = ['waku'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_PROTOCOL_VERSION = 1;

export const INGRESS_ACK_STATUSES = ['accepted', 'duplicate', 'rejected'] as const;
export type IngressAckStatus = (typeof INGRESS_ACK_STATUSES)[number];

export const DELIVERY_RECEIPT_STATUSES = ['sent', 'retryable', 'permanent-failure', 'unknown'] as const;
export type DeliveryReceiptStatus = (typeof DELIVERY_RECEIPT_STATUSES)[number];

export type IngressAck =
  | { status: 'accepted' }
  | { status: 'duplicate' }
  | { status: 'rejected'; code: string };

export type DeliveryReceipt =
  | { status: 'sent'; externalDeliveryId?: string }
  | { status: 'retryable'; code: string; retryAfterMs?: number }
  | { status: 'permanent-failure'; code: string }
  | { status: 'unknown'; code: string };

export interface ChannelCapabilities {
  progress: boolean;
  presence: boolean;
  attachments: boolean;
  maxMessageBytes: number;
}

export interface ChannelDescriptor {
  type: ChannelType;
  instanceId: string;
  protocolVersion: typeof CHANNEL_PROTOCOL_VERSION;
  capabilities: ChannelCapabilities;
}

export interface ComponentHealth {
  ok: boolean;
  detail?: string;
}

const DESCRIPTOR_KEYS = ['type', 'instanceId', 'protocolVersion', 'capabilities'] as const;
const CAPABILITY_KEYS = ['progress', 'presence', 'attachments', 'maxMessageBytes'] as const;

export function parseChannelDescriptor(input: unknown): ChannelDescriptor {
  const record = asRecord(input, 'descriptor');
  rejectUnknownKeys(record, DESCRIPTOR_KEYS);

  const type = requireLiteral(record, 'type', 'type', CHANNEL_TYPES);
  const instanceId = requireString(record, 'instanceId', 'instanceId');
  const protocolVersion = requireExactNumber(
    record,
    'protocolVersion',
    'protocolVersion',
    CHANNEL_PROTOCOL_VERSION,
  );

  const capabilitiesRecord = asRecord(record.capabilities, 'capabilities');
  rejectUnknownKeys(capabilitiesRecord, CAPABILITY_KEYS, 'capabilities.');

  const capabilities: ChannelCapabilities = {
    progress: requireBoolean(capabilitiesRecord, 'progress', 'capabilities.progress'),
    presence: requireBoolean(capabilitiesRecord, 'presence', 'capabilities.presence'),
    attachments: requireBoolean(capabilitiesRecord, 'attachments', 'capabilities.attachments'),
    maxMessageBytes: requireInteger(
      capabilitiesRecord,
      'maxMessageBytes',
      'capabilities.maxMessageBytes',
      1,
    ),
  };

  return {
    type,
    instanceId,
    protocolVersion: protocolVersion as typeof CHANNEL_PROTOCOL_VERSION,
    capabilities,
  };
}
