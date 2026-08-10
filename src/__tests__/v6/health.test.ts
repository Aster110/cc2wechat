import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { startV6HealthServer, packageVersion, probeAgentHealth } from '../../v6/health.js';
import { TurnRingBuffer } from '../../v6/poller.js';
import { InMemoryScheduler } from '../../v6/scheduler.js';

function get(port: number, urlPath: string, host = '127.0.0.1'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'GET', path: urlPath }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;
let port: number;
let scheduler: InMemoryScheduler;
let turns: TurnRingBuffer;

const agent = {
  name: 'codex',
  persistent: false,
  health: async () => ({ ok: true, detail: 'app-server up' }),
} as any;

beforeEach(async () => {
  scheduler = new InMemoryScheduler({ maxConcurrent: 2, onError: () => {} });
  turns = new TurnRingBuffer(20);
  server = startV6HealthServer(0, {
    account: { accountId: 'acc-1' } as any,
    agent,
    scheduler,
    turns,
    cwd: '/work',
    startedAt: '2026-08-10T00:00:00.000Z',
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('startV6HealthServer — 只听 127.0.0.1(安全硬要求)', () => {
  it('绑定地址是回环,不是 0.0.0.0', () => {
    // 服务器无防火墙,0.0.0.0 = 把账号信息端到公网上
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('本机以外的网卡地址连不上', async () => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!external) return; // 没有外网卡就跳过

    await expect(
      new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: external, port, timeout: 800 });
        sock.on('connect', () => {
          sock.destroy();
          resolve('connected');
        });
        sock.on('error', reject);
        sock.on('timeout', () => {
          sock.destroy();
          reject(new Error('timeout'));
        });
      }),
    ).rejects.toBeTruthy();
  });
});

describe('GET /health', () => {
  it('返回 v6 引擎信息与真实包版本', async () => {
    const r = await get(port, '/health');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.status).toBe('running');
    expect(body.engine).toBe('v6');
    expect(body.account).toBe('acc-1');
    expect(body.agent).toBe('codex');
    expect(body.persistent).toBe(false);
    expect(body.cwd).toBe('/work');
    expect(body.startedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(typeof body.uptime).toBe('number');

    const realVersion = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
    ).version;
    expect(body.version).toBe(realVersion);
    expect(body.version).not.toBe('v6'); // v5 那种写死字符串的做法不要了
  });

  it('带上调度器实时状态', async () => {
    scheduler.enqueue('c1', () => new Promise(() => {}));
    scheduler.enqueue('c1', async () => {});
    const body = JSON.parse((await get(port, '/health')).body);
    expect(body.scheduler).toEqual({ running: 1, queued: 1 });
    scheduler.clear('c1');
  });

  it('带上最近 N 轮的耗时', async () => {
    turns.push({
      conversationId: 'conv-1',
      agent: 'codex',
      queueMs: 1,
      firstEventMs: 2,
      totalMs: 3,
      outcome: 'final',
      endedAt: 12345,
    });
    const body = JSON.parse((await get(port, '/health')).body);
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]).toMatchObject({ conversationId: 'conv-1', outcome: 'final', totalMs: 3 });
  });
});

describe('agentHealth —— "活着" 不等于 "能用"', () => {
  it('/health 带上后端自报的健康状态', async () => {
    const body = JSON.parse((await get(port, '/health')).body);
    expect(body.agentHealth).toEqual({ ok: true, detail: 'app-server up' });
  });

  it('后端 1 秒答不上来就当不健康 —— 微信那头一样是在干等', async () => {
    const hung = { name: 'codex', health: () => new Promise(() => {}) } as any;
    const r = await probeAgentHealth(hung, 30);
    expect(r).toEqual({ ok: false, detail: 'timeout' });
  });

  it('health() 抛异常不该把 /health 一起带崩', async () => {
    const broken = { name: 'codex', health: async () => { throw new Error('socket closed'); } } as any;
    const r = await probeAgentHealth(broken, 100);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('socket closed');
  });

  it('没实现 health() 的 agent 不算故障', async () => {
    expect(await probeAgentHealth({ name: 'legacy' } as any, 50)).toEqual({
      ok: true,
      detail: 'agent 未实现 health()',
    });
  });

  it('降级中的后端会如实上报', async () => {
    const degraded = { name: 'codex', health: async () => ({ ok: false, detail: 'degraded → codex-exec(起不来)' }) } as any;
    const r = await probeAgentHealth(degraded, 100);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('degraded');
  });
});

describe('其他路由', () => {
  it('v6 不提供 /close-session', async () => {
    expect((await get(port, '/close-session')).status).toBe(404);
  });

  it('未知路径 404', async () => {
    expect((await get(port, '/whatever')).status).toBe(404);
  });
});

describe('packageVersion', () => {
  it('读得到真实版本号', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
