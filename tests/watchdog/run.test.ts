import { describe, it, expect, afterEach } from 'vitest';

import { runOnce } from '../../src/watchdog/run.js';
import { emptyState } from '../../src/watchdog/state.js';
import { createFeishuNotifier } from '../../src/watchdog/notify.js';
import { collectorMock, healthMock, okHealth, startMock, turns, type MockServer } from './harness.js';
import type { Notifier, WatchdogConfig, WatchdogState } from '../../src/watchdog/types.js';

const servers: MockServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function mock(handler: Parameters<typeof startMock>[0]) {
  const s = await startMock(handler);
  servers.push(s);
  return s;
}

function memoryState(initial: WatchdogState = emptyState()) {
  let cur = initial;
  return {
    get value() {
      return cur;
    },
    load: () => cur,
    save: (s: WatchdogState) => {
      // 模拟真实落盘：序列化一遍，防止测试靠对象引用"作弊"
      cur = JSON.parse(JSON.stringify(s)) as WatchdogState;
    },
  };
}

const cfg = (port: number): WatchdogConfig => ({
  machine: 'mini',
  webhook: 'unused',
  daemons: [{ name: 'codex-18087', port }],
  heartbeatHour: 9,
});

const at = (h: number, m = 0) => new Date(2026, 7, 20, h, m, 0, 0);

describe('runOnce 端到端（真 http /health + 真 webhook mock）', () => {
  it('全绿：不发报警，日志写一行', async () => {
    const health = await mock(healthMock(okHealth));
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    const logs: string[] = [];

    const r = await runOnce({
      config: cfg(health.port),
      now: () => at(3),
      state: memoryState(),
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
      log: (l) => logs.push(l),
    });

    expect(r.probes[0].status).toBe('ok');
    expect(posted).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('codex-18087=ok');
    expect(logs[0]).toContain('alerts sent=0 failed=0');
  });

  it('daemon 挂了：飞书真的收到一条文本消息', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));

    const r = await runOnce({
      config: cfg(1), // 1 端口不会有人听
      now: () => at(3),
      state: memoryState(),
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
    });

    expect(r.probes[0].status).toBe('down');
    expect(posted).toHaveLength(1);
    const payload = JSON.parse(posted[0].body);
    expect(payload.msg_type).toBe('text');
    expect(payload.content.text).toContain('mini');
    expect(payload.content.text).toContain('codex-18087');
    expect(payload.content.text).toContain('down');
  });

  it('agentHealth.ok=false → degraded 报警文案带 detail', async () => {
    const health = await mock(
      healthMock({ ...okHealth, agentHealth: { ok: false, detail: 'app-server 没起来' } }),
    );
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));

    await runOnce({
      config: cfg(health.port),
      now: () => at(3),
      state: memoryState(),
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
    });

    expect(JSON.parse(posted[0].body).content.text).toContain('app-server 没起来');
  });

  it('连续 5 轮 error → error-streak 报警', async () => {
    const health = await mock(
      healthMock({ ...okHealth, turns: turns('error', 'error', 'error', 'error', 'error') }),
    );
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));

    const r = await runOnce({
      config: cfg(health.port),
      now: () => at(3),
      state: memoryState(),
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
    });

    expect(r.probes[0].status).toBe('error-streak');
    expect(JSON.parse(posted[0].body).content.text).toContain('error-streak');
  });

  it('飞书发送失败：不 crash、记日志、状态不推进（下一轮重试）', async () => {
    const state = memoryState();
    const broken: Notifier = { send: async () => { throw new Error('ECONNREFUSED feishu'); } };
    const logs: string[] = [];

    const r = await runOnce({
      config: cfg(1),
      now: () => at(3),
      state,
      notifier: broken,
      log: (l) => logs.push(l),
    });

    expect(r.failed).toBe(1);
    expect(r.sent).toHaveLength(0);
    expect(logs.some((l) => l.includes('notify FAILED'))).toBe(true);
    expect(state.value.daemons['codex-18087'].lastNotifiedAt).toBeUndefined();

    // 下一轮（2 分钟后）应该重试，而不是被 30 分钟窗口吞掉
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    const r2 = await runOnce({
      config: cfg(1),
      now: () => at(3, 2),
      state,
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
    });
    expect(r2.sent).toHaveLength(1);
    expect(state.value.daemons['codex-18087'].lastNotifiedAt).toBeDefined();
  });

  it('挂 → 恢复：两轮各一条，收敛窗口内不重复', async () => {
    const state = memoryState();
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    const notifier = createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`);

    await runOnce({ config: cfg(1), now: () => at(3, 0), state, notifier });
    await runOnce({ config: cfg(1), now: () => at(3, 2), state, notifier });
    expect(posted).toHaveLength(1);

    const health = await mock(healthMock(okHealth));
    const r = await runOnce({ config: cfg(health.port), now: () => at(3, 10), state, notifier });
    expect(r.sent).toHaveLength(1);
    expect(posted).toHaveLength(2);
    expect(JSON.parse(posted[1].body).content.text).toContain('已恢复');
  });

  it('每日心跳走的是同一条 webhook（报警管道自证还活着）', async () => {
    const health = await mock(healthMock(okHealth));
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));

    const r = await runOnce({
      config: cfg(health.port),
      now: () => at(9, 5),
      state: memoryState(),
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
    });

    expect(r.heartbeat).toBe(true);
    expect(JSON.parse(posted[0].body).content.text).toContain('心跳');
  });

  it('dry-run：只算不发也不落状态', async () => {
    const state = memoryState();
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));

    const r = await runOnce({
      config: cfg(1),
      now: () => at(3),
      state,
      dryRun: true,
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
    });

    expect(r.sent).toHaveLength(1);
    expect(posted).toHaveLength(0);
    expect(state.value.daemons['codex-18087']).toBeUndefined();
  });

  it('多 daemon 并行探测，一条挂不影响另一条的判定', async () => {
    const good = await mock(healthMock(okHealth));
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));

    const r = await runOnce({
      config: {
        machine: 'mini',
        webhook: 'unused',
        daemons: [
          { name: 'good', port: good.port },
          { name: 'bad', port: 1 },
        ],
        heartbeatHour: 9,
      },
      now: () => at(3),
      state: memoryState(),
      notifier: createFeishuNotifier(`http://127.0.0.1:${hookSrv.port}/hook`),
    });

    expect(r.probes.map((p) => `${p.name}=${p.status}`)).toEqual(['good=ok', 'bad=down']);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].body).content.text).toContain('bad');
  });
});
