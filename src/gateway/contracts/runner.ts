/**
 * Endpoint 与 Runner 契约（架构 §4.2）。
 *
 * 硬边界（架构 §3 硬边界 3）：`RunnerRequest` 是**客户端可控字段的全集**，
 * 刻意不含 cwd / repo / runnerNode / nodeId / trustTier / endpointId / workspacePolicyId。
 * 执行位置与权限只能由服务端从 `AgentEndpoint` 解析——所以这些字段一出现在入参里，
 * 就是提权尝试，直接拒，而不是"忽略掉"。
 */
import type { AgentEvent } from '../../v6/contracts.js';
import type { ComponentHealth } from './channel.js';
import { TRUST_TIERS, type TrustTier } from './pairing.js';
import {
  asRecord,
  requireString,
  requireStringArray,
  requireLiteral,
  requireText,
  rejectUnknownKeys,
} from './validation.js';

export type { TrustTier };

export const ENDPOINT_STATUSES = ['active', 'disabled'] as const;
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number];

export interface AgentEndpoint {
  id: string;
  runnerProfileId: string;
  workspacePolicyId: string;
  trustTier: TrustTier;
  status: EndpointStatus;
}

export interface RunnerRequest {
  conversationId: string;
  turnId: string;
  text: string;
  mediaPaths: string[];
}

export interface RunnerDescriptor {
  runnerId: string;
  nodeId: string;
  kind: 'local' | 'remote';
  capabilities: string[];
}

export interface RunnerAdapter {
  readonly descriptor: RunnerDescriptor;
  run(
    endpoint: AgentEndpoint,
    request: RunnerRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  reset(endpoint: AgentEndpoint, conversationId: string): Promise<void>;
  health(endpoint?: AgentEndpoint): Promise<ComponentHealth>;
  shutdown(): Promise<void>;
}

const ENDPOINT_KEYS = [
  'id',
  'runnerProfileId',
  'workspacePolicyId',
  'trustTier',
  'status',
] as const;

const RUNNER_REQUEST_KEYS = ['conversationId', 'turnId', 'text', 'mediaPaths'] as const;

export function parseAgentEndpoint(input: unknown): AgentEndpoint {
  const record = asRecord(input, 'endpoint');
  rejectUnknownKeys(record, ENDPOINT_KEYS);
  return {
    id: requireString(record, 'id', 'id'),
    runnerProfileId: requireString(record, 'runnerProfileId', 'runnerProfileId'),
    workspacePolicyId: requireString(record, 'workspacePolicyId', 'workspacePolicyId'),
    trustTier: requireLiteral(record, 'trustTier', 'trustTier', TRUST_TIERS),
    status: requireLiteral(record, 'status', 'status', ENDPOINT_STATUSES),
  };
}

export function parseRunnerRequest(input: unknown): RunnerRequest {
  const record = asRecord(input, 'request');
  rejectUnknownKeys(record, RUNNER_REQUEST_KEYS);
  return {
    conversationId: requireString(record, 'conversationId', 'conversationId'),
    turnId: requireString(record, 'turnId', 'turnId'),
    text: requireText(record, 'text', 'text'),
    mediaPaths: requireStringArray(record, 'mediaPaths', 'mediaPaths'),
  };
}
