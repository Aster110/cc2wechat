import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findExpiryIssues, readExpiryFile } from '../../src/watchdog/expiry.js';
import { planAlerts } from '../../src/watchdog/alerts.js';
import { emptyState } from '../../src/watchdog/state.js';
import type { ExpiryEntry, WatchdogConfig } from '../../src/watchdog/types.js';

const config: WatchdogConfig = {
  machine: 'mini',
  webhook: 'http://127.0.0.1:1/hook',
  daemons: [{ name: 'codex-18087', port: 18087 }],
  heartbeatHour: 9,
};

const entries: ExpiryEntry[] = [
  { name: 'ilink-token', expiresAt: '2026-09-20', note: '微信 iLink bot token' },
  { name: 'codex-key', expiresAt: '2026-12-31' },
];

describe('凭证到期检查', () => {
  it('距到期 3 天以上：什么都不报', () => {
    expect(findExpiryIssues(entries, new Date(2026, 8, 1))).toHaveLength(0);
  });

  it('距到期不足 3 天：预警', () => {
    const found = findExpiryIssues(entries, new Date(2026, 8, 18, 12));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('ilink-token');
    expect(found[0].level).toBe('warn');
    expect(found[0].daysLeft).toBe(1);
  });

  it('刚好 3 天：还不报（边界在 <3）', () => {
    const found = findExpiryIssues(entries, new Date(2026, 8, 17, 0, 0, 0));
    expect(found).toHaveLength(0);
  });

  it('已过期：报警', () => {
    const found = findExpiryIssues(entries, new Date(2026, 8, 21));
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe('expired');
    expect(found[0].daysLeft).toBeLessThan(0);
  });

  it('日期串坏掉的条目直接跳过，不影响别的条目', () => {
    const found = findExpiryIssues(
      [{ name: 'bad', expiresAt: '不是日期' }, ...entries],
      new Date(2026, 8, 21),
    );
    expect(found.map((f) => f.name)).toEqual(['ilink-token']);
  });

  it('YYYY-MM-DD 按本地午夜解析（不被 UTC 差成前一天）', () => {
    // 到期日当天的 00:00 本地 = 已经到期
    const found = findExpiryIssues([{ name: 'x', expiresAt: '2026-09-20' }], new Date(2026, 8, 20, 0, 0, 0));
    expect(found[0].level).toBe('expired');
    // 前一天 23:59 还是预警
    const warn = findExpiryIssues([{ name: 'x', expiresAt: '2026-09-20' }], new Date(2026, 8, 19, 23, 59));
    expect(warn[0].level).toBe('warn');
  });
});

describe('readExpiryFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-expiry-'));

  it('文件不存在 = 跳过（返回空）', () => {
    expect(readExpiryFile(path.join(dir, 'nope.json'))).toEqual([]);
  });

  it('坏 JSON = 跳过而不是 crash', () => {
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{{{');
    expect(readExpiryFile(f)).toEqual([]);
  });

  it('正常读，过滤掉缺字段的条目', () => {
    const f = path.join(dir, 'ok.json');
    fs.writeFileSync(f, JSON.stringify([...entries, { name: 'no-date' }, null]));
    const read = readExpiryFile(f);
    expect(read.map((e) => e.name)).toEqual(['ilink-token', 'codex-key']);
  });
});

describe('凭证提醒去重（每天最多一次）', () => {
  const probes = [{ name: 'codex-18087', port: 18087, status: 'ok' as const }];

  it('同一天只发一条，第二天再发', () => {
    const state = emptyState();
    const run = (now: Date) => {
      const expiry = findExpiryIssues(entries, now);
      const out = planAlerts({ config, probes, expiry, state, now });
      for (const a of out.alerts) a.commit(state, now);
      return out.alerts.filter((a) => a.kind === 'expiry');
    };

    expect(run(new Date(2026, 8, 18, 10))).toHaveLength(1);
    expect(run(new Date(2026, 8, 18, 10, 2))).toHaveLength(0);
    expect(run(new Date(2026, 8, 18, 23, 58))).toHaveLength(0);
    const nextDay = run(new Date(2026, 8, 19, 9));
    expect(nextDay).toHaveLength(1);
    expect(nextDay[0].text).toContain('ilink-token');
  });

  it('预警文案带天数，过期文案带"已过期"', () => {
    const state = emptyState();
    const warnNow = new Date(2026, 8, 18, 10);
    const warn = planAlerts({ config, probes, expiry: findExpiryIssues(entries, warnNow), state, now: warnNow });
    expect(warn.alerts[0].text).toContain('即将到期');
    expect(warn.alerts[0].text).toContain('微信 iLink bot token');

    const expiredNow = new Date(2026, 8, 25, 10);
    const s2 = emptyState();
    const expired = planAlerts({
      config,
      probes,
      expiry: findExpiryIssues(entries, expiredNow),
      state: s2,
      now: expiredNow,
    });
    expect(expired.alerts[0].text).toContain('已过期');
  });
});
