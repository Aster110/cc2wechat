/**
 * M4 · CoreIngress（RED）
 *
 * 架构 §9 核心顺序的入站半边 + 任务书 §1.2 安全金线 / §1.3 可靠性金线。
 *
 * 分工（与 M2 的 `WakuMailboxAdapter` 契约对齐）：
 * adapter 负责轮询/翻页/组片/游标，**不做密码学**；它拿 Core 给的 `opener` 解密与封装，
 * 再把解出来的 `InboundEnvelope` 交给 Core 给的 `sink`。所以 CoreIngress 有两个面：
 *
 * - `opener.open/seal`：routeId → pairing → 长期方向密钥。失败必须带 `permanent` 分类：
 *   AEAD 认证失败/未知路由/解出来不是合法 payload = 伪造行，**permanent（adapter 可永久标 seen）**；
 *   keyVersion 不匹配 = 未来 re-key 的合法行，**非 permanent**，不许被钉死。
 * - `sink`：身份 → scope → endpoint → 会话归属 → 幂等 → 入队，顺序照架构 §9：
 *   「验 pairing + 插 InboxReceipt(received)」→ accepted/duplicate →「授权、限流、入队」。
 *   于是**验不过 pairing 的消息不留 receipt**（它根本不属于任何人），
 *   而**授权失败的消息留 status=rejected 的 receipt** —— 重放它只会拿到 duplicate，
 *   永远不会变成一次 Agent 调用。
 */
import { describe, it, expect, afterEach } from 'vitest';

import type { GatewayStore } from '../../gateway/state/sqlite-store.js';
import type { AgentEndpoint, RunnerAdapter } from '../../gateway/contracts/runner.js';
import type { SessionBinding } from '../../v6/contracts.js';

import {
  TestClock,
  captureAsync,
  keysOf,
  lazyModule,
  makePairingService,
  makeUuidV7,
  openTestStore,
  playerBootstrapKey,
  playerOpen,
  playerPairRouteId,
  playerSeal,
  randomNonce,
  randomToken,
  seedEndpoint,
  seedPairing,
  type ControlOp,
  type DeliveryReceipt,
  type InboundEnvelope,
  type IngressAck,
  type MailboxChunk,
  type MailboxKind,
  type MailboxOpener,
  type OpenInput,
  type SealInput,
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
};

type SubmitResult =
  | { status: 'started' }
  | { status: 'queued'; depth: number }
  | { status: 'rejected'; code: string };

type ControlResult =
  | { status: 'ok'; cleared?: number; generation?: number }
  | { status: 'noop' }
  | { status: 'rejected'; code: string };

