/**
 * M4 · ConversationService（RED）
 *
 * 架构 §10 + 任务书 §6.3/§6.4/§6.5 里所有"谁有权接续哪个会话"的判定。
 *
 * 冻结的状态机（本测试即规格）：
 *
 * - conversationId 由客户端铸。首次出现即创建，owner = (pairingId, principalId)，**此后不可更改**。
 * - 每条消息带 generation。与库里相等 = 继续；小于 = `stale_generation`（过期消息不许改状态）；
 *   大于 = 客户端开了新一代 → 提升 generation 并**丢弃 provider binding**。
 * - `new` 控制带**新** conversationId + 更高 generation；旧会话被 supersede（generation+1），
 *   于是旧 binding 立刻失效、旧代的在途消息全部变 stale。
 * - `binding()` 只在 `binding.generation === conversation.generation` 时返回，
 *   否则返回 null —— 这就是"同 generation 只有一个有效 binding"的实现点。
 * - 跨 principal / 跨 pairing 一律 `conversation_forbidden`，且错误里不得回显真正 owner 是谁
 *   （否则公共信箱的观察者能拿它当会话存在性预言机）。
 */
import { describe, it, expect, afterEach } from 'vitest';

import type { GatewayStore } from '../../gateway/state/sqlite-store.js';
import type { SessionBinding } from '../../v6/contracts.js';

import {
  TestClock,
  lazyModule,
  openTestStore,
  seedEndpoint,
  seedPairing,
  type SeededPairing,
  type TestStore,
} from './harness.js';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type ConversationSnapshot = {
  id: string;
  pairingId: string;
  principalId: string;
  generation: number;
};

type ConversationDecision =
  | {
      allowed: true;
      conversation: ConversationSnapshot;
      created: boolean;
      generationChanged: boolean;
    }
  | { allowed: false; code: string; message: string };

type ConversationRef = {
  conversationId: string;
  generation: number;
  pairingId: string;
  principalId: string;
};

type ConversationServiceApi = {
  /** turn / resume 走这里：不存在就创建，存在就校验 owner 与 generation。 */
  open(input: ConversationRef): ConversationDecision;
  /** `new` 控制走这里：conversationId 必须是新的，可选地 supersede 上一条会话。 */
  startNew(input: ConversationRef & { previousConversationId?: string }): ConversationDecision;
  /** 只判归属，不动 generation（stop / resume 的前置检查）。 */
  authorize(input: Omit<ConversationRef, 'generation'>): ConversationDecision;
  bindProvider(input: {
    conversationId: string;
    generation: number;
    agentType: string;
    providerSessionId: string;
  }): void;
  binding(conversationId: string): SessionBinding | null;
};

type ConversationServiceModule = {
  createConversationService(options: { store: GatewayStore; now(): number }): ConversationServiceApi;
};

const loadService = lazyModule<ConversationServiceModule>(
  '../../gateway/core/conversation-service.js',
);

function allowed(decision: ConversationDecision): Extract<ConversationDecision, { allowed: true }> {
  if (!decision.allowed) {
    throw new Error(`expected an allowed decision, got ${decision.code}`);
  }
  return decision;
}

function denied(decision: ConversationDecision): Extract<ConversationDecision, { allowed: false }> {
  if (decision.allowed) {
    throw new Error('expected a denied decision, but it was allowed');
  }
  return decision;
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
  alice: SeededPairing;
  bob: SeededPairing;
  service: ConversationServiceApi;
}

async function setup(): Promise<Fixture> {
  handle = openTestStore();
  const store = handle.store;
  const clock = new TestClock();
  seedEndpoint(store, { id: 'aster-admin' });
  const alice = await seedPairing(store, clock, { endpointId: 'aster-admin' });
  const bob = await seedPairing(store, clock, { endpointId: 'aster-admin' });
  const mod = await loadService();
  const service = mod.createConversationService({ store, now: clock.now });
  return { store, clock, alice, bob, service };
}

function ref(pairing: SeededPairing, conversationId: string, generation = 1): ConversationRef {
  return {
    conversationId,
    generation,
    pairingId: pairing.pairingId,
    principalId: pairing.principalId,
  };
}

// ---------------------------------------------------------------------------

