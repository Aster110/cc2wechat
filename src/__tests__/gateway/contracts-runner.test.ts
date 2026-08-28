/**
 * M1 · 契约与 Runner 接缝（RED）
 *
 * 冻结对象：
 * - Channel 描述符 / IngressAck / DeliveryReceipt 词表（架构 §4.1）
 * - MailboxChunk 与 SecurePayload 的解析边界（架构 §6）
 * - PairingScope / TrustTier 词表（架构 §5、§5.1）
 * - AgentEndpoint / RunnerRequest（架构 §4.2；硬边界 §3.3：Playable 不得传 cwd/repo/trust/node）
 * - LocalRunnerAdapter → 现有 v6 `AgentAdapter` 的真实映射（复用而不是空壳）
 *
 * 错误约定（本测试即规格）：
 * - 所有 parse* 失败时 throw 一个带 `code`（大类）与 `field`（具体字段）的错误，
 *   这样负例能证明"因为目标字段被拒"，而不是"碰巧因为别的必填项缺失"。
 *
 * 模块路径分工（reviewer 二审第 3 条裁决）：
 * - `gateway/contracts/runner` 只放稳定契约解析（parseAgentEndpoint / parseRunnerRequest）
 * - `createLocalRunnerAdapter` 属于位置相关实现，放 `gateway/runners/local-runner`
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

// 静态引用现有 v6 契约：LocalRunnerAdapter 必须能把 RunnerRequest 映射成"真实的" AgentRequest，
// 并原样流出"真实的" AgentEvent 词表。类型对不上 = typecheck 红，空壳实现骗不过去。
import type {
  AgentAdapter,
  AgentEvent,
  AgentHealth,
  AgentRequest,
  SessionBinding,
} from '../../v6/contracts.js';

// ---------------------------------------------------------------------------
// 测试侧契约（不使用 any；动态 import 仅用于让尚未实现的模块先 RED）
// ---------------------------------------------------------------------------

type MailboxDirection = 'to_agent' | 'to_player';
type MailboxKind = 'pair' | 'turn' | 'control' | 'progress' | 'final' | 'error' | 'ack';
type TrustTier = 'chat-only' | 'sandbox-workspace' | 'repo-pr' | 'admin-bypass';
type PairingScope =
  | 'chat.send'
  | 'conversation.new'
  | 'conversation.stop'
  | 'conversation.resume'
  | 'artifact.read';

type ChannelDescriptor = {
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

type AgentEndpoint = {
  id: string;
  runnerProfileId: string;
  workspacePolicyId: string;
  trustTier: TrustTier;
  status: 'active' | 'disabled';
};

/**
 * 客户端可控字段的全集。刻意不含 cwd / repo / runnerNode / trustTier / workspacePolicyId：
 * 这些只能由服务端从 endpoint 解析（架构 §3 硬边界 3）。
 */
type RunnerRequest = {
  conversationId: string;
  turnId: string;
  text: string;
  mediaPaths: string[];
};

type ComponentHealth = { ok: boolean; detail?: string };

type RunnerDescriptor = {
  runnerId: string;
  nodeId: string;
  kind: 'local' | 'remote';
  capabilities: string[];
};