type TurnDispatcher = {
  submitTurn(job: TurnJob): Promise<SubmitResult>;
  control(command: ControlCommand): Promise<ControlResult>;
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
type AgentEndpointRegistryApi = { resolve(endpointId: string): EndpointResolution };

type IngressDelivery = {
  publish(input: {
    pairingId: string;
    routeId: string;
    keyVersion: number;
    kind: MailboxKind;
    payload: SecurePayload;
  }): Promise<{ messageId: string; receipt: DeliveryReceipt }>;
  acknowledge(input: {
    pairingId: string;
    ackMessageId: string;
    status: 'received' | 'completed' | 'displayed';
  }): 'acknowledged' | 'unknown';
};

type PairingFlowSeam = {
  routes(): string[];
  openPairChunks(input: OpenInput): Promise<SecurePayload>;
  sealPairChunks(input: SealInput): Promise<MailboxChunk[]>;
  handle(envelope: InboundEnvelope): Promise<IngressAck>;
};

type CoreIngressApi = {
  readonly opener: MailboxOpener;
  sink(envelope: InboundEnvelope): Promise<IngressAck>;
};

type CoreIngressOptions = {
  store: GatewayStore;
  /** routeId → pairingId 的索引（bootstrap 注入；status/scopes/secret 一律由 ingress 现查 store）。 */
  resolveRoute(routeId: string): { pairingId: string } | null;
  conversations: ConversationServiceApi;
  registry: AgentEndpointRegistryApi;
  dispatcher: TurnDispatcher;
  delivery: IngressDelivery;
  pairing: PairingFlowSeam;
  now(): number;
  /** 服务端可信的 admin 名单：admin-bypass endpoint 只认它，不认任何客户端自报字段。 */
  isAdminPrincipal(principalId: string): boolean;
};

type CoreIngressModule = {
  createCoreIngress(options: CoreIngressOptions): CoreIngressApi;
};

const loadIngress = lazyModule<CoreIngressModule>('../../gateway/core/ingress.js');

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

class RecordingDispatcher implements TurnDispatcher {
  readonly turns: TurnJob[] = [];
  readonly controls: ControlCommand[] = [];
  submitResult: SubmitResult = { status: 'started' };
  controlResult: ControlResult = { status: 'ok' };

  async submitTurn(job: TurnJob): Promise<SubmitResult> {
    this.turns.push(job);
    return this.submitResult;
  }

  async control(command: ControlCommand): Promise<ControlResult> {
    this.controls.push(command);
    return this.controlResult;
  }
}

/** 会话归属的最小忠实实现：只记 owner 与 generation，够 ingress 的判定用。 */
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
      return { allowed: false, code: 'conversation_forbidden', message: 'not your conversation' };
    }
    if (input.generation < existing.generation) {
      return { allowed: false, code: 'stale_generation', message: 'stale generation' };
    }
    const changed = input.generation > existing.generation;
    existing.generation = input.generation;
    return { allowed: true, conversation: existing, created: false, generationChanged: changed };
  }

  startNew(input: ConversationRef & { previousConversationId?: string }): ConversationDecision {
    if (this.rows.has(input.conversationId)) {
      return { allowed: false, code: 'conversation_exists', message: 'already exists' };
    }
    return this.open(input);
  }

  authorize(input: Omit<ConversationRef, 'generation'>): ConversationDecision {
    const existing = this.rows.get(input.conversationId);
    if (existing === undefined) {
      return { allowed: false, code: 'conversation_not_found', message: 'not found' };
    }
    if (existing.pairingId !== input.pairingId || existing.principalId !== input.principalId) {
      return { allowed: false, code: 'conversation_forbidden', message: 'not your conversation' };
    }
    return { allowed: true, conversation: existing, created: false, generationChanged: false };
  }

  bindProvider(input: {
    conversationId: string;
    generation: number;
    agentType: string;
    providerSessionId: string;
  }): void {
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
  ) {}

  resolve(endpointId: string): EndpointResolution {
    const endpoint = this.store.getEndpoint(endpointId);
    if (endpoint === null) throw named('endpoint_not_found');
    if (endpoint.status !== 'active') throw named('endpoint_disabled');
    return { endpoint, runner: this.runner };
  }
}

function named(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

class RecordingDelivery implements IngressDelivery {
  readonly published: Array<{
    pairingId: string;
    routeId: string;
    keyVersion: number;
    kind: MailboxKind;
    payload: SecurePayload;
  }> = [];
  readonly acks: Array<{ pairingId: string; ackMessageId: string; status: string }> = [];
  private readonly nextId = makeUuidV7('0198bbbb');

  async publish(input: {
    pairingId: string;
    routeId: string;
    keyVersion: number;
    kind: MailboxKind;
    payload: SecurePayload;
  }): Promise<{ messageId: string; receipt: DeliveryReceipt }> {
    this.published.push(input);
    return { messageId: this.nextId(), receipt: { status: 'sent' } };
  }

  acknowledge(input: {
    pairingId: string;
    ackMessageId: string;
    status: 'received' | 'completed' | 'displayed';
  }): 'acknowledged' | 'unknown' {
    this.acks.push(input);
    return 'acknowledged';
  }
}

class RecordingPairingFlow implements PairingFlowSeam {
  readonly handled: InboundEnvelope[] = [];
  readonly opened: OpenInput[] = [];
  pairRoutes: string[] = [];
  payload: SecurePayload = { type: 'pair_request', clientNonce: randomNonce(), clientTimeMs: 0 };

  routes(): string[] {
    return this.pairRoutes;
  }

  async openPairChunks(input: OpenInput): Promise<SecurePayload> {
    this.opened.push(input);
    return this.payload;
  }

  async sealPairChunks(): Promise<MailboxChunk[]> {
    return [];
  }

  async handle(envelope: InboundEnvelope): Promise<IngressAck> {
    this.handled.push(envelope);
    return { status: 'accepted' };
  }
}

const stubRunner: RunnerAdapter = {
  descriptor: { runnerId: 'local-729a', nodeId: '729a', kind: 'local', capabilities: [] },
  run: () => {
    throw new Error('ingress must never call the runner directly');
  },
  reset: async () => undefined,
  health: async () => ({ ok: true }),
  shutdown: async () => undefined,
};

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
  ingress: CoreIngressApi;
  dispatcher: RecordingDispatcher;
  conversations: MemoryConversations;
  delivery: RecordingDelivery;
  pairing: RecordingPairingFlow;
  alice: SeededPairing;
  bob: SeededPairing;
  admins: Set<string>;
  routes: Map<string, string>;
  newMessageId: () => string;
}

