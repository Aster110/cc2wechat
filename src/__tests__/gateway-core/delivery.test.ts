/**
 * M4 · CoreDelivery（RED）
 *
 * 架构 §9 的出站半边 + §13 故障行 + 任务书 §6.3「completed outbox 在 Waku 暂时不可用后重投」。
 *
 * 冻结的三条：
 *
 * 1. **先落库，再写 Waku。** outbox 行必须在 `channel.send()` 被调用之前就已持久，
 *    否则进程在 send 途中挂掉，这条回复就永远消失了。
 * 2. **messageId 由 Core 铸一次，重投复用。** at-least-once 的前提是 ID 不变——
 *    Playable 靠 messageId 去重展示。retryable / unknown 都不许换 ID。
 *    `unknown` 尤其重要：写可能已经成功了，换 ID 重发 = 用户看到两条。
 * 3. **重启后 pending 还能接着投。** 关库重开、换一个 delivery 实例，
 *    仍然按原 messageId 投递（架构 §13「daemon 重启 → 重发 completed outbox」）。
 */
import { describe, it, expect, afterEach } from 'vitest';

import type { GatewayStore, OutboxRow } from '../../gateway/state/sqlite-store.js';

import {
  FakeChannel,
  TestClock,
  UUID_V7_RE,
  lazyModule,
  makeUuidV7,
  openTestStore,
  seedEndpoint,
  seedPairing,
  type ChannelAdapterApi,
  type DeliveryReceipt,
  type MailboxKind,
  type SecurePayload,
  type SeededPairing,
  type TestStore,
} from './harness.js';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type PublishInput = {
  pairingId: string;
  routeId: string;
  keyVersion: number;
  kind: MailboxKind;
  payload: SecurePayload;
};

type PublishResult = { messageId: string; receipt: DeliveryReceipt };

type FlushReport = { attempted: number; sent: number; pending: number; failed: number };

type CoreDeliveryApi = {
  publish(input: PublishInput): Promise<PublishResult>;
  /** 重投所有 pending（重启后 / 退避后调用）。 */
  flushPending(): Promise<FlushReport>;
  /** 玩家 ack（displayed/completed）后本条不再重投。 */
  acknowledge(input: {
    pairingId: string;
    ackMessageId: string;
    status: 'received' | 'completed' | 'displayed';
  }): 'acknowledged' | 'unknown';
  pendingCount(): number;
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

const loadDelivery = lazyModule<CoreDeliveryModule>('../../gateway/core/delivery.js');

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
  channel: FakeChannel;
  delivery: CoreDeliveryApi;
  alice: SeededPairing;
  bob: SeededPairing;
  newMessageId: () => string;
}

async function setup(): Promise<Fixture> {
  handle = openTestStore();
  const store = handle.store;
  const clock = new TestClock();
  seedEndpoint(store, { id: 'aster-admin' });
  const alice = await seedPairing(store, clock, { endpointId: 'aster-admin' });
  const bob = await seedPairing(store, clock, { endpointId: 'aster-admin' });

  const channel = new FakeChannel();
  const newMessageId = makeUuidV7();
  const mod = await loadDelivery();
  const delivery = mod.createCoreDelivery({
    store,
    channel,
    now: clock.now,
    newMessageId,
  });
  return { store, clock, channel, delivery, alice, bob, newMessageId };
}

function finalPayload(text: string, replyTo: string): SecurePayload {
  return { type: 'final', conversationId: 'conv-1', replyTo, text };
}

const REPLY_TO = '0198f4c1-1111-7000-8000-00000000aaaa';

function publishFinal(f: Fixture, text = 'done'): Promise<PublishResult> {
  return f.delivery.publish({
    pairingId: f.alice.pairingId,
    routeId: f.alice.routeId,
    keyVersion: f.alice.keyVersion,
    kind: 'final',
    payload: finalPayload(text, REPLY_TO),
  });
}

// ---------------------------------------------------------------------------