type RunnerAdapterApi = {
  readonly descriptor: RunnerDescriptor;
  run(endpoint: AgentEndpoint, request: RunnerRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  reset(endpoint: AgentEndpoint, conversationId: string): Promise<void>;
  health(endpoint?: AgentEndpoint): Promise<ComponentHealth>;
  shutdown(): Promise<void>;
};

type LocalRunnerOptions = {
  runnerId: string;
  nodeId: string;
  agent: AgentAdapter;
  /** cwd 的唯一来源：endpoint.workspacePolicyId */
  resolveWorkspace(workspacePolicyId: string): string;
  getBinding(conversationId: string): SessionBinding | null;
};

type ContractError = Error & { code: string; field?: string };

type ChannelContractsModule = {
  parseChannelDescriptor(input: unknown): ChannelDescriptor;
  INGRESS_ACK_STATUSES: readonly string[];
  DELIVERY_RECEIPT_STATUSES: readonly string[];
};

type EnvelopeContractsModule = {
  parseMailboxChunk(input: unknown, now: number): MailboxChunk;
  parseSecurePayload(input: unknown): SecurePayload;
  MAX_CLOCK_SKEW_MS: number;
};

type PairingContractsModule = {
  PAIRING_SCOPES: readonly PairingScope[];
  TRUST_TIERS: readonly TrustTier[];
};

type RunnerContractsModule = {
  parseAgentEndpoint(input: unknown): AgentEndpoint;
  parseRunnerRequest(input: unknown): RunnerRequest;
};

type LocalRunnerModule = {
  createLocalRunnerAdapter(options: LocalRunnerOptions): RunnerAdapterApi;
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 变量形式的 specifier：让 tsc 不做静态解析，运行期才因模块缺失而 RED。 */
function lazyModule<T>(specifier: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = import(specifier) as Promise<T>;
    return cached;
  };
}

const loadChannel = lazyModule<ChannelContractsModule>('../../gateway/contracts/channel.js');
const loadEnvelope = lazyModule<EnvelopeContractsModule>('../../gateway/contracts/envelope.js');
const loadPairing = lazyModule<PairingContractsModule>('../../gateway/contracts/pairing.js');
const loadRunner = lazyModule<RunnerContractsModule>('../../gateway/contracts/runner.js');
const loadLocalRunner = lazyModule<LocalRunnerModule>('../../gateway/runners/local-runner.js');

function captureThrow(fn: () => unknown): ContractError {
  try {
    fn();
  } catch (e) {
    return e as ContractError;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

function patch(base: object, changes: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...changes };
}

function without(base: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...base };
  delete copy[field];
  return copy;
}

/** 合法 UUIDv7：时间戳前缀 + version nibble 7 + RFC4122 variant。 */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NOW = 1_760_000_000_000;

function validChunk(): MailboxChunk {
  return {
    protocolVersion: 1,
    routeId: 'rt_' + randomBytes(8).toString('hex'),
    messageId: uuidv7(),
    direction: 'to_agent',
    kind: 'turn',
    keyVersion: 1,
    chunkIndex: 0,
    chunkCount: 1,
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    nonce: randomBytes(12).toString('base64url'),
    payload: { ciphertext: randomBytes(48).toString('base64url') },
  };
}

class RecordingAgent implements AgentAdapter {
  readonly name = 'codex';
  readonly persistent = true;
  readonly requests: AgentRequest[] = [];
  readonly resets: string[] = [];
  readonly signals: AbortSignal[] = [];
  healthCalls = 0;
  shutdownCalls = 0;
  script: AgentEvent[] = [];

  async *run(req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.requests.push(req);
    this.signals.push(signal);
    for (const event of this.script) yield event;
  }

  async reset(conversationId: string): Promise<void> {
    this.resets.push(conversationId);
  }

  async health(): Promise<AgentHealth> {
    this.healthCalls += 1;
    return { ok: true, detail: 'stub-agent' };
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

const adminEndpoint: AgentEndpoint = {
  id: 'aster-admin',
  runnerProfileId: 'local-729a',
  workspacePolicyId: 'admin-home',
  trustTier: 'admin-bypass',
  status: 'active',
};

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Channel 契约
// ---------------------------------------------------------------------------

describe('M1 · Channel 契约', () => {
  it('parseChannelDescriptor 接受完整合法的 waku descriptor 并原样冻结 capabilities', async () => {
    const mod = await loadChannel();
    const input = {
      type: 'waku',
      instanceId: 'waku-729a',
      protocolVersion: 1,
      capabilities: { progress: true, presence: true, attachments: false, maxMessageBytes: 65_536 },
    };
    const d = mod.parseChannelDescriptor(input);
    expect(d.type).toBe('waku');
    expect(d.instanceId).toBe('waku-729a');
    expect(d.protocolVersion).toBe(1);
    expect(d.capabilities).toEqual({
      progress: true,
      presence: true,
      attachments: false,
      maxMessageBytes: 65_536,
    });
  });

  it('parseChannelDescriptor 拒绝未知 type、错 protocolVersion 与非法 maxMessageBytes', async () => {
    const mod = await loadChannel();
    const base = {
      type: 'waku',
      instanceId: 'waku-729a',
      protocolVersion: 1,
      capabilities: { progress: true, presence: true, attachments: false, maxMessageBytes: 65_536 },
    };

    expect(captureThrow(() => mod.parseChannelDescriptor(patch(base, { type: 'wechat' }))).field).toBe('type');
    expect(captureThrow(() => mod.parseChannelDescriptor(patch(base, { protocolVersion: 2 }))).field).toBe(
      'protocolVersion',
    );
    expect(
      captureThrow(() =>
        mod.parseChannelDescriptor(
          patch(base, { capabilities: { ...base.capabilities, maxMessageBytes: 0 } }),
        ),
      ).field,
    ).toBe('capabilities.maxMessageBytes');
    expect(captureThrow(() => mod.parseChannelDescriptor(without(base, 'instanceId'))).field).toBe('instanceId');
  });

  it('IngressAck / DeliveryReceipt 的状态词表被冻结，不允许实现自造第五种回执', async () => {
    const mod = await loadChannel();
    expect([...mod.INGRESS_ACK_STATUSES].sort()).toEqual(['accepted', 'duplicate', 'rejected']);
    expect([...mod.DELIVERY_RECEIPT_STATUSES].sort()).toEqual([
      'permanent-failure',
      'retryable',
      'sent',
      'unknown',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 词表：Scope 与 TrustTier
// ---------------------------------------------------------------------------

describe('M1 · Pairing 词表', () => {
  it('PAIRING_SCOPES 与架构 §5 完全一致', async () => {
    const mod = await loadPairing();
    expect([...mod.PAIRING_SCOPES].sort()).toEqual([
      'artifact.read',
      'chat.send',
      'conversation.new',
      'conversation.resume',
      'conversation.stop',
    ]);
  });

  it('TRUST_TIERS 按权限从低到高排列，admin-bypass 最高', async () => {
    const mod = await loadPairing();
    // 顺序有语义：授权判定要靠 index 比大小，不是靠字符串集合。
    expect([...mod.TRUST_TIERS]).toEqual([
      'chat-only',
      'sandbox-workspace',
      'repo-pr',
      'admin-bypass',
    ]);
  });
});

// ---------------------------------------------------------------------------
// MailboxChunk 解析：先证明完整 fixture 合法，再逐字段 mutate
// ---------------------------------------------------------------------------

describe('M1 · MailboxChunk 解析', () => {
  it('接受一个字段齐全的合法 chunk（基线，用于隔离后续负例）', async () => {
    const mod = await loadEnvelope();
    const chunk = validChunk();
    const parsed = mod.parseMailboxChunk(chunk, NOW);
    expect(parsed).toEqual(chunk);
  });

  it('拒绝非法 protocolVersion 与 keyVersion', async () => {
    const mod = await loadEnvelope();
    const base = validChunk();
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { protocolVersion: 2 }), NOW)).field).toBe(
      'protocolVersion',
    );
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { protocolVersion: '1' }), NOW)).field).toBe(
      'protocolVersion',
    );
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { keyVersion: 0 }), NOW)).field).toBe('keyVersion');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { keyVersion: -1 }), NOW)).field).toBe('keyVersion');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { keyVersion: 1.5 }), NOW)).field).toBe('keyVersion');
  });

  it('拒绝词表外的 direction 与 kind', async () => {
    const mod = await loadEnvelope();
    const base = validChunk();
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { direction: 'to_admin' }), NOW)).field).toBe(
      'direction',
    );
    expect(captureThrow(() => mod.parseMailboxChunk(without(base, 'direction'), NOW)).field).toBe('direction');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { kind: 'shell' }), NOW)).field).toBe('kind');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { kind: '' }), NOW)).field).toBe('kind');
  });

  it('拒绝结构非法的 chunkIndex / chunkCount（含超过 16 块上限）', async () => {
    const mod = await loadEnvelope();
    const base = validChunk();
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { chunkIndex: 1 }), NOW)).field).toBe('chunkIndex');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { chunkIndex: -1 }), NOW)).field).toBe('chunkIndex');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { chunkCount: 0 }), NOW)).field).toBe('chunkCount');
    expect(
      captureThrow(() => mod.parseMailboxChunk(patch(base, { chunkIndex: 16, chunkCount: 17 }), NOW)).field,
    ).toBe('chunkCount');
  });

  it('createdAt/expiresAt 一律 fail-closed：now>=expiresAt 拒绝，createdAt>=expiresAt 拒绝，时钟偏移只容忍固定窗口', async () => {
    const mod = await loadEnvelope();
    const base = validChunk();
    const skew = mod.MAX_CLOCK_SKEW_MS;
    expect(Number.isInteger(skew)).toBe(true);
    expect(skew).toBeGreaterThan(0);

    // 到期点即失效（不是 +1ms 才失效）
    expect(mod.parseMailboxChunk(base, base.expiresAt - 1).messageId).toBe(base.messageId);
    expect(captureThrow(() => mod.parseMailboxChunk(base, base.expiresAt)).field).toBe('expiresAt');
    expect(captureThrow(() => mod.parseMailboxChunk(base, base.expiresAt + 1)).field).toBe('expiresAt');

    // createdAt 不得晚于/等于 expiresAt
    expect(
      captureThrow(() => mod.parseMailboxChunk(patch(base, { createdAt: base.expiresAt }), NOW)).field,
    ).toBe('createdAt');

    // 未来时间戳：窗口内容忍，窗口外拒绝；窗口是常量，调用方给不了旋钮
    const inSkew = patch(base, { createdAt: NOW + skew - 1 });
    expect(mod.parseMailboxChunk(inSkew, NOW).createdAt).toBe(NOW + skew - 1);
    const outOfSkew = patch(base, { createdAt: NOW + skew + 1 });
    expect(captureThrow(() => mod.parseMailboxChunk(outOfSkew, NOW)).field).toBe('createdAt');
  });

  it('拒绝非法 nonce 与空/非 base64url 密文', async () => {
    const mod = await loadEnvelope();
    const base = validChunk();
    // nonce 必须是 12 字节 base64url
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { nonce: '' }), NOW)).field).toBe('nonce');
    expect(
      captureThrow(() => mod.parseMailboxChunk(patch(base, { nonce: randomBytes(11).toString('base64url') }), NOW))
        .field,
    ).toBe('nonce');
    expect(
      captureThrow(() => mod.parseMailboxChunk(patch(base, { nonce: randomBytes(12).toString('base64') + '==' }), NOW))
        .field,
    ).toBe('nonce');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { payload: { ciphertext: '' } }), NOW)).field).toBe(
      'payload.ciphertext',
    );
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { payload: {} }), NOW)).field).toBe(
      'payload.ciphertext',
    );
  });

  it('拒绝未知额外字段（防止客户端夹带执行策略）', async () => {
    const mod = await loadEnvelope();
    const base = validChunk();
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { cwd: '/Users/aster' }), NOW)).field).toBe('cwd');
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { trustTier: 'admin-bypass' }), NOW)).field).toBe(
      'trustTier',
    );
    expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { runnerNode: '729a' }), NOW)).field).toBe(
      'runnerNode',
    );
  });

  it('messageId 必须是合法 UUIDv7（架构 §6 冻结，不接受任意非空字符串）', async () => {
    const mod = await loadEnvelope();
    const base = validChunk();
    // 正例：多次生成都应通过
    for (let i = 0; i < 4; i += 1) {
      expect(mod.parseMailboxChunk(patch(base, { messageId: uuidv7() }), NOW).messageId).toHaveLength(36);
    }
    // 负例
    for (const bad of [
      '',
      'msg-1',
      '018f4e2a-9c3d-4a1b-8f2e-1a2b3c4d5e6f', // version 4，不是 7
      '018f4e2a-9c3d-7a1b-8f2e-1a2b3c4d5e', // 破损，长度不足
      '018f4e2a9c3d7a1b8f2e1a2b3c4d5e6f', // 缺连字符
    ]) {
      expect(captureThrow(() => mod.parseMailboxChunk(patch(base, { messageId: bad }), NOW)).field).toBe('messageId');
    }
  });
});