async function setup(
  options: { aliceScopes?: SeededPairing['scopes']; endpointStatus?: 'active' | 'disabled' } = {},
): Promise<Fixture> {
  handle = openTestStore();
  const store = handle.store;
  const clock = new TestClock();
  seedEndpoint(store, { id: 'aster-admin', trustTier: 'admin-bypass' });
  seedEndpoint(store, { id: 'guest-chat', trustTier: 'chat-only' });

  const alice = await seedPairing(store, clock, {
    endpointId: 'aster-admin',
    scopes: options.aliceScopes,
  });
  const bob = await seedPairing(store, clock, { endpointId: 'aster-admin' });
  if (options.endpointStatus === 'disabled') {
    seedEndpoint(store, { id: 'aster-admin', status: 'disabled' });
  }

  const routes = new Map<string, string>([
    [alice.routeId, alice.pairingId],
    [bob.routeId, bob.pairingId],
  ]);
  const admins = new Set<string>([alice.principalId, bob.principalId]);

  const dispatcher = new RecordingDispatcher();
  const conversations = new MemoryConversations();
  const delivery = new RecordingDelivery();
  const pairing = new RecordingPairingFlow();

  const mod = await loadIngress();
  const ingress = mod.createCoreIngress({
    store,
    resolveRoute: (routeId) => {
      const pairingId = routes.get(routeId);
      return pairingId === undefined ? null : { pairingId };
    },
    conversations,
    registry: new StoreRegistry(store, stubRunner),
    dispatcher,
    delivery,
    pairing,
    now: clock.now,
    isAdminPrincipal: (principalId) => admins.has(principalId),
  });

  return {
    store,
    clock,
    ingress,
    dispatcher,
    conversations,
    delivery,
    pairing,
    alice,
    bob,
    admins,
    routes,
    newMessageId: makeUuidV7(),
  };
}

function turnPayload(text: string, generation = 1, conversationId = 'conv-1'): SecurePayload {
  return { type: 'turn', conversationId, generation, clientSeq: 0, text };
}

function sealInbound(
  pairing: SeededPairing,
  messageId: string,
  now: number,
  kind: MailboxKind,
  payload: unknown,
  key?: Uint8Array,
): MailboxChunk[] {
  return playerSeal({
    key: key ?? pairing.toAgentKey,
    routeId: pairing.routeId,
    messageId,
    direction: 'to_agent',
    kind,
    keyVersion: pairing.keyVersion,
    createdAt: now,
    expiresAt: now + 300_000,
    payload,
  });
}

function openInputOf(chunks: MailboxChunk[], keyVersion?: number): OpenInput {
  const head = chunks[0];
  return {
    routeId: head.routeId,
    messageId: head.messageId,
    kind: head.kind,
    keyVersion: keyVersion ?? head.keyVersion,
    direction: 'to_agent',
    createdAt: head.createdAt,
    expiresAt: head.expiresAt,
    chunks,
  };
}

function envelopeOf(
  pairing: SeededPairing,
  messageId: string,
  kind: MailboxKind,
  payload: SecurePayload,
  now: number,
): InboundEnvelope {
  return {
    channel: 'waku',
    routeId: pairing.routeId,
    messageId,
    kind,
    keyVersion: pairing.keyVersion,
    createdAt: now,
    expiresAt: now + 300_000,
    receivedAt: now,
    payload,
  };
}

