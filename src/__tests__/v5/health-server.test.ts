import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';

import { startHealthServer } from '../../v5/core/health-server.js';

type Resp = { status: number; body: string; headers: Record<string, string | string[] | undefined> };

function request(port: number, method: string, path: string, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: body ? { 'Content-Length': Buffer.byteLength(body) } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers as any }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('startHealthServer', () => {
  let server: http.Server;
  let port: number;
  const delivery = { name: 'tmux', closeSession: vi.fn().mockResolvedValue(undefined) };
  const deps = {
    account: { accountId: 'acc-1' } as any,
    delivery: delivery as any,
    backend: { name: 'claude-code' } as any,
    startedAt: '2026-04-14T00:00:00.000Z',
    cwd: '/work',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    server = startHealthServer(0, deps);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /health returns 200 + JSON with expected fields', async () => {
    const r = await request(port, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(body.status).toBe('running');
    expect(body.version).toBe('v5');
    expect(body.account).toBe('acc-1');
    expect(body.delivery).toBe('tmux');
    expect(body.backend).toBe('claude-code');
    expect(body.startedAt).toBe('2026-04-14T00:00:00.000Z');
    expect(body.cwd).toBe('/work');
    expect(typeof body.uptime).toBe('number');
  });

  it('POST /close-session calls delivery.closeSession with decoded userId', async () => {
    const ctxPath = `/tmp/cc2wechat-test-${Date.now()}.json`;
    fs.writeFileSync(ctxPath, JSON.stringify({ userId: 'user-9' }));
    try {
      const r = await request(port, 'POST', '/close-session', JSON.stringify({ contextPath: ctxPath }));
      expect(r.status).toBe(200);
      expect(r.body).toBe('ok');
      // closeSession is dispatched async inside handler; give the microtask a tick
      await new Promise((res) => setImmediate(res));
      expect(delivery.closeSession).toHaveBeenCalledWith('user-9');
    } finally {
      fs.unlinkSync(ctxPath);
    }
  });

  it('POST /close-session with bad body returns 400', async () => {
    const r = await request(port, 'POST', '/close-session', 'not-json');
    expect(r.status).toBe(400);
  });

  it('POST /close-session with body missing contextPath returns 400', async () => {
    const r = await request(port, 'POST', '/close-session', JSON.stringify({}));
    expect(r.status).toBe(400);
    await new Promise((res) => setImmediate(res));
    expect(delivery.closeSession).not.toHaveBeenCalled();
  });

  it('POST /close-session with contextPath pointing to nonexistent file returns 404', async () => {
    const missing = `/tmp/cc2wechat-missing-${Date.now()}-${Math.random()}.json`;
    const r = await request(port, 'POST', '/close-session', JSON.stringify({ contextPath: missing }));
    expect(r.status).toBe(404);
    await new Promise((res) => setImmediate(res));
    expect(delivery.closeSession).not.toHaveBeenCalled();
  });

  it('GET /other returns 404', async () => {
    const r = await request(port, 'GET', '/something-else');
    expect(r.status).toBe(404);
  });
});
