/**
 * M4 · GatewayOrchestrator（RED）
 *
 * 架构 §9 running→final/error、§10 stop/new/resume、§11 每 pairing 限额、
 * §12 健康面、§13 故障恢复 + 任务书 §6.3/§6.4/§6.5。
 *
 * 这一层把「一条已授权的 TurnJob」变成「Agent 真跑一轮 + 出站回复落库」，冻结：
 *
 * 1. **每 pairing 串行**（架构 §11 同时执行 turn 数默认 1），不同 pairing 并行。
 * 2. **stop 走抢占通道**：不排在普通队列后面、abort 正在跑的一轮、重复 stop 幂等。
 *    —— 本文件里 stop 的用例都在"当前 turn 还被闸门卡住"时 await，
 *    实现要是把 stop 排进队列，这里会直接超时挂死，这就是断言本身。
 * 3. **new 提升代数**：abort 当前 turn、清队列、断旧 provider binding、回 ack。
 * 4. **拒绝要有回音，但只对容量/生命周期类**：queue_full / draining / endpoint_disabled
 *    要给玩家一条 error，让他知道消息没被执行；鉴权类拒绝由 ingress 静默处理
 *    （不给未授权者任何存在性反馈）。
 * 5. **崩溃不自动重跑**：running 的 turn 重启后标 interrupted，绝不再调一次 `run()`
 *    —— 它可能已经改过代码了。
 *
 * 时间/并发全注入：`TestClock` + 闸门式 FakeAgent，全程不 sleep、不用真 timer。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { createLocalRunnerAdapter } from '../../gateway/runners/local-runner.js';
import type { AgentEndpoint, RunnerAdapter } from '../../gateway/contracts/runner.js';
import type { GatewayStore } from '../../gateway/state/sqlite-store.js';
import type { SessionBinding } from '../../v6/contracts.js';

import {
  FakeAgent,
  FakeChannel,
  TestClock,
  assertNoSecrets,
  keysOf,
  lazyModule,
  makeUuidV7,
  openTestStore,
  seedEndpoint,
  seedPairing,
  tick,
  type ChannelAdapterApi,
  type ControlOp,
  type DeliveryReceipt,
  type MailboxKind,
  type SecurePayload,
  type SeededPairing,
  type TestStore,
} from './harness.js';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type TurnJob = {
  pairingId: string;
  principalId: string;
  endpointId: string;
  routeId: string;
  keyVersion: number;
  conversationId: string;
  generation: number;
  messageId: string;
  text: string;
  clientSeq: number;
  receivedAt: number;
};

type ControlCommand = {
  op: ControlOp;
  pairingId: string;
  principalId: string;
  endpointId: string;
  routeId: string;
  keyVersion: number;
  conversationId: string;
  generation: number;
  messageId: string;
  receivedAt: number;
  targetTurnId?: string;
  previousConversationId?: string;
};

type SubmitResult =
  | { status: 'started'; turnId: string }
  | { status: 'queued'; depth: number; turnId: string }
  | { status: 'rejected'; code: string };

type ControlResult =
  | { status: 'ok'; cleared?: number; generation?: number }
  | { status: 'noop' }
  | { status: 'rejected'; code: string };

type GatewayHealth = {
  core: { ok: boolean };
  runner: { nodeId: string; ok: boolean };
  endpoints: Array<{ id: string; ok: boolean; status: 'active' | 'disabled' }>;
  queues: { running: number; queued: number };
  lastTurn: { outcome: 'final' | 'error' | 'aborted' | 'interrupted'; totalMs: number } | null;
};

type GatewayOrchestratorApi = {
  submitTurn(job: TurnJob): Promise<SubmitResult>;
  control(command: ControlCommand): Promise<ControlResult>;
  /** 启动时调用一次：把上次崩溃留下的 running turn 标成 interrupted，不重跑。 */
  recover(): { interrupted: number };
  /** SIGTERM 语义：不再接新 turn，等当前 turn 收尾。 */
  drain(): Promise<void>;
  health(): Promise<GatewayHealth>;
};

type ConversationSnapshot = {
  id: string;
  pairingId: string;
  principalId: string;
  generation: number;
};