function rejectedCode(ack: IngressAck): string {
  if (ack.status !== 'rejected') throw new Error(`expected rejected, got ${ack.status}`);
  return ack.code;
}

// ---------------------------------------------------------------------------
// opener.open
// ---------------------------------------------------------------------------

describe('M4 · CoreIngress opener 解密', () => {
  it('Playable 封的 turn 能原样解出（含 generation / clientSeq）', async () => {
    const f = await setup();
    const chunks = sealInbound(
      f.alice,
      f.newMessageId(),
      f.clock.now(),
      'turn',
      turnPayload('跑一下测试', 2),
    );

    const payload = await f.ingress.opener.open(openInputOf(chunks));
    expect(payload.type).toBe('turn');
    if (payload.type !== 'turn') return;
    expect(payload.conversationId).toBe('conv-1');
    expect(payload.text).toBe('跑一下测试');
    expect(payload.clientSeq).toBe(0);
    expect(payload.generation).toBe(2);
  });

  it('未知 routeId → unknown_route，permanent（伪造行永久跳过）', async () => {
    const f = await setup();
    const chunks = sealInbound(f.alice, f.newMessageId(), f.clock.now(), 'turn', turnPayload('hi'));
    const input = { ...openInputOf(chunks), routeId: 'rt_not_registered' };

    const error = await captureAsync(() => f.ingress.opener.open(input));
    expect(error.code).toBe('unknown_route');
    expect(error.permanent).toBe(true);
  });

  it('已撤销 pairing → pairing_revoked，permanent，且错误里不含 secret/route', async () => {
    const f = await setup();
    const service = makePairingService(f.store, f.clock);
    await service.revokePairing(f.alice.pairingId);

    const chunks = sealInbound(f.alice, f.newMessageId(), f.clock.now(), 'turn', turnPayload('hi'));
    const error = await captureAsync(() => f.ingress.opener.open(openInputOf(chunks)));

    expect(error.code).toBe('pairing_revoked');
    expect(error.permanent).toBe(true);
    expect(error.message).not.toContain(f.alice.routeId);
    expect(error.message).not.toContain(Buffer.from(f.alice.channelSecret).toString('base64url'));
  });

  it('错密钥（另一个 pairing 的钥匙封的包）→ chunk_auth_failed，permanent', async () => {
    const f = await setup();
    const chunks = playerSeal({
      key: f.bob.toAgentKey, // Bob 的钥匙
      routeId: f.alice.routeId, // 却发到 Alice 的路由
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'turn',
      keyVersion: f.alice.keyVersion,
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 300_000,
      payload: turnPayload('偷看'),
    });

    const error = await captureAsync(() => f.ingress.opener.open(openInputOf(chunks)));
    expect(error.code).toBe('chunk_auth_failed');
    expect(error.permanent).toBe(true);
  });

  it('keyVersion 不匹配 → key_version_mismatch，**非** permanent（容未来 re-key）', async () => {
    const f = await setup();
    const chunks = playerSeal({
      key: f.alice.toAgentKey,
      routeId: f.alice.routeId,
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'turn',
      keyVersion: f.alice.keyVersion + 1,
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 300_000,
      payload: turnPayload('未来的钥匙'),
    });

    const error = await captureAsync(() =>
      f.ingress.opener.open(openInputOf(chunks, f.alice.keyVersion + 1)),
    );
    expect(error.code).toBe('key_version_mismatch');
    expect(error.permanent).toBe(false);
  });

  it('方向密钥隔离：用 to_player 钥匙封的包，按 to_agent 读必然认证失败', async () => {
    const f = await setup();
    const chunks = playerSeal({
      key: f.alice.toPlayerKey,
      routeId: f.alice.routeId,
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'turn',
      keyVersion: f.alice.keyVersion,
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 300_000,
      payload: turnPayload('伪装成玩家'),
    });

    const error = await captureAsync(() => f.ingress.opener.open(openInputOf(chunks)));
    expect(error.code).toBe('chunk_auth_failed');
    expect(error.permanent).toBe(true);
  });

  it('解得开但不是合法 SecurePayload（比如 type=shell）→ permanent 拒绝，绝不进 dispatcher', async () => {
    const f = await setup();
    const chunks = sealInbound(f.alice, f.newMessageId(), f.clock.now(), 'turn', {
      type: 'shell',
      cmd: 'rm -rf /',
    });

    const error = await captureAsync(() => f.ingress.opener.open(openInputOf(chunks)));
    expect(error.permanent).toBe(true);
    expect(f.dispatcher.turns).toHaveLength(0);
  });

  it('pr_ 路由交给 PairingFlow，不当成未知路由', async () => {
    const f = await setup();
    const token = randomToken();
    const pairRouteId = playerPairRouteId(token);
    f.pairing.pairRoutes = [pairRouteId];

    const chunks = playerSeal({
      key: playerBootstrapKey({ token, direction: 'to_agent' }),
      routeId: pairRouteId,
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'pair',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      payload: { type: 'pair_request', clientNonce: randomNonce(), clientTimeMs: f.clock.now() },
    });

    const payload = await f.ingress.opener.open(openInputOf(chunks));
    expect(payload.type).toBe('pair_request');
    expect(f.pairing.opened).toHaveLength(1);
    expect(f.pairing.opened[0].routeId).toBe(pairRouteId);
  });
});

