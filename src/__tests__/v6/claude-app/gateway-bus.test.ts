import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { GatewayBus, type GatewayEvent } from '../../../v6/claude-app/gateway-bus.js';

let bus: GatewayBus;
let server: http.Server;
let port: number;
const openClients: http.ClientRequest[] = [];

beforeEach(async () => {
  bus = new GatewayBus({ ackTimeoutMs: 500 });
  server = http.createServer((req, res) => {
    if (bus.handleRequest(req, res)) return;
    res.writeHead(404);
    res.end('Not Found');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const c of openClients.splice(0)) c.destroy();
  bus.close();
  await new Promise<void>((r) => server.close(() => r()));
});

// ---------------------------------------------------------------------------
// 小客户端
// ---------------------------------------------------------------------------

interface SseClient {
  events: GatewayEvent[];
  waitFor(pred: (e: GatewayEvent) => boolean, timeoutMs?: number): Promise<GatewayEvent>;
  status: number;
  headers: http.IncomingHttpHeaders;
  disconnect(): void;
}

function sse(): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/claude-app/events', method: 'GET' }, (res) => {
      const events: GatewayEvent[] = [];
      const waiters: Array<{ pred: (e: GatewayEvent) => boolean; resolve: (e: GatewayEvent) => void; timer: NodeJS.Timeout }> = [];
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const ev = JSON.parse(line.slice(6)) as GatewayEvent;
            events.push(ev);
            for (const w of [...waiters]) {
              if (!w.pred(ev)) continue;
              clearTimeout(w.timer);
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(ev);
            }
          }
        }
      });
      resolve({
        events,
        status: res.statusCode ?? 0,
        headers: res.headers,
        waitFor(pred, timeoutMs = 2_000) {
          const hit = events.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise<GatewayEvent>((res2, rej2) => {
            const timer = setTimeout(() => rej2(new Error(`waitFor 超时,已收到: ${JSON.stringify(events)}`)), timeoutMs);
            waiters.push({ pred, resolve: res2, timer });
          });
        },
        disconnect: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
    openClients.push(req);
  });
}

