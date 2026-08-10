import { describe, it, expect, vi } from 'vitest';

import { endSession } from '../../v6/end-session.js';
import type { ReplyContext } from '../../v6/reply-context.js';

const ctx: ReplyContext = { token: 't', userId: 'user-abcdefghij', contextToken: 'c' };

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}
function notFound(): Response {
  return { ok: false, status: 404 } as Response;
}

describe('cc2wechat --end', () => {
  it('v5 daemon 在：照旧打 /close-session', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const r = await endSession({ ports: [18081], contextPath: '/tmp/x.json', fetchImpl: fetchImpl as any });

    expect(r).toEqual({ ok: true, via: 'v5-endpoint', message: 'Session closed.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('http://127.0.0.1:18081/close-session');
    expect(JSON.parse(init.body)).toEqual({ contextPath: '/tmp/x.json' });
  });

  it('第一个端口不通就试下一个', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse());
    const r = await endSession({ ports: [18081, 18082], contextPath: '/tmp/x.json', fetchImpl: fetchImpl as any });
    expect(r.via).toBe('v5-endpoint');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // v6 的 health server 对未知路径回 404。老实现 `.then(() => 'Session closed.')`
  // 把 404 当成功打印出来，agent 以为自己已经跟用户道过别了 —— 这就是这条测试守的东西。
  it('404 不算成功：v6 引擎下要说清楚"没有服务端会话可关"', async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const r = await endSession({
      ports: [18081],
      contextPath: '/tmp/x.json',
      fetchImpl: fetchImpl as any,
      resolveCtx: () => ctx,
    });
    expect(r.ok).toBe(true);
    expect(r.via).toBe('v6-no-server-session');
    expect(r.message).not.toContain('Session closed.');
    expect(r.message).toContain('/new');
  });

  it('端点全不通但 ctx 还在：告诉用户会话本身没断', async () => {
    const r = await endSession({
      ports: [18081, 18082],
      contextPath: '/tmp/x.json',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as any,
      resolveCtx: () => ctx,
    });
    expect(r.via).toBe('v6-no-server-session');
    expect(r.message).toContain('user-abcde');
  });

  it('连 ctx 都没有：明说没有活跃会话，且退出码非 0', async () => {
    const r = await endSession({
      ports: [18081],
      contextPath: '/tmp/x.json',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as any,
      resolveCtx: () => null,
    });
    expect(r).toEqual({
      ok: false,
      via: 'none',
      message: '没有活跃会话（找不到回复上下文，daemon 可能没在跑）',
    });
  });

  it('端点卡住不回也不会永远等（带超时）', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const r = await endSession({
      ports: [18081],
      contextPath: '/tmp/x.json',
      fetchImpl: fetchImpl as any,
      resolveCtx: () => null,
      timeoutMs: 20,
    });
    expect(r.via).toBe('none');
  });
});