// ---------------------------------------------------------------------------
// opener.seal
// ---------------------------------------------------------------------------

describe('M4 · CoreIngress opener 封装', () => {
  it('封 final 用 to_player 长期密钥：Playable 侧独立密钥能解开，字段清单与协议一致', async () => {
    const f = await setup();
    const messageId = f.newMessageId();
    const payload: SecurePayload = {
      type: 'final',
      conversationId: 'conv-1',
      replyTo: f.newMessageId(),
      text: '搞定',
    };

    const chunks = await f.ingress.opener.seal({
      routeId: f.alice.routeId,
      messageId,
      kind: 'final',
      keyVersion: f.alice.keyVersion,
      direction: 'to_player',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 300_000,
      payload,
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].routeId).toBe(f.alice.routeId);
    expect(chunks[0].messageId).toBe(messageId);
    expect(chunks[0].kind).toBe('final');
    expect(chunks[0].direction).toBe('to_player');

    const decoded = playerOpen({ key: f.alice.toPlayerKey, chunks });
    expect(keysOf(decoded)).toEqual(['conversationId', 'replyTo', 'text', 'type']);
    expect(decoded['text']).toBe('搞定');

    // 换成 to_agent 钥匙必须解不开（方向隔离）
    expect(() => playerOpen({ key: f.alice.toAgentKey, chunks })).toThrow();
  });

  it('给未知/已撤销 pairing 封装直接抛，绝不用错钥匙封出一条"能被别人解开"的回复', async () => {
    const f = await setup();
    const base: SealInput = {
      routeId: 'rt_unknown',
      messageId: f.newMessageId(),
      kind: 'final',
      keyVersion: 1,
      direction: 'to_player',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 300_000,
      payload: { type: 'final', conversationId: 'conv-1', replyTo: f.newMessageId(), text: 'x' },
    };
    expect((await captureAsync(() => f.ingress.opener.seal(base))).code).toBe('unknown_route');

    const service = makePairingService(f.store, f.clock);
    await service.revokePairing(f.alice.pairingId);
    const revoked = await captureAsync(() =>
      f.ingress.opener.seal({ ...base, routeId: f.alice.routeId }),
    );
    expect(revoked.code).toBe('pairing_revoked');
  });
});

// ---------------------------------------------------------------------------
// sink：授权 + 幂等 + 入队
// ---------------------------------------------------------------------------