function post(path: string, body: unknown | string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json: any = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: any = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* 非 JSON */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

describe('GET /claude-app/events —— 网关长连接', () => {
  it('是 SSE,而且不许被缓冲', async () => {
    const c = await sse();
    expect(c.status).toBe(200);
    expect(c.headers['content-type']).toContain('text/event-stream');
    expect(c.headers['cache-control']).toContain('no-cache');
    // nginx/代理会把 SSE 攒起来一起发,那样心跳就白搭了
    expect(c.headers['x-accel-buffering']).toBe('no');
  });

  it('连上先发 hello(网关据此确认自己真的在班上)', async () => {
    const c = await sse();
    const hello = await c.waitFor((e) => e.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello' });
  });

  it('gatewayConnected 跟着连接走', async () => {
    expect(bus.gatewayConnected()).toBe(false);
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    expect(bus.gatewayConnected()).toBe(true);
    c.disconnect();
    await tick();
    expect(bus.gatewayConnected()).toBe(false);
  });
});

describe('inject —— 一事件一 turn 一回执', () => {
  it('派发 → SSE 收到 inject → POST ack → dispatch 返回成功', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const p = bus.dispatchInject({ jobId: 'J1', localId: 'local_x', text: '[微信|kiki|job:J1|1] 在吗' });
    const ev = (await c.waitFor((e) => e.type === 'inject')) as Extract<GatewayEvent, { type: 'inject' }>;
    expect(ev).toMatchObject({ type: 'inject', jobId: 'J1', localId: 'local_x' });
    expect(ev.text).toContain('job:J1');

    const r = await post('/claude-app/ack', { jobId: 'J1', ok: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('网关回执说失败,原因要原样带回来', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const p = bus.dispatchInject({ jobId: 'J2', localId: 'local_x', text: 'x' });
    await c.waitFor((e) => e.type === 'inject');
    await post('/claude-app/ack', { jobId: 'J2', ok: false, error: 'send_message: session not found' });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 'claude-app-inject-failed' });
    expect((r as { error: string }).error).toContain('session not found');
  });

  it('没有网关在线时立刻失败,不吊着微信那头', async () => {
    const r = await bus.dispatchInject({ jobId: 'J3', localId: 'l', text: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'claude-app-gateway-offline' });
  });

  it('允许等一小会儿网关上线(重挂窗口)', async () => {
    setTimeout(() => void sse(), 20);
    const r = await bus.dispatchInject({ jobId: 'J4', localId: 'l', text: 'x' }, { connectWaitMs: 800 });
    // 上线了就会真发出去,然后卡在等 ack → 超时(500ms),而不是 offline
    expect(r).toMatchObject({ ok: false, code: 'claude-app-ack-timeout' });
  });

  it('迟迟不回执 → ack 超时', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const r = await bus.dispatchInject({ jobId: 'J5', localId: 'l', text: 'x' }, { ackTimeoutMs: 60 });
    expect(r).toMatchObject({ ok: false, code: 'claude-app-ack-timeout' });
  });

  it('两个网关同时挂着也只投一个 —— 双投 = 用户收两条回复', async () => {
    const a = await sse();
    const b = await sse();
    await a.waitFor((e) => e.type === 'hello');
    await b.waitFor((e) => e.type === 'hello');
    void bus.dispatchInject({ jobId: 'J6', localId: 'l', text: 'x' }, { ackTimeoutMs: 100 });
    await tick(60);
    const got = [a, b].filter((c) => c.events.some((e) => e.type === 'inject')).length;
    expect(got).toBe(1);
  });

  it('网关中途掉线 → 重连后补投同一个 job(jobId 兼作去重键)', async () => {
    const a = await sse();
    await a.waitFor((e) => e.type === 'hello');
    const p = bus.dispatchInject({ jobId: 'J7', localId: 'l', text: 'x' }, { ackTimeoutMs: 2_000 });
    await a.waitFor((e) => e.type === 'inject');
    a.disconnect();
    await tick();

    const b = await sse();
    const again = await b.waitFor((e) => e.type === 'inject');
    expect(again).toMatchObject({ jobId: 'J7' });
    await post('/claude-app/ack', { jobId: 'J7', ok: true });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('abort 之后不再等回执', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const ac = new AbortController();
    const p = bus.dispatchInject({ jobId: 'J8', localId: 'l', text: 'x' }, { ackTimeoutMs: 5_000, signal: ac.signal });
    await c.waitFor((e) => e.type === 'inject');
    ac.abort();
    await expect(p).resolves.toMatchObject({ ok: false, code: 'claude-app-aborted' });
  });
});

describe('resolve —— localId 懒解析', () => {
  it('派发 resolve → 网关回报 localId', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const p = bus.dispatchResolve({ jobId: 'R1', cwd: '/inbox/a' });
    const ev = await c.waitFor((e) => e.type === 'resolve');
    expect(ev).toMatchObject({ type: 'resolve', jobId: 'R1', cwd: '/inbox/a' });
    await post('/claude-app/resolve', { jobId: 'R1', cwd: '/inbox/a', localId: 'local_abc' });
    await expect(p).resolves.toMatchObject({ ok: true, localId: 'local_abc' });
  });

  it('网关说找不到(localId=null)也是一次有效回报', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const p = bus.dispatchResolve({ jobId: 'R2', cwd: '/inbox/b' });
    await c.waitFor((e) => e.type === 'resolve');
    await post('/claude-app/resolve', { jobId: 'R2', cwd: '/inbox/b', localId: null });
    await expect(p).resolves.toMatchObject({ ok: true, localId: null });
  });
});

describe('心跳 —— WarmLifecycle 900s 会放倒空闲网关', () => {
  it('pulse 广播给所有连接,seq 递增', async () => {
    const a = await sse();
    const b = await sse();
    await a.waitFor((e) => e.type === 'hello');
    await b.waitFor((e) => e.type === 'hello');
    bus.pulse();
    bus.pulse();
    const ha = (await a.waitFor((e) => e.type === 'heartbeat' && e.seq === 2)) as Extract<GatewayEvent, { type: 'heartbeat' }>;
    await b.waitFor((e) => e.type === 'heartbeat' && e.seq === 2);
    expect(ha.seq).toBe(2);
  });

  it('startHeartbeat 按间隔自己打,close 之后停', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    bus.startHeartbeat(15);
    await c.waitFor((e) => e.type === 'heartbeat' && e.seq >= 2, 2_000);
    bus.stopHeartbeat();
    const seen = c.events.filter((e) => e.type === 'heartbeat').length;
    await tick(60);
    expect(c.events.filter((e) => e.type === 'heartbeat').length).toBe(seen);
  });
});

