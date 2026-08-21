/**
 * 在线心跳节拍器（架构 §7 的 `agent_status_v1`）。
 *
 * 通道原语早就在 `adapter.heartbeat()` 里了（seal → 单块校验 → 按 key=routeId upsert），
 * 缺的一直是生产调用方：没人打拍子，那张表一行都没有，于是客户端按
 * "没有心跳行 = offline" 的保守规则，把徽章永远钉在离线上——即使一轮对话刚跑完。
 *
 * 这一层只做三件 adapter 不该懂的事：
 *
 * 1. **状态推导**。`online/busy/degraded` 是业务判断，要可注入、可测，所以放 Core
 *    而不是 bootstrap（那份文件的抬头写了"只做接线"）也不是 adapter（它不懂 pairing 语义）。
 * 2. **独立节拍**。绝不复用收信轮询的 timer：那个 timer 活跃时 1~2s 一跳、429 时整体让路，
 *    心跳搭上去必然被拖乱，还会反过来阻塞收信。
 * 3. **写预算护栏**。pairing 只增不减（重配一次多一条），路由多了就自动拉长拍距，
 *    把失控模式从"静默烧掉写配额"变成"徽章退化 + 日志可见"。
 *
 * 刻意不做的：不走 CoreDelivery。心跳是幂等 upsert（key 固定 routeId），
 * 塞进持久重投管道等于让一条 30 秒寿命的状态在 5 分钟后被重投一次 —— 那是污染，不是可靠性。
 * 失败不重试，**下一拍天然就是重试**。
 */
import type { DeliveryReceipt } from '../contracts/channel.js';
import type { AgentState, SecurePayload } from '../contracts/envelope.js';
import type { TimerSeam } from '../channels/waku/mailbox-adapter.js';

/** 拍距。客户端 60s 内算 online，扣掉 ~5s 读缓存与时钟偏差后仍有 ~25s 余量。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 心跳行寿命。客户端读 status 的那条路径不查过期（新鲜度全由 age 窗口决定），
 * 所以 TTL 只有卫生意义；取 10 分钟 > 客户端 180s 的 offline 线，
 * 这样将来即使客户端补上过期检查，也永远是 age 窗口先生效，不会跳过 degraded 直接黑屏。
 */
export const HEARTBEAT_TTL_MS = 600_000;

/** 每分钟写入上限（占 daemon 侧 60 写/min 预算的 20%）。超了就拉长拍距，不静默丢路由。 */
export const HEARTBEAT_WRITE_BUDGET_PER_MIN = 12;

export interface HeartbeatRoute {
  routeId: string;
  keyVersion: number;
}

/**
 * 推导 `agent` 用的原始事实。**只放事实，不放结论** ——
 * OR 逻辑留在本模块里，才不会被偷偷搬进 bootstrap。
 */
export interface HeartbeatFacts {
  queuesRunning: number;
  queuesQueued: number;
  credentialOk: boolean;
  mailboxDegraded: boolean;
  endpointsAllOk: boolean;
}

export interface StatusHeartbeatOptions {
  /** 每拍重读：新配对不重启就能被覆盖。 */
  routes: () => HeartbeatRoute[];
  beat: (input: {
    routeId: string;
    payload: SecurePayload;
    keyVersion: number;
    expiresAt: number;
  }) => Promise<DeliveryReceipt>;
  snapshot: () => Promise<HeartbeatFacts>;
  now: () => number;
  timer: TimerSeam;
  intervalMs?: number;
  ttlMs?: number;
  writeBudgetPerMin?: number;
  /** 只收聚合计数与 code，永不带 routeId / 明文（沿用 ingress 的日志红线）。 */
  log?: (line: string) => void;
}

export interface StatusHeartbeatHealth {
  lastBeatAt: number | null;
  lastResult: string | null;
}

export interface StatusHeartbeat {
  start(): void;
  /** `tombstone` 只在干净停机时给：写一拍 offline，让徽章立刻变灰而不是等 180s 陈旧化。 */
  stop(input?: { tombstone?: boolean }): Promise<void>;
  health(): StatusHeartbeatHealth;
}

/**
 * 四级短路。顺序即优先级：坏消息盖过忙，忙盖过闲。
 *
 * 周期拍**永不返回 offline** —— 崩溃（kill -9）没有墓碑可写，靠行陈旧化让客户端
 * 60s→degraded、180s→offline，那正是该协议的设计本意。offline 只有墓碑那一条路。
 */
export function deriveAgentState(facts: HeartbeatFacts): Exclude<AgentState, 'offline'> {
  if (!facts.credentialOk || facts.mailboxDegraded || !facts.endpointsAllOk) return 'degraded';
  if (facts.queuesRunning > 0) return 'busy';
  return 'online';
}