// ---------------------------------------------------------------------------
// SecurePayload
// ---------------------------------------------------------------------------

describe('M1 · SecurePayload 解析', () => {
  it('接受 turn / control(stop|new|resume) / ack 三类合法内部消息', async () => {
    const mod = await loadEnvelope();

    const turn = mod.parseSecurePayload({ type: 'turn', conversationId: 'conv-1', text: '你好', clientSeq: 7 });
    expect(turn).toEqual({ type: 'turn', conversationId: 'conv-1', text: '你好', clientSeq: 7 });

    for (const op of ['stop', 'new', 'resume'] as const) {
      const ctl = mod.parseSecurePayload({ type: 'control', op, conversationId: 'conv-1' });
      expect(ctl.type).toBe('control');
      if (ctl.type === 'control') expect(ctl.op).toBe(op);
    }

    const stopTargeted = mod.parseSecurePayload({
      type: 'control',
      op: 'stop',
      conversationId: 'conv-1',
      targetTurnId: 'turn-9',
    });
    if (stopTargeted.type === 'control') expect(stopTargeted.targetTurnId).toBe('turn-9');

    for (const status of ['received', 'completed', 'displayed'] as const) {
      const ack = mod.parseSecurePayload({ type: 'ack', ackMessageId: uuidv7(), status });
      expect(ack.type).toBe('ack');
      if (ack.type === 'ack') expect(ack.status).toBe(status);
    }
  });

  it('拒绝空白 turn、未知 op/status，以及客户端夹带的执行策略字段', async () => {
    const mod = await loadEnvelope();

    expect(
      captureThrow(() => mod.parseSecurePayload({ type: 'turn', conversationId: 'c', text: '', clientSeq: 1 })).field,
    ).toBe('text');
    expect(
      captureThrow(() => mod.parseSecurePayload({ type: 'turn', conversationId: 'c', text: '   \n\t ', clientSeq: 1 }))
        .field,
    ).toBe('text');
    expect(
      captureThrow(() => mod.parseSecurePayload({ type: 'control', op: 'exec', conversationId: 'c' })).field,
    ).toBe('op');
    expect(
      captureThrow(() => mod.parseSecurePayload({ type: 'ack', ackMessageId: uuidv7(), status: 'seen' })).field,
    ).toBe('status');
    expect(captureThrow(() => mod.parseSecurePayload({ type: 'shell', cmd: 'rm -rf /' })).field).toBe('type');

    // 硬边界：Playable 不得声明 cwd / repo / trustTier / runnerNode / endpointId
    for (const field of ['cwd', 'repo', 'trustTier', 'runnerNode', 'endpointId', 'workspacePolicyId']) {
      const err = captureThrow(() =>
        mod.parseSecurePayload({ type: 'turn', conversationId: 'c', text: 'hi', clientSeq: 1, [field]: 'x' }),
      );
      expect(err.field).toBe(field);
    }
  });
});