type ConversationDecision =
  | { allowed: true; conversation: ConversationSnapshot; created: boolean; generationChanged: boolean }
  | { allowed: false; code: string; message: string };

type ConversationRef = {
  conversationId: string;
  generation: number;
  pairingId: string;
  principalId: string;
};

type ConversationServiceApi = {
  open(input: ConversationRef): ConversationDecision;
  startNew(input: ConversationRef & { previousConversationId?: string }): ConversationDecision;
  authorize(input: Omit<ConversationRef, 'generation'>): ConversationDecision;
  bindProvider(input: {
    conversationId: string;
    generation: number;
    agentType: string;
    providerSessionId: string;
  }): void;
  binding(conversationId: string): SessionBinding | null;
};

type EndpointResolution = { endpoint: AgentEndpoint; runner: RunnerAdapter };
type EndpointHealth = { id: string; ok: boolean; status: 'active' | 'disabled'; nodeId?: string };

type AgentEndpointRegistryApi = {
  resolve(endpointId: string): EndpointResolution;
  list(): AgentEndpoint[];
  health(): Promise<EndpointHealth[]>;
};

type CoreDeliveryApi = {
  publish(input: {
    pairingId: string;
    routeId: string;
    keyVersion: number;
    kind: MailboxKind;
    payload: SecurePayload;
  }): Promise<{ messageId: string; receipt: DeliveryReceipt }>;
  flushPending(): Promise<{ attempted: number; sent: number; pending: number; failed: number }>;
  acknowledge(input: {
    pairingId: string;
    ackMessageId: string;
    status: 'received' | 'completed' | 'displayed';
  }): 'acknowledged' | 'unknown';
  pendingCount(): number;
};

type OrchestratorModule = {
  createGatewayOrchestrator(options: {
    store: GatewayStore;
    registry: AgentEndpointRegistryApi;
    conversations: ConversationServiceApi;
    delivery: CoreDeliveryApi;
    now(): number;
    newTurnId(): string;
    queueCap?: number;
  }): GatewayOrchestratorApi;
};

type CoreDeliveryModule = {
  createCoreDelivery(options: {
    store: GatewayStore;
    channel: ChannelAdapterApi;
    now(): number;
    newMessageId(): string;
    ttlMs?: number;
  }): CoreDeliveryApi;
};

const loadOrchestrator = lazyModule<OrchestratorModule>('../../gateway/core/orchestrator.js');
const loadDelivery = lazyModule<CoreDeliveryModule>('../../gateway/core/delivery.js');

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

class MemoryConversations implements ConversationServiceApi {
  private readonly rows = new Map<string, ConversationSnapshot>();
  private readonly bindings = new Map<string, SessionBinding>();

  open(input: ConversationRef): ConversationDecision {
    const existing = this.rows.get(input.conversationId);
    if (existing === undefined) {
      const created: ConversationSnapshot = {
        id: input.conversationId,
        pairingId: input.pairingId,
        principalId: input.principalId,
        generation: input.generation,
      };
      this.rows.set(input.conversationId, created);
      return { allowed: true, conversation: created, created: true, generationChanged: false };
    }
    if (existing.pairingId !== input.pairingId || existing.principalId !== input.principalId) {
      return { allowed: false, code: 'conversation_forbidden', message: 'not yours' };
    }
    if (input.generation < existing.generation) {
      return { allowed: false, code: 'stale_generation', message: 'stale' };
    }
    const changed = input.generation > existing.generation;
    if (changed) this.bindings.delete(input.conversationId);
    existing.generation = input.generation;
    return { allowed: true, conversation: existing, created: false, generationChanged: changed };
  }

  startNew(input: ConversationRef & { previousConversationId?: string }): ConversationDecision {
    if (this.rows.has(input.conversationId)) {
      return { allowed: false, code: 'conversation_exists', message: 'exists' };
    }
    if (input.previousConversationId !== undefined) {
      const previous = this.rows.get(input.previousConversationId);
      if (previous !== undefined && previous.pairingId !== input.pairingId) {
        return { allowed: false, code: 'conversation_forbidden', message: 'not yours' };
      }
      if (previous !== undefined) {
        previous.generation += 1;
        this.bindings.delete(input.previousConversationId);
      }
    }
    return this.open(input);
  }

