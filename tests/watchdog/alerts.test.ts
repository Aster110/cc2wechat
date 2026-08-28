import { describe, it, expect } from 'vitest';

import { CONVERGE_MS, dayKey, formatDuration, planAlerts } from '../../src/watchdog/alerts.js';
import { emptyState } from '../../src/watchdog/state.js';
import type { ExpiryFinding, ProbeResult, WatchdogConfig, WatchdogState } from '../../src/watchdog/types.js';

const config: WatchdogConfig = {
  machine: 'macbook-air',
  webhook: 'http://127.0.0.1:1/hook',
  daemons: [{ name: 'codex-18087', port: 18087 }],
  heartbeatHour: 9,
};

/** 固定在本地时区的某一天，避免 UTC/本地混用把心跳小时数算错 */
const at = (hour: number, minute = 0, day = 20) => new Date(2026, 7, day, hour, minute, 0, 0);

const probe = (status: ProbeResult['status'], detail = 'x'): ProbeResult[] => [
  { name: 'codex-18087', port: 18087, status, detail },
];

function step(
  state: WatchdogState,
  probes: ProbeResult[],
  now: Date,
  opts: { expiry?: ExpiryFinding[]; deliver?: boolean } = {},
) {
  const out = planAlerts({ config, probes, expiry: opts.expiry ?? [], state, now });
  // deliver=false 模拟"飞书发失败"：状态机不推进去重时间戳
  if (opts.deliver !== false) for (const a of out.alerts) a.commit(state, now);
  return out;
}

describe('报警状态机 · 30 分钟收敛', () => {
  it('首次故障立刻报', () => {
    const s = emptyState();
    const { alerts } = step(s, probe('down', '连接失败: fetch failed'), at(10));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('fault');
    expect(alerts[0].text).toContain('macbook-air');
    expect(alerts[0].text).toContain('codex-18087');
    expect(alerts[0].text).toContain('down');
    expect(alerts[0].text).toContain('连接失败');
  });

  it('同一 daemon 同一类别 30 分钟内只发一条', () => {
    const s = emptyState();
    step(s, probe('down'), at(10, 0));
    expect(step(s, probe('down'), at(10, 2)).alerts).toHaveLength(0);
    expect(step(s, probe('down'), at(10, 15)).alerts).toHaveLength(0);
    expect(step(s, probe('down'), at(10, 29)).alerts).toHaveLength(0);
  });

  it('故障持续满 30 分钟重发一条，带持续时长', () => {
    const s = emptyState();
    step(s, probe('down'), at(10, 0));
    const again = step(s, probe('down'), at(10, 30));
    expect(again.alerts).toHaveLength(1);
    expect(again.alerts[0].text).toContain('已持续: 30m');
    // 重发之后窗口重新开始
    expect(step(s, probe('down'), at(10, 45)).alerts).toHaveLength(0);
    const third = step(s, probe('down'), at(11, 1));
    expect(third.alerts).toHaveLength(1);
    expect(third.alerts[0].text).toContain('已持续: 1h1m');
  });

  it('换故障类别（down → degraded）立刻再报一条，不吃收敛窗口', () => {
    const s = emptyState();
    step(s, probe('down'), at(10, 0));
    const switched = step(s, probe('degraded', 'agentHealth.ok=false: timeout'), at(10, 5));
    expect(switched.alerts).toHaveLength(1);
    expect(switched.alerts[0].text).toContain('degraded');
  });

  it('发送失败不推进去重时间戳，下一轮立刻重试', () => {
    const s = emptyState();
    step(s, probe('down'), at(10, 0), { deliver: false });
    const retry = step(s, probe('down'), at(10, 2));
    expect(retry.alerts).toHaveLength(1);
  });

  it('CONVERGE_MS 就是 30 分钟', () => {
    expect(CONVERGE_MS).toBe(30 * 60 * 1000);
  });
});