// ---------------------------------------------------------------------------
// Endpoint / RunnerRequest
// ---------------------------------------------------------------------------

describe('M1 · Endpoint 与 RunnerRequest 契约', () => {
  it('parseAgentEndpoint 接受合法 endpoint，拒绝词表外 trustTier 与未知 status', async () => {
    const mod = await loadRunner();
    expect(mod.parseAgentEndpoint(adminEndpoint)).toEqual(adminEndpoint);
    expect(mod.parseAgentEndpoint(patch(adminEndpoint, { status: 'disabled' })).status).toBe('disabled');

    expect(captureThrow(() => mod.parseAgentEndpoint(patch(adminEndpoint, { trustTier: 'root' }))).field).toBe(
      'trustTier',
    );
    expect(captureThrow(() => mod.parseAgentEndpoint(patch(adminEndpoint, { status: 'draining' }))).field).toBe(
      'status',
    );
    expect(captureThrow(() => mod.parseAgentEndpoint(without(adminEndpoint, 'workspacePolicyId'))).field).toBe(
      'workspacePolicyId',
    );
  });

  it('parseRunnerRequest 接受客户端可控字段，并拒绝任何执行位置/权限字段', async () => {
    const mod = await loadRunner();
    const ok: RunnerRequest = {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      text: '跑一下测试',
      mediaPaths: [],
    };
    expect(mod.parseRunnerRequest(ok)).toEqual(ok);

    // 硬边界（架构 §3 硬边界 3 + 安全金线 §1.2）
    for (const field of [
      'cwd',
      'repo',
      'repoPath',
      'runnerNode',
      'nodeId',
      'trustTier',
      'endpointId',
      'workspacePolicyId',
    ]) {
      const err = captureThrow(() => mod.parseRunnerRequest({ ...ok, [field]: 'x' }));
      expect(err.field).toBe(field);
    }
    expect(captureThrow(() => mod.parseRunnerRequest(patch(ok, { text: '' }))).field).toBe('text');
    expect(captureThrow(() => mod.parseRunnerRequest(patch(ok, { mediaPaths: 'a.png' }))).field).toBe('mediaPaths');
  });
});

