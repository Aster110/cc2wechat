import { describe, it, expect, afterEach } from 'vitest';

import { classifyHealth, probeDaemon } from '../../src/watchdog/probe.js';
import { deadPort, healthMock, okHealth, startMock, turns, type MockServer } from './harness.js';

const servers: MockServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function mock(handler: Parameters<typeof startMock>[0]) {
  const s = await startMock(handler);
  servers.push(s);
  return s;
}

describe('classifyHealth（判定的唯一事实源）', () => {
  it('一切正常 → ok，并带出 account/uptime', () => {
    const c = classifyHealth(okHealth);
    expect(c.status).toBe('ok');
    expect(c.account).toBe('acc-1');
    expect(c.uptime).toBe(3600);
  });

  it('agentHealth.ok=false → degraded，detail 带上后端给的原因', () => {
    const c = classifyHealth({ ...okHealth, agentHealth: { ok: false, detail: 'app-server 降级成一次性 spawn' } });
    expect(c.status).toBe('degraded');
    expect(c.detail).toContain('app-server 降级');
  });

  it('最近 5 轮全 error → error-streak', () => {
    const c = classifyHealth({ ...okHealth, turns: turns('final', 'error', 'error', 'error', 'error', 'error') });
    expect(c.status).toBe('error-streak');
  });

  it('最近 5 轮里混了一个 final → 不算 streak', () => {
    const c = classifyHealth({ ...okHealth, turns: turns('error', 'error', 'final', 'error', 'error') });
    expect(c.status).toBe('ok');
  });

  it('不足 5 轮（哪怕全 error）不算 streak——刚起的 daemon 不该被误判', () => {
    const c = classifyHealth({ ...okHealth, turns: turns('error', 'error', 'error') });
    expect(c.status).toBe('ok');
  });

  it('turns 缺失 / 为 null 不炸', () => {
    expect(classifyHealth({ ...okHealth, turns: null }).status).toBe('ok');
    const { turns: _drop, ...noTurns } = okHealth;
    expect(classifyHealth(noTurns).status).toBe('ok');
  });

  it('degraded 优先于 error-streak（一次只报最严重那个）', () => {
    const c = classifyHealth({
      ...okHealth,
      agentHealth: { ok: false, detail: 'timeout' },
      turns: turns('error', 'error', 'error', 'error', 'error'),
    });
    expect(c.status).toBe('degraded');
  });

  it('status 不是 running/ok → down', () => {
    const c = classifyHealth({ ...okHealth, status: 'stopping' });
    expect(c.status).toBe('down');
    expect(c.detail).toContain('stopping');
  });

  it('body 不是对象 → down', () => {
    expect(classifyHealth('boom').status).toBe('down');
    expect(classifyHealth(null).status).toBe('down');
  });
});

describe('probeDaemon（真起 http server 打）', () => {
  it('200 + 正常 body → ok', async () => {
    const s = await mock(healthMock(okHealth));
    const r = await probeDaemon({ name: 'd', port: s.port });
    expect(r.status).toBe('ok');
    expect(r.name).toBe('d');
    expect(r.port).toBe(s.port);
  });

  it('200 + agentHealth.ok=false → degraded', async () => {
    const s = await mock(healthMock({ ...okHealth, agentHealth: { ok: false, detail: 'CODEX_HOME 串号' } }));
    const r = await probeDaemon({ name: 'd', port: s.port });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('CODEX_HOME');
  });

  it('200 + 连续 5 轮 error → error-streak', async () => {
    const s = await mock(healthMock({ ...okHealth, turns: turns('error', 'error', 'error', 'error', 'error') }));
    const r = await probeDaemon({ name: 'd', port: s.port });
    expect(r.status).toBe('error-streak');
  });

  it('非 200 → down', async () => {
    const s = await mock(healthMock({ oops: true }, 503));
    const r = await probeDaemon({ name: 'd', port: s.port });
    expect(r.status).toBe('down');
    expect(r.detail).toContain('503');
  });

  it('200 但不是 JSON → down', async () => {
    const s = await mock(healthMock('<html>gateway</html>'));
    const r = await probeDaemon({ name: 'd', port: s.port });
    expect(r.status).toBe('down');
    expect(r.detail).toContain('JSON');
  });

  it('连接被拒（进程没了）→ down', async () => {
    const port = await deadPort();
    const r = await probeDaemon({ name: 'd', port });
    expect(r.status).toBe('down');
    expect(r.detail).toContain('连接失败');
  });

  it('端口通但不回话（假死）→ 超时 down，不会永远挂着', async () => {
    const s = await mock(() => {
      /* 故意不回 */
    });
    const started = Date.now();
    const r = await probeDaemon({ name: 'd', port: s.port }, { timeoutMs: 150 });
    expect(r.status).toBe('down');
    expect(r.detail).toContain('超时');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
