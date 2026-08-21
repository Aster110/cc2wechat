import { describe, expect, it } from 'vitest';

import type { DeliveryReceipt } from '../../gateway/contracts/channel.js';
import type { SecurePayload } from '../../gateway/contracts/envelope.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_MS,
  createStatusHeartbeat,
  deriveAgentState,
  type HeartbeatFacts,
  type HeartbeatRoute,
} from '../../gateway/core/status-heartbeat.js';

/** 手摇时钟 + 手摇 timer：拍子什么时候响完全由测试说了算，不靠真实等待。 */
function harness(overrides: Partial<Parameters<typeof createStatusHeartbeat>[0]> = {}) {
  let clock = 1_000_000;
  const pending = new Map<number, { fn: () => void; dueAt: number }>();
  let nextHandle = 1;

  const beats: Array<{
    routeId: string;
    payload: SecurePayload;
    keyVersion: number;
    expiresAt: number;
  }> = [];
  const logs: string[] = [];
  let receipt: (routeId: string) => DeliveryReceipt = () => ({ status: 'sent' });
  let facts: HeartbeatFacts = {
    queuesRunning: 0,
    queuesQueued: 0,
    credentialOk: true,
    mailboxDegraded: false,
    endpointsAllOk: true,
  };
  let routes: HeartbeatRoute[] = [{ routeId: 'rt_a', keyVersion: 1 }];
  let snapshotError: Error | null = null;
  let beatThrows = false;

  const heartbeat = createStatusHeartbeat({
    routes: () => routes,
    beat: async (input) => {
      beats.push(input);
      if (beatThrows) throw new Error('boom');
      return receipt(input.routeId);
    },
    snapshot: async () => {
      if (snapshotError !== null) throw snapshotError;
      return facts;
    },
    now: () => clock,
    timer: {
      setTimeout: (fn, ms) => {
        const handle = nextHandle++;
        pending.set(handle, { fn, dueAt: clock + ms });
        return handle;
      },
      clearTimeout: (handle) => {
        pending.delete(handle);
      },
    },
    log: (line) => logs.push(line),
    ...overrides,
  });

  /** 推进到下一个到期的定时器并触发它，返回这一跳等了多久。 */
  async function fire(): Promise<number> {
    const entry = [...pending.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
    if (entry === undefined) throw new Error('no timer scheduled');
    const [handle, { fn, dueAt }] = entry;
    const waited = dueAt - clock;
    clock = dueAt;
    pending.delete(handle);
    fn();
    await settle();
    return waited;
  }

  /**
   * 抽干 microtask 队列。一拍是"逐路由串行 await"，路由越多要抽的轮次越多——
   * 抽不干净就会在拍子还没跑完时去点下一个 timer，测出假失败。
   */
  const settle = async () => {
    for (let i = 0; i < 400; i += 1) await Promise.resolve();
  };

  return {
    heartbeat,
    beats,
    logs,
    settle,
    fire,
    now: () => clock,
    pendingCount: () => pending.size,
    setReceipt: (fn: (routeId: string) => DeliveryReceipt) => {
      receipt = fn;
    },
    setFacts: (next: Partial<HeartbeatFacts>) => {
      facts = { ...facts, ...next };
    },
    setRoutes: (next: HeartbeatRoute[]) => {
      routes = next;
    },
    failSnapshot: (err: Error | null) => {
      snapshotError = err;
    },
    throwOnBeat: (value: boolean) => {
      beatThrows = value;
    },
  };
}

describe('deriveAgentState', () => {
  const base: HeartbeatFacts = {
    queuesRunning: 0,
    queuesQueued: 0,
    credentialOk: true,
    mailboxDegraded: false,
    endpointsAllOk: true,
  };

  it('空闲且一切正常 = online', () => {
    expect(deriveAgentState(base)).toBe('online');
  });

  it('有 turn 在跑 = busy', () => {
    expect(deriveAgentState({ ...base, queuesRunning: 1 })).toBe('busy');
  });

  it('三种坏消息各自独立触发 degraded，且盖过 busy', () => {
    // 优先级是硬要求：正在忙但凭证已经烂了，报 busy 会把故障藏起来。
    expect(deriveAgentState({ ...base, credentialOk: false, queuesRunning: 1 })).toBe('degraded');
    expect(deriveAgentState({ ...base, mailboxDegraded: true, queuesRunning: 1 })).toBe('degraded');
    expect(deriveAgentState({ ...base, endpointsAllOk: false, queuesRunning: 1 })).toBe('degraded');
  });

  it('周期拍永远不会推导出 offline —— offline 只能来自墓碑或行陈旧', () => {
    const states = [
      deriveAgentState(base),
      deriveAgentState({ ...base, credentialOk: false }),
      deriveAgentState({ ...base, queuesRunning: 3 }),
    ];
    expect(states).not.toContain('offline');
  });
});

describe('createStatusHeartbeat', () => {
  it('U1 start() 立刻打第一拍，载荷字段齐全', async () => {
    const h = harness();
    h.heartbeat.start();
    await h.settle();

    expect(h.beats).toHaveLength(1);
    const [first] = h.beats;
    expect(first.routeId).toBe('rt_a');
    expect(first.keyVersion).toBe(1);
    expect(first.expiresAt).toBe(h.now() + HEARTBEAT_TTL_MS);
    expect(first.payload).toEqual({
      type: 'status',
      agent: 'online',
      at: h.now(),
      queued: 0,
      running: 0,
    });
  });

  it('U2 每 30 秒一拍', async () => {
    const h = harness();
    h.heartbeat.start();
    await h.settle();
    const waited = await h.fire();

    expect(waited).toBe(HEARTBEAT_INTERVAL_MS);
    expect(h.beats).toHaveLength(2);
    expect(h.beats[1].routeId).toBe('rt_a');
  });

  it('U3 有 turn 在跑时报 busy，并带上真实队列数', async () => {
    const h = harness();
    h.setFacts({ queuesRunning: 1, queuesQueued: 2 });
    h.heartbeat.start();
    await h.settle();

    expect(h.beats[0].payload).toMatchObject({ agent: 'busy', running: 1, queued: 2 });
  });

  it('U4 凭证坏掉时报 degraded', async () => {
    const h = harness();
    h.setFacts({ credentialOk: false });
    h.heartbeat.start();
    await h.settle();

    expect(h.beats[0].payload).toMatchObject({ agent: 'degraded' });
  });

  it('U5 没有 active pairing 时零写入，但拍子继续走；新配对下一拍就被覆盖', async () => {
    const h = harness();
    h.setRoutes([]);
    h.heartbeat.start();
    await h.settle();
    expect(h.beats).toHaveLength(0);

    // 每拍重读 routes 的证据：不用重启就能认到新配对。
    h.setRoutes([{ routeId: 'rt_new', keyVersion: 2 }]);
    await h.fire();
    expect(h.beats).toHaveLength(1);
    expect(h.beats[0]).toMatchObject({ routeId: 'rt_new', keyVersion: 2 });
  });

  it('U6 单条路由永久失败不连坐，其余照写，下一拍还会重试它', async () => {
    const h = harness();
    h.setRoutes([
      { routeId: 'rt_bad', keyVersion: 1 },
      { routeId: 'rt_good', keyVersion: 1 },
    ]);
    h.setReceipt((routeId) =>
      routeId === 'rt_bad'
        ? { status: 'permanent-failure', code: 'waku_seal_failed' }
        : { status: 'sent' },
    );
    h.heartbeat.start();
    await h.settle();

    expect(h.beats.map((b) => b.routeId)).toEqual(['rt_bad', 'rt_good']);

    await h.fire();
    // 幂等 upsert，没有"换 ID 重发"的问题，所以下一拍原样再来一次就是重试。
    expect(h.beats.map((b) => b.routeId)).toEqual(['rt_bad', 'rt_good', 'rt_bad', 'rt_good']);
  });

  it('U7 429 中止本拍剩余路由，并把下一拍推迟到 retryAfter', async () => {
    const h = harness();
    h.setRoutes([
      { routeId: 'rt_1', keyVersion: 1 },
      { routeId: 'rt_2', keyVersion: 1 },
      { routeId: 'rt_3', keyVersion: 1 },
    ]);
    h.setReceipt((routeId) =>
      routeId === 'rt_1'
        ? { status: 'retryable', code: 'datastore_rate_limited', retryAfterMs: 60_000 }
        : { status: 'sent' },
    );
    h.heartbeat.start();
    await h.settle();

    expect(h.beats.map((b) => b.routeId)).toEqual(['rt_1']);
    const waited = await h.fire();
    expect(waited).toBe(60_000);
  });

  it('U8 unknown 回执不改调度，下一拍照常覆盖', async () => {
    const h = harness();
    h.setReceipt(() => ({ status: 'unknown', code: 'timeout' }));
    h.heartbeat.start();
    await h.settle();

    const waited = await h.fire();
    expect(waited).toBe(HEARTBEAT_INTERVAL_MS);
    expect(h.beats).toHaveLength(2);
  });

  it('U9 snapshot 抛错时弃这一拍，绝不写编造的状态，循环仍存活', async () => {
    const h = harness();
    h.failSnapshot(new Error('health exploded'));
    h.heartbeat.start();
    await h.settle();
    expect(h.beats).toHaveLength(0);

    h.failSnapshot(null);
    await h.fire();
    expect(h.beats).toHaveLength(1);
  });

  it('U10 停机墓碑：每条路由写一拍 offline，然后拍子彻底停住', async () => {
    const h = harness();
    h.setRoutes([
      { routeId: 'rt_1', keyVersion: 1 },
      { routeId: 'rt_2', keyVersion: 4 },
    ]);
    h.heartbeat.start();
    await h.settle();
    const before = h.beats.length;

    await h.heartbeat.stop({ tombstone: true });

    const tombstones = h.beats.slice(before);
    expect(tombstones).toHaveLength(2);
    for (const t of tombstones) {
      expect(t.payload).toMatchObject({ type: 'status', agent: 'offline', queued: 0, running: 0 });
    }
    expect(tombstones[1].keyVersion).toBe(4);
    expect(h.pendingCount()).toBe(0);
    expect(h.heartbeat.health().lastResult).toBe('tombstone');
  });

  it('U11 墓碑写失败也不许让 stop() 抛出或卡住', async () => {
    const h = harness();
    h.heartbeat.start();
    await h.settle();
    h.throwOnBeat(true);

    await expect(h.heartbeat.stop({ tombstone: true })).resolves.toBeUndefined();
  });

  it('U11b 不带 tombstone 的 stop() 一条都不写', async () => {
    const h = harness();
    h.heartbeat.start();
    await h.settle();
    const before = h.beats.length;

    await h.heartbeat.stop();
    expect(h.beats).toHaveLength(before);
  });

  it('U12 链式调度：任何时刻只有一个待触发的拍子，不会叠拍', async () => {
    const h = harness();
    h.heartbeat.start();
    await h.settle();
    expect(h.pendingCount()).toBe(1);

    await h.fire();
    expect(h.pendingCount()).toBe(1);

    // 重复 start() 不许再排一个。
    h.heartbeat.start();
    expect(h.pendingCount()).toBe(1);
  });

  it('U13 路由多到超预算时拉长拍距，并留一条 warn 日志', async () => {
    const h = harness({ writeBudgetPerMin: 12 });
    h.setRoutes(
      Array.from({ length: 24 }, (_, i) => ({ routeId: `rt_${i}`, keyVersion: 1 })),
    );
    h.heartbeat.start();
    await h.settle();

    // 护栏拉长的是拍距，**不是**把路由砍掉：第一拍 24 条一条不少。
    expect(h.beats).toHaveLength(24);
    expect(new Set(h.beats.map((b) => b.routeId)).size).toBe(24);

    const waited = await h.fire();
    // 24 条 ÷ 12 写/min = 至少 2 分钟一轮。
    expect(waited).toBe(120_000);
    expect(h.logs.some((line) => line.includes('write budget'))).toBe(true);
  });

  it('U14 keyVersion 原样透传，不写死 1', async () => {
    const h = harness();
    h.setRoutes([{ routeId: 'rt_k', keyVersion: 7 }]);
    h.heartbeat.start();
    await h.settle();

    expect(h.beats[0].keyVersion).toBe(7);
  });

  it('U15 stop() 之后不再打任何拍子', async () => {
    const h = harness();
    h.heartbeat.start();
    await h.settle();
    await h.heartbeat.stop();
    const after = h.beats.length;

    expect(h.pendingCount()).toBe(0);
    h.heartbeat.start();
    await h.settle();
    expect(h.beats).toHaveLength(after);
  });
});