describe('M4 · CoreIngress sink 正常流', () => {
  it('合法 turn → accepted，dispatcher 拿到的 endpointId 来自 pairing 行而不是 payload', async () => {
    const f = await setup();
    const messageId = f.newMessageId();
    const ack = await f.ingress.sink(
      envelopeOf(
        f.alice,
        messageId,
        'turn',
        { type: 'turn', conversationId: 'conv-1', generation: 1, clientSeq: 3, text: '跑测试' },
        f.clock.now(),
      ),
    );

    expect(ack).toEqual({ status: 'accepted' });
    expect(f.dispatcher.turns).toHaveLength(1);
    const job = f.dispatcher.turns[0];
    expect(job.pairingId).toBe(f.alice.pairingId);
    expect(job.principalId).toBe(f.alice.principalId);
    expect(job.endpointId).toBe(f.alice.endpointId);
    expect(job.routeId).toBe(f.alice.routeId);
    expect(job.conversationId).toBe('conv-1');
    expect(job.generation).toBe(1);
    expect(job.messageId).toBe(messageId);
    expect(job.text).toBe('跑测试');
    expect(job.clientSeq).toBe(3);

    // 架构 §9：receipt 与接收同事务落库
    expect(f.store.getReceipt(f.alice.pairingId, messageId)?.status).toBe('received');
  });

  it('接收后立刻回一条 ack(received)，让 Playable 能删自己的 inbox 行', async () => {
    const f = await setup();
    const messageId = f.newMessageId();
    await f.ingress.sink(
      envelopeOf(f.alice, messageId, 'turn', turnPayload('hi'), f.clock.now()),
    );

    const acks = f.delivery.published.filter((entry) => entry.kind === 'ack');
    expect(acks).toHaveLength(1);
    expect(acks[0].pairingId).toBe(f.alice.pairingId);
    expect(acks[0].routeId).toBe(f.alice.routeId);
    expect(acks[0].payload).toEqual({
      type: 'ack',
      ackMessageId: messageId,
      status: 'received',
    });
  });

  it('缺 generation 的 turn（M1 冻结形状）按 generation=1 处理，不报错', async () => {
    const f = await setup();
    const ack = await f.ingress.sink(
      envelopeOf(
        f.alice,
        f.newMessageId(),
        'turn',
        { type: 'turn', conversationId: 'conv-1', clientSeq: 0, text: 'hi' },
        f.clock.now(),
      ),
    );
    expect(ack.status).toBe('accepted');
    expect(f.dispatcher.turns[0].generation).toBe(1);
  });

  it('control stop 走抢占通道：调 dispatcher.control，不调 submitTurn', async () => {
    const f = await setup();
    await f.ingress.sink(
      envelopeOf(f.alice, f.newMessageId(), 'turn', turnPayload('long job'), f.clock.now()),
    );
    f.dispatcher.turns.length = 0;

    const targetTurnId = f.newMessageId();
    const ack = await f.ingress.sink(
      envelopeOf(
        f.alice,
        f.newMessageId(),
        'control',
        { type: 'control', op: 'stop', conversationId: 'conv-1', generation: 1, targetTurnId },
        f.clock.now(),
      ),
    );

    expect(ack.status).toBe('accepted');
    expect(f.dispatcher.turns).toHaveLength(0);
    expect(f.dispatcher.controls).toHaveLength(1);
    expect(f.dispatcher.controls[0].op).toBe('stop');
    expect(f.dispatcher.controls[0].targetTurnId).toBe(targetTurnId);
    expect(f.dispatcher.controls[0].pairingId).toBe(f.alice.pairingId);
  });

  it('玩家 ack(displayed) 转给 delivery 做 outbox 清理，不入队', async () => {
    const f = await setup();
    const target = f.newMessageId();
    const ack = await f.ingress.sink(
      envelopeOf(
        f.alice,
        f.newMessageId(),
        'ack',
        { type: 'ack', ackMessageId: target, status: 'displayed' },
        f.clock.now(),
      ),
    );

    expect(ack.status).toBe('accepted');
    expect(f.delivery.acks).toContainEqual({
      pairingId: f.alice.pairingId,
      ackMessageId: target,
      status: 'displayed',
    });
    expect(f.dispatcher.turns).toHaveLength(0);
    expect(f.dispatcher.controls).toHaveLength(0);
  });

  it('kind=pair 的信封交给 PairingFlow，不走 pairing 查表也不入队', async () => {
    const f = await setup();
    const envelope: InboundEnvelope = {
      channel: 'waku',
      routeId: playerPairRouteId(randomToken()),
      messageId: f.newMessageId(),
      kind: 'pair',
      keyVersion: 1,
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      receivedAt: f.clock.now(),
      payload: { type: 'pair_request', clientNonce: randomNonce(), clientTimeMs: f.clock.now() },
    };

    const ack = await f.ingress.sink(envelope);
    expect(ack.status).toBe('accepted');
    expect(f.pairing.handled).toHaveLength(1);
    expect(f.dispatcher.turns).toHaveLength(0);
  });
});

