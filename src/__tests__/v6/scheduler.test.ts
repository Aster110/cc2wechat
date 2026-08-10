import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryScheduler } from '../../v6/scheduler.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const savedEnv = { ...process.env };
afterEach(() => {
  process.env.CC2WECHAT_MAX_CONCURRENT = savedEnv.CC2WECHAT_MAX_CONCURRENT;
  process.env.CC2WECHAT_QUEUE_CAP = savedEnv.CC2WECHAT_QUEUE_CAP;
  if (savedEnv.CC2WECHAT_MAX_CONCURRENT == null) delete process.env.CC2WECHAT_MAX_CONCURRENT;
  if (savedEnv.CC2WECHAT_QUEUE_CAP == null) delete process.env.CC2WECHAT_QUEUE_CAP;
});

describe('InMemoryScheduler — 同会话串行', () => {
  it('同一个会话的第二条必须等第一条跑完', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 4 });
    const first = deferred();
    const order: string[] = [];

    expect(
      s.enqueue('c1', async () => {
        order.push('a-start');
        await first.promise;
        order.push('a-end');
      }),
    ).toBe('started');

    expect(
      s.enqueue('c1', async () => {
        order.push('b-start');
      }),
    ).toBe('queued');

    await tick();
    expect(order).toEqual(['a-start']);
    expect(s.depth('c1')).toBe(1);
    expect(s.running('c1')).toBe(true);

    first.resolve();
    await s.drain();
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    expect(s.depth('c1')).toBe(0);
    expect(s.running('c1')).toBe(false);
  });

  it('不同会话可以并行(在全局槽内)', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 2 });
    const d1 = deferred();
    const d2 = deferred();

    expect(s.enqueue('c1', () => d1.promise)).toBe('started');
    expect(s.enqueue('c2', () => d2.promise)).toBe('started');

    await tick();
    expect(s.running('c1')).toBe(true);
    expect(s.running('c2')).toBe(true);

    d1.resolve();
    d2.resolve();
    await s.drain();
  });
});

describe('InMemoryScheduler — 全局并发槽', () => {
  it('槽满时第三个会话排队,前面腾出槽位后自动开跑', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 2 });
    const d1 = deferred();
    const d2 = deferred();
    const started: string[] = [];

    s.enqueue('c1', async () => {
      started.push('c1');
      await d1.promise;
    });
    s.enqueue('c2', async () => {
      started.push('c2');
      await d2.promise;
    });
    // 全局槽已满 —— 即使 c3 自己空闲也只能排队
    expect(
      s.enqueue('c3', async () => {
        started.push('c3');
      }),
    ).toBe('queued');

    await tick();
    expect(started).toEqual(['c1', 'c2']);
    expect(s.running('c3')).toBe(false);
    expect(s.depth('c3')).toBe(1);

    d1.resolve();
    await tick();
    await tick();
    expect(started).toContain('c3');

    d2.resolve();
    await s.drain();
  });

  it('默认全局并发 2,env CC2WECHAT_MAX_CONCURRENT 可覆盖', () => {
    delete process.env.CC2WECHAT_MAX_CONCURRENT;
    expect(new InMemoryScheduler().maxConcurrent).toBe(2);
    process.env.CC2WECHAT_MAX_CONCURRENT = '5';
    expect(new InMemoryScheduler().maxConcurrent).toBe(5);
    process.env.CC2WECHAT_MAX_CONCURRENT = 'garbage';
    expect(new InMemoryScheduler().maxConcurrent).toBe(2);
  });
});

