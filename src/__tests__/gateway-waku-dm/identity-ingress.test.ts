/**
 * waku-dm · Core 接缝（RED）：IdentityResolver 策略 + 明文 DM 入站 + 服务端代数 + 文本命令
 *
 * 契约 §3.6：把 ingress 里焊死的「routeId → pairing 行」身份解析抽成策略：
 * - V1 mailbox：`createPairingIdentityResolver`（行为零回归，由既有 532 测试守）
 * - waku-dm：`createAclIdentityResolver`——`OWNER_USER_IDS` → admin endpoint；其它 sender 默认静默 deny。
 *
 * 契约 §3.3 / §3.6：`InboundEnvelope`（明文版）`{channel:'waku-dm', routeId: conversation_id,
 * messageId: id, principalRef: sender_user_id, text, receivedAt, createdAt}`；
 * `conversationId = Waku conversation_id`；`/new` 用 generation 提代（会话 id 不变）；
 * 去重复用 `inbox_receipts`；文本命令沿用 v6：/new /stop /exit /help。
 */
import { describe, it, expect, afterEach } from 'vitest';

import type { GatewayStore } from '../../gateway/state/sqlite-store.js';
import type { AgentEndpoint, RunnerAdapter } from '../../gateway/contracts/runner.js';
import type { DmInboundEnvelope, InboundEnvelope, IngressDelivery, PairingSeam } from '../../gateway/core/ingress.js';
import type { ControlCommand, SubmitResult, ControlResult, TurnDispatcher, TurnJob, TurnTiming } from '../../gateway/core/orchestrator.js';
import type { SecurePayload, MailboxKind } from '../../gateway/contracts/envelope.js';

import { createCoreIngress, dmPromptPrefix } from '../../gateway/core/ingress.js';
import { createAclIdentityResolver, createPairingIdentityResolver } from '../../gateway/core/identity.js';
import { createConversationService } from '../../gateway/core/conversation-service.js';
import { createGatewayOrchestrator } from '../../gateway/core/orchestrator.js';
import { createCoreDelivery } from '../../gateway/core/delivery.js';
import { createLocalRunnerAdapter } from '../../gateway/runners/local-runner.js';
import { createAgentEndpointRegistry } from '../../gateway/runners/registry.js';
import { DM_REPLY } from '../../gateway/core/dm-commands.js';

import {
  FakeAgent,
  FakeChannel,
  TestClock,
  makeUuidV7,
  openTestStore,
  seedEndpoint,
  seedPairing,
  tick,
  type TestStore,
} from '../gateway-core/harness.js';

const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';
const STRANGER = 'usr_stranger_00000000000000000001';
const CONV = 'conv_01J0000000000000000000001';

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

class RecordingDispatcher implements TurnDispatcher {
  readonly turns: TurnJob[] = [];
  readonly controls: ControlCommand[] = [];
  submitResult: SubmitResult = { status: 'started', turnId: 't1' };
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

class RecordingDelivery implements IngressDelivery {
  readonly published: Array<{ pairingId: string; routeId: string; keyVersion: number; kind: MailboxKind; payload: SecurePayload }> = [];
  private readonly nextId = makeUuidV7('0198cccc');

  async publish(input: { pairingId: string; routeId: string; keyVersion: number; kind: MailboxKind; payload: SecurePayload }) {
    this.published.push(input);
    return { messageId: this.nextId(), receipt: { status: 'sent' as const } };
  }

  acknowledge(): 'acknowledged' | 'unknown' {
    return 'acknowledged';
  }