describe('M4 · CoreIngress 幂等', () => {
  it('同 pairing 的同 messageId 重放：第二次 duplicate，dispatcher 只被叫过一次', async () => {
    const f = await setup();
    const messageId = f.newMessageId();
    const envelope = envelopeOf(
      f.alice,
      messageId,
      'turn',
      turnPayload('只许跑一次'),
      f.clock.now(),
    );

    expect(await f.ingress.sink(envelope)).toEqual({ status: 'accepted' });
    expect(await f.ingress.sink({ ...envelope, receivedAt: f.clock.now() + 5 })).toEqual({
      status: 'duplicate',
    });
    expect(await f.ingress.sink({ ...envelope, receivedAt: f.clock.now() + 9 })).toEqual({
      status: 'duplicate',
    });

    expect(f.dispatcher.turns).toHaveLength(1);
  });

  it('两个 pairing 用同一个 messageId 互不冲突（receipt 主键是 pairing+message）', async () => {
    const f = await setup();
    const shared = f.newMessageId();

    expect(
      await f.ingress.sink(
        envelopeOf(f.alice, shared, 'turn', turnPayload('a', 1, 'conv-a'), f.clock.now()),
      ),
    ).toEqual({ status: 'accepted' });
    expect(
      await f.ingress.sink(
        envelopeOf(f.bob, shared, 'turn', turnPayload('b', 1, 'conv-b'), f.clock.now()),
      ),
    ).toEqual({ status: 'accepted' });

    expect(f.dispatcher.turns).toHaveLength(2);
    expect(f.store.getReceipt(f.alice.pairingId, shared)).not.toBeNull();
    expect(f.store.getReceipt(f.bob.pairingId, shared)).not.toBeNull();
  });

  it('dispatcher 回 rejected（队列满）时 sink 也 rejected，且 receipt 落成 rejected —— 重放不会变成一次 run', async () => {
    const f = await setup();
    f.dispatcher.submitResult = { status: 'rejected', code: 'queue_full' };
    const messageId = f.newMessageId();
    const envelope = envelopeOf(
      f.alice,
      messageId,
      'turn',
      turnPayload('挤爆队列'),
      f.clock.now(),
    );

    expect(rejectedCode(await f.ingress.sink(envelope))).toBe('queue_full');
    expect(f.store.getReceipt(f.alice.pairingId, messageId)?.status).toBe('rejected');

    f.dispatcher.submitResult = { status: 'started' };
    expect(await f.ingress.sink(envelope)).toEqual({ status: 'duplicate' });
    expect(f.dispatcher.turns).toHaveLength(1);
  });
});

