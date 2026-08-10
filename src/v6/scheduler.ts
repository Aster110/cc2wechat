import type { EnqueueResult, Scheduler } from './contracts.js';

export type SchedulerTask = (signal: AbortSignal) => Promise<void>;

export interface SchedulerOptions {
  /** 全局并发槽,缺省读 env CC2WECHAT_MAX_CONCURRENT,再缺省 2 */
  maxConcurrent?: number;
  /** 单会话积压上限,缺省读 env CC2WECHAT_QUEUE_CAP,再缺省 5 */
  queueCap?: number;
  /** 任务抛异常时的兜底(默认吞掉,由调用方决定要不要打日志) */
  onError?: (err: unknown) => void;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_QUEUE_CAP = 5;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface ConvState {
  queue: SchedulerTask[];
  /** 非 null = 正在跑;abort() 打的就是它 */
  controller: AbortController | null;
}

/**
 * 纯内存调度器。三条铁律:
 * 1. 同 conversation 并发恒为 1 —— 保证上下文顺序,这是聊天场景的正确性底线
 * 2. 全局并发有上限 —— 后端(codex/claude)是重进程,放开了会把机器打死
 * 3. 单会话积压有上限 —— 用户连发 20 条时告诉他排不下了,而不是默默攒着 20 分钟后炸出来
 *
 * abort 只发信号不强杀:任务自己收尾(杀子进程、停 typing、回消息),
 * 调度器等它 return —— 强杀会让 typing 心跳永远停不掉。
 */
export class InMemoryScheduler implements Scheduler {
  readonly maxConcurrent: number;
  readonly queueCap: number;
  private readonly onError: (err: unknown) => void;

  /** 插入序 Map:pump 时按顺序找可跑的,跑过的挪到队尾,避免头部会话饿死别人 */
  private convs = new Map<string, ConvState>();
  private runningCount = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(opts: SchedulerOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? envInt('CC2WECHAT_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT);
    this.queueCap = opts.queueCap ?? envInt('CC2WECHAT_QUEUE_CAP', DEFAULT_QUEUE_CAP);
    this.onError = opts.onError ?? (() => {});
  }

  enqueue(conversationId: string, task: SchedulerTask): EnqueueResult {
    const st = this.stateOf(conversationId);

    const canStartNow = st.controller === null && st.queue.length === 0 && this.runningCount < this.maxConcurrent;
    if (canStartNow) {
      this.start(conversationId, st, task);
      return 'started';
    }

    if (st.queue.length >= this.queueCap) return 'rejected';
    st.queue.push(task);
    return 'queued';
  }

  abort(conversationId: string): boolean {
    const st = this.convs.get(conversationId);
    if (!st?.controller) return false;
    st.controller.abort();
    return true;
  }

  clear(conversationId: string): number {
    const st = this.convs.get(conversationId);
    if (!st) return 0;
    const n = st.queue.length;
    st.queue = [];
    this.gc(conversationId, st);
    return n;
  }

  depth(conversationId: string): number {
    return this.convs.get(conversationId)?.queue.length ?? 0;
  }

  running(conversationId: string): boolean {
    return this.convs.get(conversationId)?.controller != null;
  }

  /** /health 用的汇总视图(契约之外的补充能力) */
  stats(): { running: number; queued: number } {
    let queued = 0;
    for (const st of this.convs.values()) queued += st.queue.length;
    return { running: this.runningCount, queued };
  }

  /** 等到"没有在跑的也没有排队的"为止 */
  async drain(): Promise<void> {
    while (this.runningCount > 0 || this.stats().queued > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  private stateOf(conversationId: string): ConvState {
    let st = this.convs.get(conversationId);
    if (!st) {
      st = { queue: [], controller: null };
      this.convs.set(conversationId, st);
    }
    return st;
  }

  private start(conversationId: string, st: ConvState, task: SchedulerTask): void {
    const controller = new AbortController();
    st.controller = controller;
    this.runningCount++;

    void (async () => {
      try {
        await task(controller.signal);
      } catch (err) {
        // 槽位释放在 finally,异常任务泄漏不了槽
        this.onError(err);
      } finally {
        st.controller = null;
        this.runningCount--;
        this.pump();
        this.gc(conversationId, st);
        this.notifyIdle();
      }
    })();
  }

  private pump(): void {
    if (this.runningCount >= this.maxConcurrent) return;
    for (const [conversationId, st] of [...this.convs.entries()]) {
      if (this.runningCount >= this.maxConcurrent) return;
      if (st.controller !== null || st.queue.length === 0) continue;
      const task = st.queue.shift()!;
      // 轮转到队尾:下一轮 pump 先照顾别人,防止高频会话独占全局槽
      this.convs.delete(conversationId);
      this.convs.set(conversationId, st);
      this.start(conversationId, st, task);
    }
  }

  /** 既没在跑也没排队的会话没有保留价值,删掉防内存泄漏 */
  private gc(conversationId: string, st: ConvState): void {
    if (st.controller === null && st.queue.length === 0) this.convs.delete(conversationId);
  }

  private notifyIdle(): void {
    if (this.runningCount > 0 || this.stats().queued > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