export function createStatusHeartbeat(options: StatusHeartbeatOptions): StatusHeartbeat {
  const { routes, beat, snapshot, now, timer } = options;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const ttlMs = options.ttlMs ?? HEARTBEAT_TTL_MS;
  const budget = options.writeBudgetPerMin ?? HEARTBEAT_WRITE_BUDGET_PER_MIN;
  const log = options.log ?? (() => undefined);

  let handle: number | null = null;
  let stopped = false;
  let lastBeatAt: number | null = null;
  let lastResult: string | null = null;

  /** 路由多到写不起时拉长拍距。徽章退化成 degraded 是可见的，烧配额不是。 */
  function effectiveIntervalMs(routeCount: number): number {
    if (routeCount === 0 || budget <= 0) return intervalMs;
    const floor = Math.ceil((routeCount * 60_000) / budget);
    if (floor > intervalMs) {
      log(`heartbeat: ${routeCount} routes exceed the write budget, interval stretched to ${floor}ms`);
      return floor;
    }
    return intervalMs;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    handle = timer.setTimeout(() => {
      void runBeat();
    }, delayMs);
  }

  function payloadFor(agent: AgentState, facts: HeartbeatFacts, at: number): SecurePayload {
    return {
      type: 'status',
      agent,
      at,
      queued: facts.queuesQueued,
      running: facts.queuesRunning,
    };
  }

  /** 一拍：重读路由 → 取一次事实 → 串行写。任何异常都不许逃出 timer 回调。 */
  async function runBeat(): Promise<void> {
    if (stopped) return;
    handle = null;

    let current: HeartbeatRoute[];
    try {
      current = routes();
    } catch {
      lastResult = 'routes_failed';
      schedule(intervalMs);
      return;
    }

    const interval = effectiveIntervalMs(current.length);
    if (current.length === 0) {
      // 一条 pairing 都没有：不写、不崩，下一拍继续看（等着有人配对）。
      lastResult = 'idle';
      schedule(interval);
      return;
    }

    let facts: HeartbeatFacts;
    try {
      facts = await snapshot();
    } catch {
      // 取不到事实就弃这一拍：宁可让行陈旧，也不写一条编造的状态。
      lastResult = 'snapshot_failed';
      log('heartbeat: snapshot failed, beat skipped');
      schedule(interval);
      return;
    }

    const at = now();
    const agent = deriveAgentState(facts);
    const payload = payloadFor(agent, facts, at);

    let sent = 0;
    let failed = 0;
    let backoffMs = 0;

    for (const route of current) {
      if (stopped) return;
      let receipt: DeliveryReceipt;
      try {
        receipt = await beat({
          routeId: route.routeId,
          payload,
          keyVersion: route.keyVersion,
          expiresAt: at + ttlMs,
        });
      } catch {
        failed += 1;
        continue;
      }
      if (receipt.status === 'sent') {
        sent += 1;
        continue;
      }
      if (receipt.status === 'retryable') {
        // 429：本拍剩下的路由全部让路，别把限流撞得更狠。
        backoffMs = Math.max(backoffMs, receipt.retryAfterMs ?? 0);
        failed += 1;
        log(`heartbeat: rate limited (${receipt.code}), remaining routes deferred`);
        break;
      }
      failed += 1;
      log(`heartbeat: write failed (${receipt.code})`);
    }

    lastBeatAt = at;
    lastResult = failed === 0 ? `ok:${agent}` : `partial:${sent}/${sent + failed}`;
    schedule(Math.max(interval, backoffMs));
  }

  return {
    start(): void {
      if (stopped || handle !== null) return;
      // 立刻打第一拍：开屏第一次 pump 就读 status，晚一拍就是白瞪 30 秒离线。
      void runBeat();
    },

    async stop(input = {}): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (handle !== null) {
        timer.clearTimeout(handle);
        handle = null;
      }
      if (input.tombstone !== true) return;

      // 墓碑是尽力而为：停机路径上任何一条写失败都不许把 stop() 卡住或抛出。
      // 调用方必须在 adapter.stop() **之前**调它 —— adapter 停掉后 heartbeat()
      // 一律回 waku_mailbox_stopped，墓碑就成了空转。
      let current: HeartbeatRoute[];
      try {
        current = routes();
      } catch {
        return;
      }
      const at = now();
      const payload: SecurePayload = {
        type: 'status',
        agent: 'offline',
        at,
        queued: 0,
        running: 0,
      };
      for (const route of current) {
        try {
          await beat({
            routeId: route.routeId,
            payload,
            keyVersion: route.keyVersion,
            expiresAt: at + ttlMs,
          });
        } catch {
          // 停机中，无人可报，继续下一条。
        }
      }
      lastBeatAt = at;
      lastResult = 'tombstone';
    },

    health(): StatusHeartbeatHealth {
      return { lastBeatAt, lastResult };
    },
  };
}