describe('InMemoryScheduler — 有界积压', () => {
  it('单会话积压超过上限返回 rejected', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 1, queueCap: 2 });
    const d = deferred();
    expect(s.enqueue('c1', () => d.promise)).toBe('started');
    expect(s.enqueue('c1', async () => {})).toBe('queued');
    expect(s.enqueue('c1', async () => {})).toBe('queued');
    // 第三条排队 = 超过 cap(2)
    expect(s.enqueue('c1', async () => {})).toBe('rejected');
    expect(s.depth('c1')).toBe(2);

    d.resolve();
    await s.drain();
  });

  it('被拒的任务不会被执行', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 1, queueCap: 1 });
    const d = deferred();
    const rejected = vi.fn();
    s.enqueue('c1', () => d.promise);
    s.enqueue('c1', async () => {});
    expect(s.enqueue('c1', rejected)).toBe('rejected');

    d.resolve();
    await s.drain();
    expect(rejected).not.toHaveBeenCalled();
  });

  it('默认积压上限 5,env CC2WECHAT_QUEUE_CAP 可覆盖', () => {
    delete process.env.CC2WECHAT_QUEUE_CAP;
    expect(new InMemoryScheduler().queueCap).toBe(5);
    process.env.CC2WECHAT_QUEUE_CAP = '9';
    expect(new InMemoryScheduler().queueCap).toBe(9);
  });
});

describe('InMemoryScheduler — abort / clear', () => {
  it('abort 只打当前在跑的那一条,排队的照跑', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 1 });
    const seen: string[] = [];
    let abortedInside = false;

    s.enqueue('c1', async (signal) => {
      seen.push('running');
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          abortedInside = true;
          resolve();
        });
      });
    });
    s.enqueue('c1', async () => {
      seen.push('queued-ran');
    });

    await tick();
    expect(s.abort('c1')).toBe(true);
    await s.drain();

    expect(abortedInside).toBe(true);
    expect(seen).toEqual(['running', 'queued-ran']);
  });

  it('abort 没有在跑的会话返回 false', () => {
    const s = new InMemoryScheduler();
    expect(s.abort('nobody')).toBe(false);
  });

  it('clear 清掉排队并返回数量,不影响在跑的', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 1 });
    const d = deferred();
    const queuedTask = vi.fn();
    s.enqueue('c1', () => d.promise);
    s.enqueue('c1', queuedTask);
    s.enqueue('c1', queuedTask);

    expect(s.clear('c1')).toBe(2);
    expect(s.depth('c1')).toBe(0);
    expect(s.running('c1')).toBe(true);

    d.resolve();
    await s.drain();
    expect(queuedTask).not.toHaveBeenCalled();
  });

  it('clear 空队列返回 0', () => {
    expect(new InMemoryScheduler().clear('nobody')).toBe(0);
  });
});

describe('InMemoryScheduler — 异常隔离', () => {
  it('任务抛异常不泄漏槽位,后面的照常开跑', async () => {
    const errors: unknown[] = [];
    const s = new InMemoryScheduler({ maxConcurrent: 1, onError: (e) => errors.push(e) });
    const ran = vi.fn();

    s.enqueue('c1', async () => {
      throw new Error('boom');
    });
    s.enqueue('c2', async () => {
      ran();
    });

    await s.drain();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('boom');
    expect(s.stats()).toEqual({ running: 0, queued: 0 });
  });

  it('同步抛出的任务也不泄漏槽位', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 1, onError: () => {} });
    const ran = vi.fn();
    s.enqueue('c1', () => {
      throw new Error('sync boom');
    });
    s.enqueue('c1', async () => {
      ran();
    });
    await s.drain();
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('InMemoryScheduler — stats / drain', () => {
  it('stats 汇总在跑与排队总数', async () => {
    const s = new InMemoryScheduler({ maxConcurrent: 1, queueCap: 5 });
    const d = deferred();
    s.enqueue('c1', () => d.promise);
    s.enqueue('c1', async () => {});
    s.enqueue('c2', async () => {});

    expect(s.stats()).toEqual({ running: 1, queued: 2 });
    d.resolve();
    await s.drain();
    expect(s.stats()).toEqual({ running: 0, queued: 0 });
  });

  it('drain 在空调度器上立即返回', async () => {
    await expect(new InMemoryScheduler().drain()).resolves.toBeUndefined();
  });
});