// ---------------------------------------------------------------------------
// LocalRunnerAdapter ←→ v6 AgentAdapter 接缝
// ---------------------------------------------------------------------------

describe('M1 · LocalRunnerAdapter 复用 v6 Agent', () => {
  it('descriptor 暴露节点身份；cwd 只由 endpoint 的 workspacePolicyId 解析，并完整映射成 v6 AgentRequest', async () => {
    const mod = await loadLocalRunner();
    const agent = new RecordingAgent();
    const binding: SessionBinding = {
      conversationId: 'conv-1',
      agentType: 'codex',
      providerSessionId: 'thread-abc',
      generation: 3,
      createdAt: 1,
      updatedAt: 2,
    };
    const workspaces: Record<string, string> = {
      'admin-home': '/home/waku/AIproject',
      'sandbox-a': '/tmp/sandbox-a',
    };

    const runner = mod.createLocalRunnerAdapter({
      runnerId: 'local-729a',
      nodeId: '729a',
      agent,
      resolveWorkspace: (policyId) => workspaces[policyId] ?? '/dev/null',
      getBinding: (conversationId) => (conversationId === 'conv-1' ? binding : null),
    });

    expect(runner.descriptor.nodeId).toBe('729a');
    expect(runner.descriptor.runnerId).toBe('local-729a');
    expect(runner.descriptor.kind).toBe('local');

    const request: RunnerRequest = {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      text: '跑一下测试',
      mediaPaths: ['/tmp/a.png'],
    };
    const ac = new AbortController();
    await collect(runner.run(adminEndpoint, request, ac.signal));

    expect(agent.requests).toHaveLength(1);
    const sent: AgentRequest = agent.requests[0];
    expect(sent.conversationId).toBe('conv-1');
    expect(sent.text).toBe('跑一下测试');
    expect(sent.mediaPaths).toEqual(['/tmp/a.png']);
    expect(sent.binding).toEqual(binding);
    expect(sent.cwd).toBe('/home/waku/AIproject');
    expect(agent.signals[0]).toBe(ac.signal);

    // 换 endpoint 的 workspace policy，cwd 必须跟着换 —— 证明 cwd 来自 endpoint 而不是别处
    await collect(
      runner.run(patch(adminEndpoint, { workspacePolicyId: 'sandbox-a' }) as unknown as AgentEndpoint, request, ac.signal),
    );
    expect(agent.requests[1].cwd).toBe('/tmp/sandbox-a');
  });

  it('原样流出 v6 AgentEvent 词表，不改写不吞事件；reset/health/shutdown 委托给 v6 Agent', async () => {
    const mod = await loadLocalRunner();
    const agent = new RecordingAgent();
    agent.script = [
      { type: 'started', providerSessionId: 'thread-abc' },
      { type: 'progress', text: 'running tests' },
      { type: 'sessionChanged', providerSessionId: 'thread-def' },
      { type: 'final', text: 'done', mediaFiles: ['/tmp/out.png'] },
    ];

    const runner = mod.createLocalRunnerAdapter({
      runnerId: 'local-729a',
      nodeId: '729a',
      agent,
      resolveWorkspace: () => '/home/waku/AIproject',
      getBinding: () => null,
    });

    const events = await collect(
      runner.run(
        adminEndpoint,
        { conversationId: 'conv-1', turnId: 'turn-1', text: 'hi', mediaPaths: [] },
        new AbortController().signal,
      ),
    );
    expect(events).toEqual(agent.script);

    await runner.reset(adminEndpoint, 'conv-1');
    expect(agent.resets).toEqual(['conv-1']);

    const health = await runner.health(adminEndpoint);
    expect(health.ok).toBe(true);
    expect(agent.healthCalls).toBe(1);

    await runner.shutdown();
    expect(agent.shutdownCalls).toBe(1);
  });

  it('endpoint disabled 时直接拒绝，绝不调用 v6 Agent（不产生 Codex rollout）', async () => {
    const mod = await loadLocalRunner();
    const agent = new RecordingAgent();
    const runner = mod.createLocalRunnerAdapter({
      runnerId: 'local-729a',
      nodeId: '729a',
      agent,
      resolveWorkspace: () => '/home/waku/AIproject',
      getBinding: () => null,
    });

    const disabled = patch(adminEndpoint, { status: 'disabled' }) as unknown as AgentEndpoint;
    let error: ContractError | undefined = undefined;
    try {
      await collect(
        runner.run(
          disabled,
          { conversationId: 'conv-1', turnId: 'turn-1', text: 'hi', mediaPaths: [] },
          new AbortController().signal,
        ),
      );
    } catch (e) {
      error = e as ContractError;
    }
    expect(error?.code).toBe('endpoint_disabled');
    expect(agent.requests).toHaveLength(0);
  });
});