// 恢复播报单独用凌晨的时间点，避开每日心跳（heartbeatHour=9）掺进来的那条
describe('报警状态机 · 恢复播报', () => {
  it('故障 → ok 发一条已恢复，带故障持续时长', () => {
    const s = emptyState();
    step(s, probe('down'), at(3, 0));
    const rec = step(s, probe('ok'), at(3, 12));
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0].kind).toBe('recovery');
    expect(rec.alerts[0].text).toContain('已恢复');
    expect(rec.alerts[0].text).toContain('12m');
  });

  it('一直 ok 不播报（看门狗只在有事时说话）', () => {
    const s = emptyState();
    expect(step(s, probe('ok'), at(3, 0)).alerts).toHaveLength(0);
    expect(step(s, probe('ok'), at(3, 2)).alerts).toHaveLength(0);
  });

  it('恢复消息没发出去 → 状态留在故障态，下一轮重播（时长从最初算起）', () => {
    const s = emptyState();
    step(s, probe('down'), at(3, 0));
    step(s, probe('ok'), at(3, 12), { deliver: false });
    const retry = step(s, probe('ok'), at(3, 14));
    expect(retry.alerts).toHaveLength(1);
    expect(retry.alerts[0].text).toContain('已恢复');
    expect(retry.alerts[0].text).toContain('14m');
    // 这次发出去了，就不该再有第三条
    expect(step(s, probe('ok'), at(3, 16)).alerts).toHaveLength(0);
  });

  it('恢复后再挂，重新算一轮完整报警', () => {
    const s = emptyState();
    step(s, probe('down'), at(3, 0));
    step(s, probe('ok'), at(3, 10));
    const again = step(s, probe('down'), at(3, 20));
    expect(again.alerts).toHaveLength(1);
    expect(again.alerts[0].kind).toBe('fault');
  });
});

describe('报警状态机 · 每日安好心跳', () => {
  it('heartbeatHour 之前不发', () => {
    const s = emptyState();
    const out = step(s, probe('ok'), at(8, 59));
    expect(out.heartbeat).toBe(false);
    expect(out.alerts).toHaveLength(0);
  });

  it('heartbeatHour 之后第一次全绿发一条，当天不再发', () => {
    const s = emptyState();
    const first = step(s, probe('ok'), at(9, 1));
    expect(first.heartbeat).toBe(true);
    expect(first.alerts[0].kind).toBe('heartbeat');
    expect(first.alerts[0].text).toContain('全部正常');
    expect(step(s, probe('ok'), at(9, 3)).alerts).toHaveLength(0);
    expect(step(s, probe('ok'), at(18, 0)).alerts).toHaveLength(0);
  });

  it('第二天再发一条', () => {
    const s = emptyState();
    step(s, probe('ok'), at(9, 1, 20));
    const nextDay = step(s, probe('ok'), at(9, 1, 21));
    expect(nextDay.heartbeat).toBe(true);
  });

  it('不全绿不发心跳；当天恢复后补发', () => {
    const s = emptyState();
    const broken = step(s, probe('down'), at(9, 30));
    expect(broken.heartbeat).toBe(false);
    expect(broken.alerts.every((a) => a.kind !== 'heartbeat')).toBe(true);
    const recovered = step(s, probe('ok'), at(9, 40));
    expect(recovered.heartbeat).toBe(true);
  });

  it('有凭证预警也不算全绿', () => {
    const s = emptyState();
    const expiry: ExpiryFinding[] = [
      { name: 'ilink-token', expiresAt: '2026-08-21', note: '', level: 'warn', daysLeft: 1 },
    ];
    const out = step(s, probe('ok'), at(9, 30), { expiry });
    expect(out.heartbeat).toBe(false);
  });

  it('心跳没发成功不写当天标记，下一轮重试', () => {
    const s = emptyState();
    step(s, probe('ok'), at(9, 1), { deliver: false });
    expect(s.lastHeartbeatDay).toBeUndefined();
    const retry = step(s, probe('ok'), at(9, 3));
    expect(retry.heartbeat).toBe(true);
    expect(s.lastHeartbeatDay).toBe(dayKey(at(9, 3)));
  });
});

describe('小工具', () => {
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(59 * 60 * 1000)).toBe('59m');
    expect(formatDuration(61 * 60 * 1000)).toBe('1h1m');
  });

  it('dayKey 走本地时区', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});