  finals(): string[] {
    return this.published
      .filter((entry) => entry.kind === 'final')
      .map((entry) => (entry.payload.type === 'final' ? entry.payload.text : ''));
  }
}

const noopPairing: PairingSeam = {
  routes: () => [],
  openPairChunks: async () => {
    throw new Error('no pairing in waku-dm');
  },
  sealPairChunks: async () => [],
  handle: async () => ({ status: 'rejected', code: 'no_pairing' }),
};

const stubRunner: RunnerAdapter = {
  descriptor: { runnerId: 'local-test', nodeId: 'test', kind: 'local', capabilities: ['agent:codex'] },
  run: () => {
    throw new Error('ingress must never call the runner directly');
  },
  reset: async () => undefined,
  health: async () => ({ ok: true }),
  shutdown: async () => undefined,
};

function storeRegistry(store: GatewayStore, runner: RunnerAdapter) {
  return {
    resolve(endpointId: string): { endpoint: AgentEndpoint; runner: RunnerAdapter } {
      const endpoint = store.getEndpoint(endpointId);
      if (endpoint === null) throw Object.assign(new Error('endpoint_not_found'), { code: 'endpoint_not_found' });
      if (endpoint.status !== 'active') throw Object.assign(new Error('endpoint_disabled'), { code: 'endpoint_disabled' });
      return { endpoint, runner };
    },
  };
}

function dmEnvelope(overrides: Partial<DmInboundEnvelope> & { messageId: string; text: string }, now: number): DmInboundEnvelope {
  return {
    channel: 'waku-dm',
    routeId: CONV,
    principalRef: OWNER,
    createdAt: now,
    receivedAt: now,
    ...overrides,
  };
}

let handle: TestStore | null = null;
afterEach(() => {
  handle?.cleanup();
  handle = null;
});

// ---------------------------------------------------------------------------
// IdentityResolver
// ---------------------------------------------------------------------------

describe('waku-dm · AclIdentityResolver 三档', () => {
  const resolverFor = (guestEndpointId: string | null) =>
    createAclIdentityResolver({
      isOwner: (userId) => userId === OWNER,
      ownerEndpointId: 'aster-admin',
      guestEndpointId,
    });

  it('owner → admin endpoint；pairingId/principalId 都是 sender user id，routeId 是会话 id', () => {
    const identity = resolverFor(null).resolve(dmEnvelope({ messageId: 'cmsg_1', text: 'hi' }, 1));
    expect(identity).toMatchObject({
      pairingId: OWNER,
      principalId: OWNER,
      endpointId: 'aster-admin',
      routeId: CONV,
      keyVersion: 1,
    });
    expect(identity.scopes).toContain('chat.send');
    expect(identity.scopes).toContain('conversation.new');
    expect(identity.scopes).toContain('conversation.stop');
  });

  it('默认档 deny：陌生人 → 抛 acl_denied（调用方静默）', () => {
    expect(() => resolverFor(null).resolve(dmEnvelope({ messageId: 'cmsg_1', text: 'hi', principalRef: STRANGER }, 1))).toThrow(
      expect.objectContaining({ code: 'acl_denied' }),
    );
  });

  it('默认档给了 guest endpoint：陌生人落到 guest endpoint，绝不落到 admin endpoint', () => {
    const identity = resolverFor('guest').resolve(dmEnvelope({ messageId: 'cmsg_1', text: 'hi', principalRef: STRANGER }, 1));
    expect(identity.endpointId).toBe('guest');
    expect(identity.principalId).toBe(STRANGER);
  });

  it('非 waku-dm 信封（V1 mailbox 信封）交给它 → unknown_route（策略不串台）', () => {
    const mailbox: InboundEnvelope = {
      channel: 'waku',
      routeId: 'rt_x',
      messageId: '0198f4c1-1111-7000-8000-000000000001',
      kind: 'turn',
      keyVersion: 1,
      createdAt: 1,
      expiresAt: 2,
      receivedAt: 1,
      payload: { type: 'turn', conversationId: 'c', text: 'x', clientSeq: 0 },
    };
    expect(() => resolverFor(null).resolve(mailbox)).toThrow(expect.objectContaining({ code: 'unknown_route' }));
  });

  it('PairingIdentityResolver：V1 路由 → pairing 行字段；未知路由 unknown_route(permanent)；waku-dm 信封 unknown_route', async () => {
    handle = openTestStore();
    const clock = new TestClock();
    seedEndpoint(handle.store, { id: 'aster-admin' });
    const alice = await seedPairing(handle.store, clock, { endpointId: 'aster-admin' });
    const resolver = createPairingIdentityResolver({
      store: handle.store,
      resolveRoute: (routeId) => (routeId === alice.routeId ? { pairingId: alice.pairingId } : null),
    });
    const identity = resolver.byRoute(alice.routeId);
    expect(identity).toMatchObject({ pairingId: alice.pairingId, principalId: alice.principalId, endpointId: 'aster-admin', routeId: alice.routeId, keyVersion: alice.keyVersion });
    expect(() => resolver.byRoute('rt_unknown')).toThrow(expect.objectContaining({ code: 'unknown_route', permanent: true }));
    expect(() => resolver.resolve(dmEnvelope({ messageId: 'cmsg_1', text: 'hi' }, 1))).toThrow(expect.objectContaining({ code: 'unknown_route' }));
  });
});

// ---------------------------------------------------------------------------
// ingress：waku-dm 入站
// ---------------------------------------------------------------------------

interface DmFixture {
  store: GatewayStore;
  clock: TestClock;
  dispatcher: RecordingDispatcher;
  delivery: RecordingDelivery;
  conversations: ReturnType<typeof createConversationService>;
  ingress: ReturnType<typeof createCoreIngress>;
}

function setupDm(options: { guest?: boolean; identity?: boolean } = {}): DmFixture {
  handle = openTestStore();
  const store = handle.store;
  const clock = new TestClock();
  seedEndpoint(store, { id: 'aster-admin', trustTier: 'admin-bypass' });
  seedEndpoint(store, { id: 'guest', trustTier: 'chat-only' });
  const dispatcher = new RecordingDispatcher();
  const delivery = new RecordingDelivery();
  const conversations = createConversationService({ store, now: clock.now });
  const ingress = createCoreIngress({
    store,
    resolveRoute: () => null,
    ...(options.identity === false
      ? {}
      : {
          identity: createAclIdentityResolver({
            isOwner: (userId) => userId === OWNER,
            ownerEndpointId: 'aster-admin',
            guestEndpointId: options.guest ? 'guest' : null,
          }),
        }),
    conversations,
    registry: storeRegistry(store, stubRunner),
    dispatcher,
    delivery,
    pairing: noopPairing,
    now: clock.now,
    isAdminPrincipal: (principalId) => principalId === OWNER,
  });
  return { store, clock, dispatcher, delivery, conversations, ingress };
}

describe('waku-dm · ingress 明文入站', () => {
  it('owner 的文本 → accepted；TurnJob 字段：pairingId=principalId=sender，conversationId=会话 id，generation=1；receipt 落库', async () => {
    const f = setupDm();
    const ack = await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_1', text: '跑一下测试' }, f.clock.now()));
    expect(ack).toEqual({ status: 'accepted' });
    expect(f.dispatcher.turns).toHaveLength(1);
    expect(f.dispatcher.turns[0]).toMatchObject({
      pairingId: OWNER,
      principalId: OWNER,
      endpointId: 'aster-admin',
      routeId: CONV,
      keyVersion: 1,
      conversationId: CONV,
      generation: 1,
      messageId: 'cmsg_1',
      // 交给 Agent 的正文带会话前缀：它要靠这个 id 才能用回环 CLI 中途发图/发卡。
      text: `${dmPromptPrefix(CONV)}跑一下测试`,
      clientSeq: 0,
      mediaPaths: [],
    });
    expect(f.store.getReceipt(OWNER, 'cmsg_1')?.status).toBe('received');
    // waku-dm 没有 Playable 那种 ack(received) 信箱回执：不往 outbox 里塞空行
    expect(f.delivery.published.filter((entry) => entry.kind === 'ack')).toHaveLength(0);
  });

  it('陌生人（默认 deny）→ rejected acl_denied：不入队、不留 receipt、不发任何回复（静默）', async () => {
    const f = setupDm();
    const ack = await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_2', text: '让我也用用', principalRef: STRANGER }, f.clock.now()));
    expect(ack).toEqual({ status: 'rejected', code: 'acl_denied' });
    expect(f.dispatcher.turns).toHaveLength(0);
    expect(f.store.getReceipt(STRANGER, 'cmsg_2')).toBeNull();
    expect(f.delivery.published).toHaveLength(0);
  });

  it('guest 档：陌生人落 guest endpoint（chat-only），owner 仍是 admin', async () => {
    const f = setupDm({ guest: true });
    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_3', text: 'hi', principalRef: STRANGER, routeId: 'conv_guest' }, f.clock.now()));
    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_4', text: 'hi' }, f.clock.now()));
    expect(f.dispatcher.turns.map((job) => job.endpointId)).toEqual(['guest', 'aster-admin']);
  });

  it('同 message id 重放 → duplicate，dispatcher 只被叫一次（inbox_receipts 复用）', async () => {
    const f = setupDm();
    const envelope = dmEnvelope({ messageId: 'cmsg_5', text: '只跑一次' }, f.clock.now());
    expect(await f.ingress.sink(envelope)).toEqual({ status: 'accepted' });
    expect(await f.ingress.sink({ ...envelope, receivedAt: f.clock.now() + 5 })).toEqual({ status: 'duplicate' });
    expect(f.dispatcher.turns).toHaveLength(1);
  });

  it('admin endpoint 只认服务端 owner 名单：identity 说是 owner 但 isAdminPrincipal 说不是 → admin_endpoint_denied', async () => {
    handle = openTestStore();
    const store = handle.store;
    const clock = new TestClock();
    seedEndpoint(store, { id: 'aster-admin', trustTier: 'admin-bypass' });
    const dispatcher = new RecordingDispatcher();
    const ingress = createCoreIngress({
      store,
      resolveRoute: () => null,
      identity: createAclIdentityResolver({ isOwner: () => true, ownerEndpointId: 'aster-admin', guestEndpointId: null }),
      conversations: createConversationService({ store, now: clock.now }),
      registry: storeRegistry(store, stubRunner),
      dispatcher,
      delivery: new RecordingDelivery(),
      pairing: noopPairing,
      now: clock.now,
      isAdminPrincipal: () => false,
    });
    const ack = await ingress.sink(dmEnvelope({ messageId: 'cmsg_6', text: 'hi' }, clock.now()));
    expect(ack).toEqual({ status: 'rejected', code: 'admin_endpoint_denied' });
    expect(dispatcher.turns).toHaveLength(0);
    expect(store.getReceipt(OWNER, 'cmsg_6')?.status).toBe('rejected');
  });

  it('dispatcher 拒（queue_full）→ receipt 标 rejected，重放拿 duplicate 不会变成二次执行', async () => {
    const f = setupDm();
    f.dispatcher.submitResult = { status: 'rejected', code: 'queue_full' };
    const envelope = dmEnvelope({ messageId: 'cmsg_7', text: '挤爆' }, f.clock.now());
    expect(await f.ingress.sink(envelope)).toEqual({ status: 'rejected', code: 'queue_full' });
    expect(f.store.getReceipt(OWNER, 'cmsg_7')?.status).toBe('rejected');
    f.dispatcher.submitResult = { status: 'started', turnId: 't' };
    expect(await f.ingress.sink(envelope)).toEqual({ status: 'duplicate' });
    expect(f.dispatcher.turns).toHaveLength(1);
  });

  it('没配 identity 策略的 V1 ingress 收到 waku-dm 信封 → unknown_route（默认策略 = pairing，不会误放行）', async () => {
    const f = setupDm({ identity: false });
    const ack = await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_8', text: 'hi' }, f.clock.now()));
    expect(ack).toEqual({ status: 'rejected', code: 'unknown_route' });
    expect(f.dispatcher.turns).toHaveLength(0);
  });
});

describe('waku-dm · ingress 文本命令', () => {
  it('/help → 不入队，发一条 final 帮助文本', async () => {
    const f = setupDm();
    const ack = await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_h', text: ' /HELP ' }, f.clock.now()));
    expect(ack).toEqual({ status: 'accepted' });
    expect(f.dispatcher.turns).toHaveLength(0);
    expect(f.dispatcher.controls).toHaveLength(0);
    expect(f.delivery.finals()).toEqual([DM_REPLY.help]);
    const published = f.delivery.published[0];
    expect(published.pairingId).toBe(OWNER);
    expect(published.routeId).toBe(CONV);
    expect(published.payload).toMatchObject({ type: 'final', conversationId: CONV, replyTo: 'cmsg_h' });
  });

  it('/stop → 抢占通道 control(stop)；ok 回「已停止」，noop 回「没有正在执行的任务」', async () => {
    const f = setupDm();
    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_t', text: '长任务' }, f.clock.now()));
    f.dispatcher.controlResult = { status: 'ok' };
    expect(await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_s1', text: '/stop' }, f.clock.now()))).toEqual({ status: 'accepted' });
    expect(f.dispatcher.controls).toHaveLength(1);
    expect(f.dispatcher.controls[0]).toMatchObject({ op: 'stop', pairingId: OWNER, principalId: OWNER, conversationId: CONV, messageId: 'cmsg_s1' });
    expect(f.delivery.finals()).toEqual([DM_REPLY.stop]);

    f.dispatcher.controlResult = { status: 'noop' };
    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_s2', text: '停止' }, f.clock.now()));
    expect(f.delivery.finals()).toEqual([DM_REPLY.stop, DM_REPLY.stopNoop]);
  });

  it('/stop 在还没有会话时：不调 dispatcher，直接回「没有正在执行的任务」', async () => {
    const f = setupDm();
    expect(await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_s0', text: '/stop' }, f.clock.now()))).toEqual({ status: 'accepted' });
    expect(f.dispatcher.controls).toHaveLength(0);
    expect(f.delivery.finals()).toEqual([DM_REPLY.stopNoop]);
  });

  it('/new → control(new) 同一会话 id + previousConversationId=自己（服务端提代），回「已开启新对话」', async () => {
    const f = setupDm();
    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_1', text: 'hi' }, f.clock.now()));
    f.dispatcher.controlResult = { status: 'ok', cleared: 0, generation: 2 };
    expect(await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_n', text: '/new' }, f.clock.now()))).toEqual({ status: 'accepted' });
    expect(f.dispatcher.controls).toHaveLength(1);
    expect(f.dispatcher.controls[0]).toMatchObject({
      op: 'new',
      conversationId: CONV,
      previousConversationId: CONV,
      pairingId: OWNER,
      principalId: OWNER,
      messageId: 'cmsg_n',
    });
    expect(f.delivery.finals()).toEqual([DM_REPLY.new]);
  });

  it('/exit 与 /new 同机制（断绑定），只是回执文案不同；会话还不存在时只回文案不碰 dispatcher', async () => {
    const f = setupDm();
    expect(await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_e0', text: '/exit' }, f.clock.now()))).toEqual({ status: 'accepted' });
    expect(f.dispatcher.controls).toHaveLength(0);
    expect(f.delivery.finals()).toEqual([DM_REPLY.exit]);

    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_1', text: 'hi' }, f.clock.now()));
    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_e1', text: '退出' }, f.clock.now()));
    expect(f.dispatcher.controls.map((command) => command.op)).toEqual(['new']);
    expect(f.delivery.finals()).toEqual([DM_REPLY.exit, DM_REPLY.exit]);
  });

  it('"帮我 /new 一下" 是聊天内容不是指令：按普通 turn 入队', async () => {
    const f = setupDm();
    await f.ingress.sink(dmEnvelope({ messageId: 'cmsg_9', text: '帮我 /new 一下' }, f.clock.now()));
    expect(f.dispatcher.turns).toHaveLength(1);
    expect(f.dispatcher.controls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 真编排器：服务端代数 + /new 提代 + onTurnFinished
// ---------------------------------------------------------------------------

describe('waku-dm · 服务端代数（真 ConversationService + 真 Orchestrator）', () => {
  it('startNew(previousConversationId === conversationId) = 同会话提代：generation+1、旧 binding 失效、不新建行', () => {
    handle = openTestStore();
    const clock = new TestClock();
    const service = createConversationService({ store: handle.store, now: clock.now });
    const ref = { conversationId: CONV, generation: 1, pairingId: OWNER, principalId: OWNER };
    expect(service.open(ref).allowed).toBe(true);
    service.bindProvider({ conversationId: CONV, generation: 1, agentType: 'codex', providerSessionId: 'thread_1' });
    expect(service.binding(CONV)?.providerSessionId).toBe('thread_1');

    const renewed = service.startNew({ ...ref, previousConversationId: CONV });
    expect(renewed.allowed).toBe(true);
    if (!renewed.allowed) return;
    expect(renewed.conversation.generation).toBe(2);
    expect(renewed.created).toBe(false);
    expect(renewed.generationChanged).toBe(true);
    expect(service.binding(CONV)).toBeNull();
    expect(handle.store.getConversation(CONV)?.generation).toBe(2);

    // V1 语义原样：不带 previous 去"重开"已有会话仍然被拒
    expect(service.startNew({ ...ref, generation: 3 })).toMatchObject({ allowed: false, code: 'conversation_exists' });
    // 别人的会话不能被提代
    expect(service.startNew({ ...ref, pairingId: STRANGER, principalId: STRANGER, previousConversationId: CONV })).toMatchObject({
      allowed: false,
      code: 'conversation_forbidden',
    });
    expect(handle.store.getConversation(CONV)?.generation).toBe(2);
  });

  it('/new 之后下一条消息自动带新代数（不 stale），且 Agent 拿到的 binding 为 null（开新线程）；onTurnFinished 产出计时', async () => {
    handle = openTestStore();
    const store = handle.store;
    const clock = new TestClock();
    seedEndpoint(store, { id: 'aster-admin', trustTier: 'admin-bypass', runnerProfileId: 'local-test' });
    const agent = new FakeAgent();
    const conversations = createConversationService({ store, now: clock.now });
    const runner = createLocalRunnerAdapter({
      runnerId: 'local-test',
      nodeId: 'test',
      agent,
      resolveWorkspace: () => '/tmp/ws',
      getBinding: (conversationId) => conversations.binding(conversationId),
    });
    const registry = createAgentEndpointRegistry({ store, runners: [{ runnerProfileId: 'local-test', runner }], endpointIds: ['aster-admin'] });
    const channel = new FakeChannel();
    const delivery = createCoreDelivery({ store, channel, now: clock.now, newMessageId: makeUuidV7('0198dddd') });
    const timings: TurnTiming[] = [];
    const orchestrator = createGatewayOrchestrator({
      store,
      registry,
      conversations,
      delivery,
      now: clock.now,
      newTurnId: makeUuidV7('0198eeee'),
      onTurnFinished: (timing) => timings.push(timing),
    });
    const ingress = createCoreIngress({
      store,
      resolveRoute: () => null,
      identity: createAclIdentityResolver({ isOwner: (id) => id === OWNER, ownerEndpointId: 'aster-admin', guestEndpointId: null }),
      conversations,
      registry,
      dispatcher: orchestrator,
      delivery,
      pairing: noopPairing,
      now: clock.now,
      isAdminPrincipal: (id) => id === OWNER,
    });

    // 第一轮：建会话 + 绑定 thread
    expect(await ingress.sink(dmEnvelope({ messageId: 'cmsg_1', text: '第一句' }, clock.now()))).toEqual({ status: 'accepted' });
    await tick(4);
    expect(agent.turns).toHaveLength(1);
    expect(agent.turns[0].request.binding).toBeNull();
    expect(conversations.binding(CONV)?.providerSessionId).toBe(`thread_${CONV}`);
    expect(channel.payloads('final')).toHaveLength(1);

    // 第二轮续聊：binding 原样交给 Agent
    await ingress.sink(dmEnvelope({ messageId: 'cmsg_2', text: '第二句' }, clock.now()));
    await tick(4);
    expect(agent.turns[1].request.binding?.providerSessionId).toBe(`thread_${CONV}`);

    // /new：同会话提代
    expect(await ingress.sink(dmEnvelope({ messageId: 'cmsg_n', text: '/new' }, clock.now()))).toEqual({ status: 'accepted' });
    await tick(2);
    expect(store.getConversation(CONV)?.generation).toBe(2);
    expect(channel.payloads('final').at(-1)).toMatchObject({ type: 'final', text: DM_REPLY.new });

    // 第三轮：服务端代数 = 2，不 stale；binding 为 null → Agent 开新线程
    expect(await ingress.sink(dmEnvelope({ messageId: 'cmsg_3', text: '第三句' }, clock.now()))).toEqual({ status: 'accepted' });
    await tick(4);
    expect(agent.turns).toHaveLength(3);
    expect(agent.turns[2].request.binding).toBeNull();
    expect(conversations.binding(CONV)?.generation).toBe(2);

    // 四件套之二：[turn] 计时由 onTurnFinished 提供
    expect(timings).toHaveLength(3);
    expect(timings[0]).toMatchObject({ conversationId: CONV, pairingId: OWNER, agentType: 'codex', outcome: 'final' });
    expect(timings[0].queueMs).toBeGreaterThanOrEqual(0);
    expect(timings[0].firstEventMs).toBeGreaterThanOrEqual(0);
    expect(timings[0].totalMs).toBeGreaterThanOrEqual(0);
  });
});