describe('回执端点的边角', () => {
  it('不认识的 jobId 不算致命(网关重挂后可能补发旧回执)', async () => {
    const r = await post('/claude-app/ack', { jobId: 'ghost', ok: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false });
  });

  it('body 不是 JSON → 400', async () => {
    const r = await post('/claude-app/ack', '{ 半个');
    expect(r.status).toBe(400);
  });

  it('缺 jobId → 400', async () => {
    const r = await post('/claude-app/ack', { ok: true });
    expect(r.status).toBe(400);
  });

  it('GET 打到 ack 上 → 405', async () => {
    expect((await get('/claude-app/ack')).status).toBe(405);
  });

  it('不归自己管的路径原样放行(健康检查还得能用)', async () => {
    expect((await get('/health')).status).toBe(404); // 这个测试服务器没接 /health,由外层 404
    expect(bus.handleRequest({ url: '/health', method: 'GET' } as any, {} as any)).toBe(false);
  });
});

describe('GET /claude-app/status —— 运维看板', () => {
  it('给出连接数 / 在途 job / 最近一次 ack 耗时', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const p = bus.dispatchInject({ jobId: 'S1', localId: 'l', text: 'x' });
    await c.waitFor((e) => e.type === 'inject');

    const mid = await get('/claude-app/status');
    expect(mid.json).toMatchObject({ connected: true, connections: 1, pending: 1 });

    await post('/claude-app/ack', { jobId: 'S1', ok: true });
    await p;
    const done = await get('/claude-app/status');
    expect(done.json.pending).toBe(0);
    expect(done.json.totalAcked).toBe(1);
    expect(typeof done.json.lastAckMs).toBe('number');
  });
});

describe('POST /claude-app/test-send —— 不连微信也能走全链', () => {
  it('默认没接处理器时 503,把话说明白', async () => {
    const r = await post('/claude-app/test-send', { text: 'hi' });
    expect(r.status).toBe(503);
    expect(String(r.json?.error ?? '')).toContain('test-send');
  });

  it('接上处理器后把请求交给它,并把结果回给调用方', async () => {
    const seen: any[] = [];
    bus.setTestSend(async (payload) => {
      seen.push(payload);
      return { ok: true, text: '走完了' };
    });
    const r = await post('/claude-app/test-send', { text: '你好', conversationId: 'probe-1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, text: '走完了' });
    expect(seen[0]).toMatchObject({ text: '你好', conversationId: 'probe-1' });
  });

  it('处理器抛异常 → 500 + 原因,不把 daemon 带崩', async () => {
    bus.setTestSend(async () => {
      throw new Error('后端炸了');
    });
    const r = await post('/claude-app/test-send', { text: 'x' });
    expect(r.status).toBe(500);
    expect(String(r.json?.error ?? '')).toContain('后端炸了');
  });

  it('没有 text → 400', async () => {
    bus.setTestSend(async () => ({ ok: true, text: 'x' }));
    expect((await post('/claude-app/test-send', {})).status).toBe(400);
  });
});

describe('attach —— 挂到已有的 http server 上(不抢别人的路由)', () => {
  it('原来的处理器还在,claude-app 的路径归 bus', async () => {
    const other = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ from: 'health' }));
    });
    other.listen(0, '127.0.0.1');
    await new Promise<void>((r) => other.once('listening', () => r()));
    const p2 = (other.address() as AddressInfo).port;
    const bus2 = new GatewayBus({});
    bus2.attach(other);

    const health = await new Promise<any>((resolve) => {
      http.get({ host: '127.0.0.1', port: p2, path: '/health' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      });
    });
    expect(health).toEqual({ from: 'health' });

    const st = await new Promise<any>((resolve) => {
      http.get({ host: '127.0.0.1', port: p2, path: '/claude-app/status' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      });
    });
    expect(st).toMatchObject({ connected: false });

    bus2.close();
    await new Promise<void>((r) => other.close(() => r()));
  });
});

describe('close —— 停机', () => {
  it('断开所有连接,在途 job 明确失败而不是永远挂着', async () => {
    const c = await sse();
    await c.waitFor((e) => e.type === 'hello');
    const p = bus.dispatchInject({ jobId: 'C1', localId: 'l', text: 'x' }, { ackTimeoutMs: 10_000 });
    await c.waitFor((e) => e.type === 'inject');
    bus.close();
    await expect(p).resolves.toMatchObject({ ok: false, code: 'claude-app-bus-closed' });
    expect(bus.gatewayConnected()).toBe(false);
  });
});