describe('M4 · CoreDelivery 正常投递', () => {
  it('outbox 行在 channel.send 之前就已经落库为 pending', async () => {
    const f = await setup();
    let observedAtSendTime: OutboxRow | null = null;
    f.channel.onSend = (envelope) => {
      observedAtSendTime = f.store.getOutbox(envelope.messageId);
    };

    const result = await publishFinal(f);

    expect(observedAtSendTime).not.toBeNull();
    const row: OutboxRow = observedAtSendTime ?? ({} as OutboxRow);
    expect(row.status).toBe('pending');
    expect(row.messageId).toBe(result.messageId);
    expect(row.pairingId).toBe(f.alice.pairingId);
    expect(row.routeId).toBe(f.alice.routeId);
    expect(row.kind).toBe('final');
  });

  it('sent 回执把行标 sent 并记 externalDeliveryId，pending 归零', async () => {
    const f = await setup();
    f.channel.receipts.push({ status: 'sent', externalDeliveryId: 'doc_42' });

    const result = await publishFinal(f);
    expect(result.receipt.status).toBe('sent');

    const row = f.store.getOutbox(result.messageId);
    expect(row?.status).toBe('sent');
    expect(row?.externalDeliveryId).toBe('doc_42');
    expect(f.delivery.pendingCount()).toBe(0);
    expect(f.store.listPendingOutbox()).toHaveLength(0);
  });

  it('messageId 由 Core 铸，必须是合法 UUIDv7，并原样出现在 OutboundEnvelope 上', async () => {
    const f = await setup();
    const result = await publishFinal(f);

    expect(result.messageId).toMatch(UUID_V7_RE);
    expect(f.channel.sent).toHaveLength(1);
    expect(f.channel.sent[0].messageId).toBe(result.messageId);
    expect(f.channel.sent[0].routeId).toBe(f.alice.routeId);
    expect(f.channel.sent[0].keyVersion).toBe(f.alice.keyVersion);
    expect(f.channel.sent[0].expiresAt).toBeGreaterThan(f.clock.now());
  });

  it('progress / final / error 三种 kind 原样落库并原样进 OutboundEnvelope', async () => {
    const f = await setup();
    const cases: Array<{ kind: MailboxKind; payload: SecurePayload }> = [
      {
        kind: 'progress',
        payload: { type: 'progress', conversationId: 'conv-1', replyTo: REPLY_TO, stage: 'running' },
      },
      { kind: 'final', payload: finalPayload('all good', REPLY_TO) },
      {
        kind: 'error',
        payload: { type: 'error', code: 'turn_timeout', conversationId: 'conv-1', replyTo: REPLY_TO },
      },
    ];

    for (const testCase of cases) {
      const result = await f.delivery.publish({
        pairingId: f.alice.pairingId,
        routeId: f.alice.routeId,
        keyVersion: f.alice.keyVersion,
        kind: testCase.kind,
        payload: testCase.payload,
      });
      const row = f.store.getOutbox(result.messageId);
      expect(row?.kind).toBe(testCase.kind);
      expect(JSON.parse(row?.payload ?? 'null')).toEqual(testCase.payload);
    }

    expect(f.channel.sent.map((e) => e.kind)).toEqual(['progress', 'final', 'error']);
    expect(f.channel.sent[1].payload).toEqual(cases[1].payload);
  });
});

describe('M4 · CoreDelivery 重试语义', () => {
  it('retryable 保留 pending，flushPending 用**原 messageId**重投并最终 sent', async () => {
    const f = await setup();
    f.channel.receipts.push({ status: 'retryable', code: 'waku_429', retryAfterMs: 1_000 });

    const first = await publishFinal(f, 'retry me');
    expect(first.receipt.status).toBe('retryable');
    expect(f.store.getOutbox(first.messageId)?.status).toBe('pending');
    expect(f.delivery.pendingCount()).toBe(1);

    f.clock.advance(1_000);
    const report = await f.delivery.flushPending();
    expect(report.attempted).toBe(1);
    expect(report.sent).toBe(1);
    expect(report.pending).toBe(0);

    expect(f.channel.sent).toHaveLength(2);
    expect(f.channel.sent[1].messageId).toBe(first.messageId);
    expect(f.channel.sent[1].payload).toEqual(f.channel.sent[0].payload);
    expect(f.store.getOutbox(first.messageId)?.status).toBe('sent');
  });

  it('unknown 回执不换 ID、不重复铸：只保留 pending 等下一轮（写可能已经成功了）', async () => {
    const f = await setup();
    f.channel.receipts.push({ status: 'unknown', code: 'client_timeout' });

    const first = await publishFinal(f);
    expect(first.receipt.status).toBe('unknown');
    expect(f.store.getOutbox(first.messageId)?.status).toBe('pending');

    await f.delivery.flushPending();
    expect(f.channel.sent).toHaveLength(2);
    expect(f.channel.sent[1].messageId).toBe(first.messageId);
    expect(f.store.listPendingOutbox()).toHaveLength(0);
  });

  it('permanent-failure 标 failed 且不再重投（重试多少次都没用）', async () => {
    const f = await setup();
    f.channel.receipts.push({ status: 'permanent-failure', code: 'datastore_policy_denied' });

    const first = await publishFinal(f);
    expect(first.receipt.status).toBe('permanent-failure');
    expect(f.store.getOutbox(first.messageId)?.status).toBe('failed');
    expect(f.delivery.pendingCount()).toBe(0);

    const report = await f.delivery.flushPending();
    expect(report.attempted).toBe(0);
    expect(f.channel.sent).toHaveLength(1);
  });

  it('多条 pending 按创建顺序重投，各自复用原 messageId', async () => {
    const f = await setup();
    f.channel.receipts.push(
      { status: 'retryable', code: 'waku_429' },
      { status: 'retryable', code: 'waku_429' },
    );

    const one = await publishFinal(f, 'first');
    f.clock.advance(10);
    const two = await publishFinal(f, 'second');
    expect(f.delivery.pendingCount()).toBe(2);

    const report = await f.delivery.flushPending();
    expect(report.sent).toBe(2);
    expect(f.channel.sent.slice(2).map((e) => e.messageId)).toEqual([one.messageId, two.messageId]);
  });
});