describe('M4 · ConversationService 归属', () => {
  it('首轮 turn 创建会话，owner 落在 (pairingId, principalId) 上并持久到 SQLite', async () => {
    const f = await setup();
    const first = allowed(f.service.open(ref(f.alice, 'conv-1', 1)));

    expect(first.created).toBe(true);
    expect(first.generationChanged).toBe(false);
    expect(first.conversation).toEqual({
      id: 'conv-1',
      pairingId: f.alice.pairingId,
      principalId: f.alice.principalId,
      generation: 1,
    });

    const row = f.store.getConversation('conv-1');
    expect(row?.pairingId).toBe(f.alice.pairingId);
    expect(row?.principalId).toBe(f.alice.principalId);
    expect(row?.generation).toBe(1);

    // 同一代再来一条：继续，不再是 created
    const second = allowed(f.service.open(ref(f.alice, 'conv-1', 1)));
    expect(second.created).toBe(false);
    expect(second.generationChanged).toBe(false);
  });

  it('跨 pairing 用同一个 conversationId 被拒，且错误不回显真正的 owner', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 1)));

    const decision = denied(f.service.open(ref(f.bob, 'conv-1', 1)));
    expect(decision.code).toBe('conversation_forbidden');
    // 存在性预言机防护：错误里不许出现真正 owner 的任何 id
    expect(decision.message).not.toContain(f.alice.pairingId);
    expect(decision.message).not.toContain(f.alice.principalId);

    // 被拒的请求不许改写已有行
    expect(f.store.getConversation('conv-1')?.pairingId).toBe(f.alice.pairingId);
  });

  it('同 pairing 但 principal 对不上也拒（不能只凭 pairingId 接续）', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 1)));

    const decision = denied(
      f.service.open({
        conversationId: 'conv-1',
        generation: 1,
        pairingId: f.alice.pairingId,
        principalId: f.bob.principalId,
      }),
    );
    expect(decision.code).toBe('conversation_forbidden');
  });

  it('authorize()：本人放行，别人 conversation_forbidden，不存在 conversation_not_found', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 1)));

    const mine = allowed(
      f.service.authorize({
        conversationId: 'conv-1',
        pairingId: f.alice.pairingId,
        principalId: f.alice.principalId,
      }),
    );
    expect(mine.conversation.id).toBe('conv-1');

    expect(
      denied(
        f.service.authorize({
          conversationId: 'conv-1',
          pairingId: f.bob.pairingId,
          principalId: f.bob.principalId,
        }),
      ).code,
    ).toBe('conversation_forbidden');

    expect(
      denied(
        f.service.authorize({
          conversationId: 'conv-nope',
          pairingId: f.alice.pairingId,
          principalId: f.alice.principalId,
        }),
      ).code,
    ).toBe('conversation_not_found');
  });
});

describe('M4 · ConversationService generation 闸门', () => {
  it('generation 比库里小 → stale_generation，且不许动已有 binding', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 2)));
    f.service.bindProvider({
      conversationId: 'conv-1',
      generation: 2,
      agentType: 'codex',
      providerSessionId: 'thread_abc',
    });

    expect(denied(f.service.open(ref(f.alice, 'conv-1', 1))).code).toBe('stale_generation');
    expect(f.service.binding('conv-1')?.providerSessionId).toBe('thread_abc');
    expect(f.store.getConversation('conv-1')?.generation).toBe(2);
  });

  it('generation 比库里大 → 提升代数并丢弃 provider binding（客户端开了新一代）', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 1)));
    f.service.bindProvider({
      conversationId: 'conv-1',
      generation: 1,
      agentType: 'codex',
      providerSessionId: 'thread_abc',
    });
    expect(f.service.binding('conv-1')).not.toBeNull();

    const bumped = allowed(f.service.open(ref(f.alice, 'conv-1', 2)));
    expect(bumped.generationChanged).toBe(true);
    expect(bumped.conversation.generation).toBe(2);
    expect(f.service.binding('conv-1')).toBeNull();
    expect(f.store.getConversation('conv-1')?.generation).toBe(2);
  });

  it('bindProvider 写出的是 v6 SessionBinding，binding() 只在同代时返回', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 3)));
    f.service.bindProvider({
      conversationId: 'conv-1',
      generation: 3,
      agentType: 'codex',
      providerSessionId: 'thread_abc',
    });

    const binding: SessionBinding | null = f.service.binding('conv-1');
    expect(binding).not.toBeNull();
    expect(binding?.conversationId).toBe('conv-1');
    expect(binding?.agentType).toBe('codex');
    expect(binding?.providerSessionId).toBe('thread_abc');
    expect(binding?.generation).toBe(3);
    expect(typeof binding?.createdAt).toBe('number');
    expect(typeof binding?.updatedAt).toBe('number');

    // 落后一代的 binding 永远不许被交给 Runner
    f.service.bindProvider({
      conversationId: 'conv-1',
      generation: 2,
      agentType: 'codex',
      providerSessionId: 'thread_old',
    });
    expect(f.service.binding('conv-1')).toBeNull();
  });

  it('未知会话的 binding() 返回 null，不抛', async () => {
    const f = await setup();
    expect(f.service.binding('conv-unknown')).toBeNull();
  });
});