  authorize(input: Omit<ConversationRef, 'generation'>): ConversationDecision {
    const existing = this.rows.get(input.conversationId);
    if (existing === undefined) {
      return { allowed: false, code: 'conversation_not_found', message: 'missing' };
    }
    if (existing.pairingId !== input.pairingId || existing.principalId !== input.principalId) {
      return { allowed: false, code: 'conversation_forbidden', message: 'not yours' };
    }
    return { allowed: true, conversation: existing, created: false, generationChanged: false };
  }

  bindProvider(input: {
    conversationId: string;
    generation: number;
    agentType: string;
    providerSessionId: string;
  }): void {
    const row = this.rows.get(input.conversationId);
    if (row === undefined || row.generation !== input.generation) return;
    this.bindings.set(input.conversationId, {
      conversationId: input.conversationId,
      agentType: input.agentType,
      providerSessionId: input.providerSessionId,
      generation: input.generation,
      createdAt: 0,
      updatedAt: 0,
    });
  }

  binding(conversationId: string): SessionBinding | null {
    return this.bindings.get(conversationId) ?? null;
  }
}

class StoreRegistry implements AgentEndpointRegistryApi {
  constructor(
    private readonly store: GatewayStore,
    private readonly runner: RunnerAdapter,
    private readonly ids: string[],
  ) {}

  resolve(endpointId: string): EndpointResolution {
    const endpoint = this.store.getEndpoint(endpointId);
    if (endpoint === null) throw named('endpoint_not_found');
    if (endpoint.status !== 'active') throw named('endpoint_disabled');
    return { endpoint, runner: this.runner };
  }

  list(): AgentEndpoint[] {
    const out: AgentEndpoint[] = [];
    for (const id of this.ids) {
      const endpoint = this.store.getEndpoint(id);
      if (endpoint !== null) out.push(endpoint);
    }
    return out;
  }

  async health(): Promise<EndpointHealth[]> {
    const out: EndpointHealth[] = [];
    for (const endpoint of this.list()) {
      const runnerHealth = endpoint.status === 'active' ? await this.runner.health(endpoint) : { ok: false };
      out.push({
        id: endpoint.id,
        ok: endpoint.status === 'active' && runnerHealth.ok,
        status: endpoint.status,
        nodeId: this.runner.descriptor.nodeId,
      });
    }
    return out;
  }
}