describe('M4 · CoreDelivery 重启恢复', () => {
  it('关库重开后换一个 delivery 实例，pending 仍按原 messageId 与原 payload 投出去', async () => {
    const f = await setup();
    f.channel.receipts.push({ status: 'retryable', code: 'waku_503' });
    const first = await publishFinal(f, 'survive the restart');
    expect(f.store.getOutbox(first.messageId)?.status).toBe('pending');

    const reopened = handle?.reopen();
    expect(reopened).toBeDefined();
    if (reopened === undefined) return;

    const freshChannel = new FakeChannel();
    const mod = await loadDelivery();
    const revived = mod.createCoreDelivery({
      store: reopened,
      channel: freshChannel,
      now: f.clock.now,
      // 重启后 ID 生成器是全新的：如果实现敢重新铸 ID，这里立刻露馅
      newMessageId: makeUuidV7('0198ffff'),
    });

    const report = await revived.flushPending();
    expect(report.attempted).toBe(1);
    expect(report.sent).toBe(1);

    expect(freshChannel.sent).toHaveLength(1);
    expect(freshChannel.sent[0].messageId).toBe(first.messageId);
    expect(freshChannel.sent[0].routeId).toBe(f.alice.routeId);
    expect(freshChannel.sent[0].payload).toEqual(finalPayload('survive the restart', REPLY_TO));
    expect(reopened.getOutbox(first.messageId)?.status).toBe('sent');
  });
});

describe('M4 · CoreDelivery ack 与跨 pairing 隔离', () => {
  it('玩家 ack displayed 后本条不再出现在重投里', async () => {
    const f = await setup();
    const first = await publishFinal(f);
    expect(first.receipt.status).toBe('sent');

    expect(
      f.delivery.acknowledge({
        pairingId: f.alice.pairingId,
        ackMessageId: first.messageId,
        status: 'displayed',
      }),
    ).toBe('acknowledged');

    const report = await f.delivery.flushPending();
    expect(report.attempted).toBe(0);
    expect(f.channel.sent).toHaveLength(1);
  });

  it('别的 pairing 的 ack 动不了我的 outbox（跨 pairing 隔离）', async () => {
    const f = await setup();
    f.channel.receipts.push({ status: 'retryable', code: 'waku_429' });
    const mine = await publishFinal(f);

    expect(
      f.delivery.acknowledge({
        pairingId: f.bob.pairingId,
        ackMessageId: mine.messageId,
        status: 'displayed',
      }),
    ).toBe('unknown');

    // 我的行原封不动，照样会被重投
    expect(f.store.getOutbox(mine.messageId)?.status).toBe('pending');
    const report = await f.delivery.flushPending();
    expect(report.sent).toBe(1);
    expect(f.channel.sent[1].messageId).toBe(mine.messageId);
  });

  it('不存在的 messageId 被 ack：返回 unknown，不抛（公共信箱里全是垃圾行）', async () => {
    const f = await setup();
    expect(
      f.delivery.acknowledge({
        pairingId: f.alice.pairingId,
        ackMessageId: '0198f4c1-1111-7000-8000-0000deadbeef',
        status: 'displayed',
      }),
    ).toBe('unknown');
  });
});