describe('M4 · CoreIngress 安全拒绝矩阵', () => {
  it('已撤销 pairing：rejected、不入队、不留 receipt，且回执不泄密', async () => {
    const f = await setup();
    const service = makePairingService(f.store, f.clock);
    await service.revokePairing(f.alice.pairingId);

    const messageId = f.newMessageId();
    const ack = await f.ingress.sink(
      envelopeOf(f.alice, messageId, 'turn', turnPayload('还想跑'), f.clock.now()),
    );

    expect(rejectedCode(ack)).toBe('pairing_revoked');
    expect(f.dispatcher.turns).toHaveLength(0);
    // 连不属于任何有效 pairing 的消息都不该占一条 receipt
    expect(f.store.getReceipt(f.alice.pairingId, messageId)).toBeNull();
    expect(JSON.stringify(ack)).not.toContain(f.alice.routeId);
    expect(JSON.stringify(ack)).not.toContain('还想跑');
  });

  it('未知路由的垃圾行：rejected unknown_route，不入队', async () => {
    const f = await setup();
    const ack = await f.ingress.sink({
      channel: 'waku',
      routeId: 'rt_garbage_from_a_stranger',
      messageId: f.newMessageId(),
      kind: 'turn',
      keyVersion: 1,
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 300_000,
      receivedAt: f.clock.now(),
      payload: { type: 'turn', conversationId: 'conv-1', generation: 1, clientSeq: 0, text: 'hi' },
    });
    expect(rejectedCode(ack)).toBe('unknown_route');
    expect(f.dispatcher.turns).toHaveLength(0);
  });

  it('scope 缺失：chat.send / conversation.{stop,new,resume} 各自对应各自的拒绝', async () => {
    const f = await setup({ aliceScopes: ['artifact.read'] });

    const turnAck = await f.ingress.sink(
      envelopeOf(f.alice, f.newMessageId(), 'turn', turnPayload('没权限'), f.clock.now()),
    );
    expect(rejectedCode(turnAck)).toBe('scope_denied');

    for (const op of ['stop', 'new', 'resume'] as const) {
      const ack = await f.ingress.sink(
        envelopeOf(
          f.alice,
          f.newMessageId(),
          'control',
          { type: 'control', op, conversationId: 'conv-1', generation: 2 },
          f.clock.now(),
        ),
      );
      expect(rejectedCode(ack)).toBe('scope_denied');
    }

    expect(f.dispatcher.turns).toHaveLength(0);
    expect(f.dispatcher.controls).toHaveLength(0);
  });

  it('非 admin principal 路由到 admin-bypass endpoint：拒绝，绝不入队', async () => {
    const f = await setup();
    f.admins.delete(f.alice.principalId); // Alice 不在服务端可信 admin 名单里

    const ack = await f.ingress.sink(
      envelopeOf(f.alice, f.newMessageId(), 'turn', turnPayload('偷用 aster 的权限'), f.clock.now()),
    );

    expect(rejectedCode(ack)).toBe('admin_endpoint_denied');
    expect(f.dispatcher.turns).toHaveLength(0);
    // Bob 仍在名单里，同一个 endpoint 照常可用 —— 证明拒的是 principal，不是 endpoint 挂了
    expect(
      (
        await f.ingress.sink(
          envelopeOf(f.bob, f.newMessageId(), 'turn', turnPayload('我是 aster', 1, 'conv-b'), f.clock.now()),
        )
      ).status,
    ).toBe('accepted');
  });

  it('endpoint disabled：立即拒绝，不入队', async () => {
    const f = await setup({ endpointStatus: 'disabled' });
    const ack = await f.ingress.sink(
      envelopeOf(f.alice, f.newMessageId(), 'turn', turnPayload('endpoint 关了'), f.clock.now()),
    );
    expect(rejectedCode(ack)).toBe('endpoint_disabled');
    expect(f.dispatcher.turns).toHaveLength(0);
  });

  it('跨 pairing：Bob 不能 stop / resume Alice 的会话，也不能往 Alice 的会话里发 turn', async () => {
    const f = await setup();
    // Alice 先建立会话
    await f.ingress.sink(
      envelopeOf(f.alice, f.newMessageId(), 'turn', turnPayload('我的会话'), f.clock.now()),
    );
    f.dispatcher.turns.length = 0;

    for (const op of ['stop', 'resume'] as const) {
      const ack = await f.ingress.sink(
        envelopeOf(
          f.bob,
          f.newMessageId(),
          'control',
          { type: 'control', op, conversationId: 'conv-1', generation: 1 },
          f.clock.now(),
        ),
      );
      expect(rejectedCode(ack)).toBe('conversation_forbidden');
    }

    const turnAck = await f.ingress.sink(
      envelopeOf(f.bob, f.newMessageId(), 'turn', turnPayload('插队'), f.clock.now()),
    );
    expect(rejectedCode(turnAck)).toBe('conversation_forbidden');

    expect(f.dispatcher.controls).toHaveLength(0);
    expect(f.dispatcher.turns).toHaveLength(0);
  });

  it('过期代数的 turn 被拦在入队之前（stale_generation）', async () => {
    const f = await setup();
    await f.ingress.sink(
      envelopeOf(f.alice, f.newMessageId(), 'turn', turnPayload('第二代', 2), f.clock.now()),
    );
    f.dispatcher.turns.length = 0;

    const ack = await f.ingress.sink(
      envelopeOf(f.alice, f.newMessageId(), 'turn', turnPayload('旧代', 1), f.clock.now()),
    );
    expect(rejectedCode(ack)).toBe('stale_generation');
    expect(f.dispatcher.turns).toHaveLength(0);
  });
});