function named(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let handle: TestStore | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface Fixture {
  store: GatewayStore;
  clock: TestClock;
  agent: FakeAgent;
  channel: FakeChannel;
  delivery: CoreDeliveryApi;
  conversations: MemoryConversations;
  registry: StoreRegistry;
  orchestrator: GatewayOrchestratorApi;
  alice: SeededPairing;
  bob: SeededPairing;
  newTurnId: () => string;
  workspaces: string[];
}

async function setup(options: { queueCap?: number } = {}): Promise<Fixture> {
  handle = openTestStore();
  const store = handle.store;
  const clock = new TestClock();
  seedEndpoint(store, { id: 'aster-admin', workspacePolicyId: 'admin-home' });

  const alice = await seedPairing(store, clock, { endpointId: 'aster-admin' });
  const bob = await seedPairing(store, clock, { endpointId: 'aster-admin' });

  const agent = new FakeAgent();
  const conversations = new MemoryConversations();
  const workspaces: string[] = [];
  const runner = createLocalRunnerAdapter({
    runnerId: 'local-729a',
    nodeId: '729a',
    agent,
    resolveWorkspace: (policyId) => {
      workspaces.push(policyId);
      return `/home/waku/ws/${policyId}`;
    },
    getBinding: (conversationId) => conversations.binding(conversationId),
  });
  const registry = new StoreRegistry(store, runner, ['aster-admin']);

  // 先加载被测模块本身：RED 阶段的失败要指向 orchestrator，而不是它的依赖
  const mod = await loadOrchestrator();

  const channel = new FakeChannel();
  const deliveryMod = await loadDelivery();
  const delivery = deliveryMod.createCoreDelivery({
    store,
    channel,
    now: clock.now,
    newMessageId: makeUuidV7('0198dddd'),
  });

  const newTurnId = makeUuidV7('0198cccc');
  const orchestrator = mod.createGatewayOrchestrator({
    store,
    registry,
    conversations,
    delivery,
    now: clock.now,
    newTurnId,
    queueCap: options.queueCap,
  });

  return {
    store,
    clock,
    agent,
    channel,
    delivery,
    conversations,
    registry,
    orchestrator,
    alice,
    bob,
    newTurnId,
    workspaces,
  };
}

const messageIds = makeUuidV7('0198aaaa');

function jobFor(
  pairing: SeededPairing,
  clock: TestClock,
  overrides: Partial<TurnJob> = {},
): TurnJob {
  return {
    pairingId: pairing.pairingId,
    principalId: pairing.principalId,
    endpointId: pairing.endpointId,
    routeId: pairing.routeId,
    keyVersion: pairing.keyVersion,
    conversationId: `conv-${pairing.pairingId.slice(-4)}`,
    generation: 1,
    messageId: messageIds(),
    text: 'ping',
    clientSeq: 0,
    receivedAt: clock.now(),
    ...overrides,
  };
}

function controlFor(
  pairing: SeededPairing,
  clock: TestClock,
  op: ControlOp,
  overrides: Partial<ControlCommand> = {},
): ControlCommand {
  return {
    op,
    pairingId: pairing.pairingId,
    principalId: pairing.principalId,
    endpointId: pairing.endpointId,
    routeId: pairing.routeId,
    keyVersion: pairing.keyVersion,
    conversationId: `conv-${pairing.pairingId.slice(-4)}`,
    generation: 1,
    messageId: messageIds(),
    receivedAt: clock.now(),
    ...overrides,
  };
}

function startedTurnId(result: SubmitResult): string {
  if (result.status === 'rejected') throw new Error(`expected a turn, got rejected: ${result.code}`);
  return result.turnId;
}

// ---------------------------------------------------------------------------
// 正常一轮
// ---------------------------------------------------------------------------

describe('M4 · Orchestrator 正常一轮', () => {
  it('首轮：cwd 来自 endpoint 策略、binding 为 null、progress/final 映射成出站 kind 并持久 outbox', async () => {
    const f = await setup();
    f.agent.gate();

    const job = jobFor(f.alice, f.clock);
    const submitted = await f.orchestrator.submitTurn(job);
    expect(submitted.status).toBe('started');
    const turnId = startedTurnId(submitted);

    const turn = await f.agent.waitForTurn(0);
    expect(turn.request.conversationId).toBe(job.conversationId);
    expect(turn.request.text).toBe('ping');
    expect(turn.request.cwd).toBe('/home/waku/ws/admin-home');
    expect(turn.request.binding).toBeNull();
    expect(f.workspaces).toEqual(['admin-home']);

    // turn 行落库为 running
    expect(f.store.getTurn(turnId)?.status).toBe('running');
    expect(f.store.getTurn(turnId)?.pairingId).toBe(f.alice.pairingId);
    expect(f.store.getTurn(turnId)?.messageId).toBe(job.messageId);

    turn.emit({ type: 'started', providerSessionId: 'thread_abc' });
    turn.emit({ type: 'progress', text: 'running tests' });
    f.clock.advance(6_300);
    turn.emit({ type: 'final', text: '搞定了' });
    turn.end();
    await tick(6);

    // provider binding 已写回
    expect(f.conversations.binding(job.conversationId)?.providerSessionId).toBe('thread_abc');

    const kinds = f.channel.sent.map((envelope) => envelope.kind);
    expect(kinds).toContain('progress');
    expect(kinds).toContain('final');

    const progress = f.channel.payloads('progress')[0];
    expect(keysOf(progress as unknown as Record<string, unknown>)).toEqual([
      'conversationId',
      'replyTo',
      'stage',
      'text',
      'type',
    ]);
    if (progress.type === 'progress') {
      expect(progress.replyTo).toBe(job.messageId);
      expect(progress.stage).toBe('running');
      expect(progress.conversationId).toBe(job.conversationId);
    }

    const final = f.channel.payloads('final')[0];
    expect(keysOf(final as unknown as Record<string, unknown>)).toEqual([
      'conversationId',
      'replyTo',
      'text',
      'type',
    ]);
    if (final.type === 'final') {
      expect(final.text).toBe('搞定了');
      expect(final.replyTo).toBe(job.messageId);
    }

    // 出站落了真 outbox 行
    for (const envelope of f.channel.sent) {
      const row = f.store.getOutbox(envelope.messageId);
      expect(row).not.toBeNull();
      expect(row?.pairingId).toBe(f.alice.pairingId);
    }

    expect(f.store.getTurn(turnId)?.status).toBe('completed');
  });

  it('Agent error 事件映射成 kind=error，字段清单按协议，且 turn 收尾不留 running', async () => {
    const f = await setup();
    f.agent.autoReply = () => [
      { type: 'started' },
      { type: 'error', code: 'codex_quota_exhausted', message: 'out of quota', retryable: false },
    ];

    const job = jobFor(f.alice, f.clock);
    const turnId = startedTurnId(await f.orchestrator.submitTurn(job));
    await tick(6);

    const errors = f.channel.payloads('error');
    expect(errors).toHaveLength(1);
    const payload = errors[0];
    expect(payload.type).toBe('error');
    if (payload.type !== 'error') return;
    expect(payload.code).toBe('codex_quota_exhausted');
    expect(payload.replyTo).toBe(job.messageId);
    expect(payload.conversationId).toBe(job.conversationId);
    expect(keysOf(payload as unknown as Record<string, unknown>).includes('type')).toBe(true);

    expect(f.store.getTurn(turnId)?.status).not.toBe('running');
    expect(f.channel.payloads('final')).toHaveLength(0);
  });

  it('续聊：已有 provider binding 会原样交给 v6 Agent（binding 决定 create 还是 resume）', async () => {
    const f = await setup();
    const job = jobFor(f.alice, f.clock);

    await f.orchestrator.submitTurn(job);
    await tick(6);
    expect(f.conversations.binding(job.conversationId)?.providerSessionId).toBe(
      `thread_${job.conversationId}`,
    );

    await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { conversationId: job.conversationId, text: '接着聊' }));
    await tick(6);

    expect(f.agent.turns).toHaveLength(2);
    expect(f.agent.turns[1].request.binding?.providerSessionId).toBe(`thread_${job.conversationId}`);
    expect(f.agent.turns[1].request.text).toBe('接着聊');
  });

  it('出站信封带的是本 pairing 的 routeId 与 keyVersion（封装交给 Core 的 opener，见 ingress 用例）', async () => {
    const f = await setup();
    const job = jobFor(f.alice, f.clock, { text: 'hello' });
    await f.orchestrator.submitTurn(job);
    await tick(6);

    const finals = f.channel.ofKind('final');
    expect(finals).toHaveLength(1);
    expect(finals[0].routeId).toBe(f.alice.routeId);
    expect(finals[0].keyVersion).toBe(f.alice.keyVersion);
    // 绝不会串到别人的路由上
    expect(f.channel.sent.every((envelope) => envelope.routeId !== f.bob.routeId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 队列与并发
// ---------------------------------------------------------------------------

describe('M4 · Orchestrator 队列与并发', () => {
  it('同 pairing 并发恒为 1：第二条排队，不并行；前一条收尾后才轮到它', async () => {
    const f = await setup();
    f.agent.gate();

    const first = await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'one' }));
    expect(first.status).toBe('started');
    const running = await f.agent.waitForTurn(0);

    const second = await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'two' }));
    expect(second.status).toBe('queued');
    await tick(4);
    expect(f.agent.turns).toHaveLength(1);

    running.emit({ type: 'final', text: 'done one' });
    running.end();
    await tick(6);

    expect(f.agent.turns).toHaveLength(2);
    expect(f.agent.turns[1].request.text).toBe('two');
  });

  it('不同 pairing 各跑各的，互不排队', async () => {
    const f = await setup();
    f.agent.gate();

    expect((await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'a' }))).status).toBe('started');
    expect((await f.orchestrator.submitTurn(jobFor(f.bob, f.clock, { text: 'b' }))).status).toBe('started');

    await tick(4);
    expect(f.agent.turns).toHaveLength(2);
    expect(f.agent.turns.map((t) => t.request.text).sort()).toEqual(['a', 'b']);
  });

  it('单会话队列上限：超出回 queue_full，并给玩家一条 error（不静默吞）', async () => {
    const f = await setup({ queueCap: 2 });
    f.agent.gate();

    await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'running' }));
    await f.agent.waitForTurn(0);
    expect((await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'q1' }))).status).toBe('queued');
    expect((await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'q2' }))).status).toBe('queued');

    const overflow = await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'q3' }));
    expect(overflow.status).toBe('rejected');
    if (overflow.status === 'rejected') expect(overflow.code).toBe('queue_full');

    await tick(4);
    const errors = f.channel.payloads('error');
    expect(errors).toHaveLength(1);
    if (errors[0].type === 'error') expect(errors[0].code).toBe('queue_full');
    expect(f.agent.turns).toHaveLength(1);
  });

  it('endpoint 在派活时已被 disable：拒绝且绝不调 Agent', async () => {
    const f = await setup();
    seedEndpoint(f.store, { id: 'aster-admin', status: 'disabled' });

    const result = await f.orchestrator.submitTurn(jobFor(f.alice, f.clock));
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('endpoint_disabled');
    expect(f.agent.turns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stop / new / resume
// ---------------------------------------------------------------------------

describe('M4 · Orchestrator stop', () => {
  it('stop 抢占：当前 turn 还卡在闸门时也能立刻返回并 abort 它，turn 标 interrupted', async () => {
    const f = await setup();
    f.agent.gate();

    const turnId = startedTurnId(await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'long job' })));
    const running = await f.agent.waitForTurn(0);
    expect(running.signal.aborted).toBe(false);

    // 若实现把 stop 排进普通队列，这个 await 会永远等下去 —— 超时即失败，这就是断言
    const stopped = await f.orchestrator.control(controlFor(f.alice, f.clock, 'stop'));
    expect(stopped.status).toBe('ok');
    expect(running.signal.aborted).toBe(true);

    await tick(6);
    expect(f.store.getTurn(turnId)?.status).toBe('interrupted');
    expect(f.channel.payloads('final')).toHaveLength(0);
  });

  it('重复 stop 幂等；没有在跑的 turn 时 stop 也不报错', async () => {
    const f = await setup();
    f.agent.gate();

    await f.orchestrator.submitTurn(jobFor(f.alice, f.clock));
    await f.agent.waitForTurn(0);

    expect((await f.orchestrator.control(controlFor(f.alice, f.clock, 'stop'))).status).toBe('ok');
    await tick(4);
    expect((await f.orchestrator.control(controlFor(f.alice, f.clock, 'stop'))).status).toBe('noop');
    expect((await f.orchestrator.control(controlFor(f.alice, f.clock, 'stop'))).status).toBe('noop');
  });

  it('stop 只 abort 自己那条：不碰别的 pairing 正在跑的 turn', async () => {
    const f = await setup();
    f.agent.gate();

    await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'alice job' }));
    await f.orchestrator.submitTurn(jobFor(f.bob, f.clock, { text: 'bob job' }));
    const aliceTurn = await f.agent.waitForTurn(0);
    const bobTurn = await f.agent.waitForTurn(1);

    await f.orchestrator.control(controlFor(f.alice, f.clock, 'stop'));
    await tick(4);

    expect(aliceTurn.signal.aborted).toBe(true);
    expect(bobTurn.signal.aborted).toBe(false);
  });

  it('别的 pairing 不能 stop 我的会话（编排层也要独立判一次，不只靠 ingress）', async () => {
    const f = await setup();
    f.agent.gate();
    const job = jobFor(f.alice, f.clock);
    await f.orchestrator.submitTurn(job);
    const running = await f.agent.waitForTurn(0);

    const result = await f.orchestrator.control(
      controlFor(f.bob, f.clock, 'stop', { conversationId: job.conversationId }),
    );
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('conversation_forbidden');
    expect(running.signal.aborted).toBe(false);
  });
});