describe('M4 · ConversationService new/supersede', () => {
  it('new 用新 conversationId 建新会话，并 supersede 旧会话：旧 binding 立刻失效、旧代消息变 stale', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 1)));
    f.service.bindProvider({
      conversationId: 'conv-1',
      generation: 1,
      agentType: 'codex',
      providerSessionId: 'thread_old',
    });

    const created = allowed(
      f.service.startNew({ ...ref(f.alice, 'conv-2', 2), previousConversationId: 'conv-1' }),
    );
    expect(created.created).toBe(true);
    expect(created.conversation.generation).toBe(2);

    // 旧会话被 supersede：binding 失效
    expect(f.service.binding('conv-1')).toBeNull();
    // 旧代的在途消息全部变 stale，接不回旧上下文
    expect(denied(f.service.open(ref(f.alice, 'conv-1', 1))).code).toBe('stale_generation');
    // 新会话干净，没有继承任何 provider session
    expect(f.service.binding('conv-2')).toBeNull();
  });

  it('new 复用已存在的 conversationId 被拒（不许把已有会话"重开"）', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 1)));
    expect(denied(f.service.startNew(ref(f.alice, 'conv-1', 2))).code).toBe('conversation_exists');
  });

  it('new 的 previousConversationId 属于别的 pairing → 拒，且新会话不许被创建（整体原子）', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.bob, 'conv-bob', 1)));
    f.service.bindProvider({
      conversationId: 'conv-bob',
      generation: 1,
      agentType: 'codex',
      providerSessionId: 'thread_bob',
    });

    const decision = denied(
      f.service.startNew({ ...ref(f.alice, 'conv-2', 2), previousConversationId: 'conv-bob' }),
    );
    expect(decision.code).toBe('conversation_forbidden');

    expect(f.store.getConversation('conv-2')).toBeNull();
    // 别人的会话与绑定一根汗毛都不能动
    expect(f.store.getConversation('conv-bob')?.generation).toBe(1);
    expect(f.service.binding('conv-bob')?.providerSessionId).toBe('thread_bob');
  });

  it('new 不带 previousConversationId 也能用（首次开会话），generation 必须 ≥1', async () => {
    const f = await setup();
    const created = allowed(f.service.startNew(ref(f.alice, 'conv-first', 1)));
    expect(created.created).toBe(true);
    expect(denied(f.service.startNew(ref(f.alice, 'conv-zero', 0))).code).toBe('invalid_generation');
  });
});

describe('M4 · ConversationService 重启恢复', () => {
  it('关库重开后 conversation 与 provider binding 都还在（真 SQLite，不是内存态）', async () => {
    const f = await setup();
    allowed(f.service.open(ref(f.alice, 'conv-1', 4)));
    f.service.bindProvider({
      conversationId: 'conv-1',
      generation: 4,
      agentType: 'codex',
      providerSessionId: 'thread_abc',
    });

    const reopened = handle?.reopen();
    expect(reopened).toBeDefined();
    if (reopened === undefined) return;

    const mod = await loadService();
    const revived = mod.createConversationService({ store: reopened, now: f.clock.now });

    const decision = allowed(revived.open(ref(f.alice, 'conv-1', 4)));
    expect(decision.created).toBe(false);
    expect(decision.conversation.generation).toBe(4);
    expect(revived.binding('conv-1')?.providerSessionId).toBe('thread_abc');
    expect(revived.binding('conv-1')?.generation).toBe(4);
  });
});