describe('M4 · Orchestrator new / resume', () => {
  it('new：abort 当前 turn、清空队列、断旧 binding、回 ack(completed) 且带新代数', async () => {
    const f = await setup();
    f.agent.gate();

    const job = jobFor(f.alice, f.clock, { text: 'old work' });
    await f.orchestrator.submitTurn(job);
    const running = await f.agent.waitForTurn(0);
    running.emit({ type: 'started', providerSessionId: 'thread_old' });
    await tick(4);
    expect(f.conversations.binding(job.conversationId)?.providerSessionId).toBe('thread_old');

    await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'queued work' }));
    await tick(2);
    expect(f.agent.turns).toHaveLength(1);

    const result = await f.orchestrator.control(
      controlFor(f.alice, f.clock, 'new', {
        conversationId: 'conv-fresh',
        generation: 2,
        previousConversationId: job.conversationId,
      }),
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.generation).toBe(2);
      expect(result.cleared).toBe(1);
    }
    expect(running.signal.aborted).toBe(true);
    // 旧会话的 provider 绑定被断开
    expect(f.conversations.binding(job.conversationId)).toBeNull();

    await tick(6);
    // 排队中的那条被清掉了，绝不会在 new 之后又跑起来
    expect(f.agent.turns).toHaveLength(1);

    const acks = f.channel.payloads('ack');
    expect(acks).toHaveLength(1);
    if (acks[0].type === 'ack') expect(acks[0].status).toBe('completed');
  });

  it('new 之后旧代的 turn 变 stale，接不回旧上下文', async () => {
    const f = await setup();
    const job = jobFor(f.alice, f.clock);
    await f.orchestrator.submitTurn(job);
    await tick(6);

    await f.orchestrator.control(
      controlFor(f.alice, f.clock, 'new', {
        conversationId: 'conv-fresh',
        generation: 2,
        previousConversationId: job.conversationId,
      }),
    );

    const stale = await f.orchestrator.submitTurn(
      jobFor(f.alice, f.clock, { conversationId: job.conversationId, generation: 1, text: '旧代' }),
    );
    expect(stale.status).toBe('rejected');
    if (stale.status === 'rejected') expect(stale.code).toBe('stale_generation');
  });

  it('快速连续 new / stop：同一代只留一个有效 binding', async () => {
    const f = await setup();
    const job = jobFor(f.alice, f.clock);
    await f.orchestrator.submitTurn(job);
    await tick(6);

    await f.orchestrator.control(
      controlFor(f.alice, f.clock, 'new', {
        conversationId: 'conv-g2',
        generation: 2,
        previousConversationId: job.conversationId,
      }),
    );
    await f.orchestrator.control(controlFor(f.alice, f.clock, 'stop', { conversationId: 'conv-g2', generation: 2 }));
    await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { conversationId: 'conv-g2', generation: 2, text: 'g2' }));
    await tick(6);

    expect(f.conversations.binding(job.conversationId)).toBeNull();
    expect(f.conversations.binding('conv-g2')?.generation).toBe(2);
    expect(f.conversations.binding('conv-g2')?.providerSessionId).toBe('thread_conv-g2');
  });

  it('resume：本人放行，别人 conversation_forbidden 且不碰 Agent', async () => {
    const f = await setup();
    const job = jobFor(f.alice, f.clock);
    await f.orchestrator.submitTurn(job);
    await tick(6);
    const before = f.agent.turns.length;

    const mine = await f.orchestrator.control(
      controlFor(f.alice, f.clock, 'resume', { conversationId: job.conversationId }),
    );
    expect(mine.status).toBe('ok');

    const theirs = await f.orchestrator.control(
      controlFor(f.bob, f.clock, 'resume', { conversationId: job.conversationId }),
    );
    expect(theirs.status).toBe('rejected');
    if (theirs.status === 'rejected') expect(theirs.code).toBe('conversation_forbidden');
    expect(f.agent.turns).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// drain 与崩溃恢复
// ---------------------------------------------------------------------------

describe('M4 · Orchestrator drain 与恢复', () => {
  it('drain 等当前 turn 收尾；期间的新消息不静默丢，会拿到 draining 的明确回复', async () => {
    const f = await setup();
    f.agent.gate();

    await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'in flight' }));
    const running = await f.agent.waitForTurn(0);

    let drained = false;
    const draining = f.orchestrator.drain().then(() => {
      drained = true;
    });
    await tick(4);
    expect(drained).toBe(false);

    const late = await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: 'too late' }));
    expect(late.status).toBe('rejected');
    if (late.status === 'rejected') expect(late.code).toBe('draining');
    await tick(4);
    const errors = f.channel.payloads('error');
    expect(errors).toHaveLength(1);
    if (errors[0].type === 'error') expect(errors[0].code).toBe('draining');
    expect(f.agent.turns).toHaveLength(1);

    running.emit({ type: 'final', text: 'finished before shutdown' });
    running.end();
    await draining;
    expect(drained).toBe(true);
    expect(f.channel.payloads('final')).toHaveLength(1);
  });

  it('崩溃重启：running 的 turn 标 interrupted、不自动重跑，recover 幂等', async () => {
    const f = await setup();
    f.agent.gate();
    const turnId = startedTurnId(await f.orchestrator.submitTurn(jobFor(f.alice, f.clock, { text: '可能改过代码' })));
    await f.agent.waitForTurn(0);
    expect(f.store.getTurn(turnId)?.status).toBe('running');

    // 模拟 kill -9：不 drain，直接关库重开
    const reopened = handle?.reopen();
    expect(reopened).toBeDefined();
    if (reopened === undefined) return;

    const freshAgent = new FakeAgent();
    const freshRunner = createLocalRunnerAdapter({
      runnerId: 'local-729a',
      nodeId: '729a',
      agent: freshAgent,
      resolveWorkspace: (policyId) => `/home/waku/ws/${policyId}`,
      getBinding: () => null,
    });
    const freshChannel = new FakeChannel();
    const mod = await loadOrchestrator();
    const deliveryMod = await loadDelivery();
    const revived = mod.createGatewayOrchestrator({
      store: reopened,
      registry: new StoreRegistry(reopened, freshRunner, ['aster-admin']),
      conversations: new MemoryConversations(),
      delivery: deliveryMod.createCoreDelivery({
        store: reopened,
        channel: freshChannel,
        now: f.clock.now,
        newMessageId: makeUuidV7('0198eeee'),
      }),
      now: f.clock.now,
      newTurnId: makeUuidV7('0198ffff'),
    });

    const first = revived.recover();
    expect(first.interrupted).toBe(1);
    expect(reopened.getTurn(turnId)?.status).toBe('interrupted');
    await tick(4);
    // 绝不自动重跑
    expect(freshAgent.turns).toHaveLength(0);

    // 幂等：再 recover 一次不该又"发现"一条
    expect(revived.recover().interrupted).toBe(0);
    expect(freshAgent.turns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 健康面
// ---------------------------------------------------------------------------

describe('M4 · Orchestrator 健康聚合', () => {
  it('health 含 endpoint / queue / lastTurn，且不泄露 token、secret、完整 routeId 或用户正文', async () => {
    const f = await setup();
    f.agent.gate();

    const job = jobFor(f.alice, f.clock, { text: '这句用户正文绝不能出现在 health 里' });
    await f.orchestrator.submitTurn(job);
    const running = await f.agent.waitForTurn(0);

    const midFlight = await f.orchestrator.health();
    expect(midFlight.core.ok).toBe(true);
    expect(midFlight.runner.nodeId).toBe('729a');
    expect(midFlight.queues.running).toBe(1);
    expect(midFlight.queues.queued).toBe(0);
    expect(midFlight.endpoints.map((e) => e.id)).toEqual(['aster-admin']);
    expect(midFlight.endpoints[0].ok).toBe(true);

    f.clock.advance(6_300);
    running.emit({ type: 'final', text: '搞定' });
    running.end();
    await tick(6);

    const settled = await f.orchestrator.health();
    expect(settled.queues.running).toBe(0);
    expect(settled.lastTurn?.outcome).toBe('final');
    expect(settled.lastTurn?.totalMs).toBe(6_300);

    assertNoSecrets(settled, [
      {
        token: f.alice.token,
        channelSecret: f.alice.channelSecret,
        routeId: f.alice.routeId,
        text: job.text,
      },
    ]);
  });

  it('endpoint 被 disable 后 health 如实报 ok=false，但 core 本身仍是 ok（区分组件故障与整机故障）', async () => {
    const f = await setup();
    seedEndpoint(f.store, { id: 'aster-admin', status: 'disabled' });

    const health = await f.orchestrator.health();
    expect(health.core.ok).toBe(true);
    expect(health.endpoints[0].ok).toBe(false);
    expect(health.endpoints[0].status).toBe('disabled');
    expect(health.lastTurn).toBeNull();
  });
});
