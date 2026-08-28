import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main, parseArgs } from '../../src/watchdog/cli.js';
import { collectorMock, healthMock, okHealth, startMock, type MockServer } from './harness.js';

const servers: MockServer[] = [];
let home: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-cli-'));
  fs.mkdirSync(path.join(home, '.cc2wechat'), { recursive: true });
  process.env.CC2WECHAT_WATCHDOG_CONFIG = path.join(home, '.cc2wechat', 'watchdog.json');
  process.env.CC2WECHAT_WATCHDOG_STATE = path.join(home, '.cc2wechat', 'watchdog-state.json');
  process.env.CC2WECHAT_WATCHDOG_LOG = path.join(home, '.cc2wechat', 'watchdog.log');
  process.env.CC2WECHAT_WATCHDOG_EXPIRY = path.join(home, '.cc2wechat', 'credentials-expiry.json');
});

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  for (const k of ['CC2WECHAT_WATCHDOG_CONFIG', 'CC2WECHAT_WATCHDOG_STATE', 'CC2WECHAT_WATCHDOG_LOG', 'CC2WECHAT_WATCHDOG_EXPIRY']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

async function mock(handler: Parameters<typeof startMock>[0]) {
  const s = await startMock(handler);
  servers.push(s);
  return s;
}

function writeConfig(cfg: Record<string, unknown>) {
  fs.writeFileSync(process.env.CC2WECHAT_WATCHDOG_CONFIG!, JSON.stringify(cfg, null, 2));
}

describe('cli 参数', () => {
  it('parseArgs', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true, testAlert: false });
    expect(parseArgs(['--test-alert'])).toMatchObject({ testAlert: true });
    expect(parseArgs(['-h'])).toMatchObject({ help: true });
    expect(parseArgs([])).toMatchObject({ dryRun: false, testAlert: false, status: false, help: false });
  });

  it('--help 退 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--help'])).toBe(0);
  });
});

describe('cli 集成冒烟（临时 HOME + 假 config 跑完整一轮）', () => {
  it('daemon 挂了：飞书收到消息、状态文件落盘、日志写了一行', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    writeConfig({
      machine: 'test-box',
      webhook: `http://127.0.0.1:${hookSrv.port}/open-apis/bot/v2/hook/fake`,
      daemons: [{ name: 'codex-18087', port: 1 }],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main([])).toBe(0);

    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].body).content.text).toContain('test-box');

    const state = JSON.parse(fs.readFileSync(process.env.CC2WECHAT_WATCHDOG_STATE!, 'utf-8'));
    expect(state.daemons['codex-18087'].status).toBe('down');
    expect(state.daemons['codex-18087'].lastNotifiedAt).toBeGreaterThan(0);

    const log = fs.readFileSync(process.env.CC2WECHAT_WATCHDOG_LOG!, 'utf-8');
    expect(log).toContain('codex-18087=down');
    expect(logSpy).toHaveBeenCalled();
  });

  it('daemon 正常：不打扰任何人', async () => {
    const health = await mock(healthMock(okHealth));
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    writeConfig({
      machine: 'test-box',
      webhook: `http://127.0.0.1:${hookSrv.port}/hook`,
      daemons: [{ name: 'codex-18087', port: health.port }],
      // 心跳设成 23 点，避开测试真实时间点误触发
      heartbeatHour: 23,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main([])).toBe(0);
    if (new Date().getHours() < 23) expect(posted).toHaveLength(0);
    expect(fs.readFileSync(process.env.CC2WECHAT_WATCHDOG_LOG!, 'utf-8')).toContain('codex-18087=ok');
  });

  it('凭证过期表被读到并报警', async () => {
    const health = await mock(healthMock(okHealth));
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    writeConfig({
      machine: 'test-box',
      webhook: `http://127.0.0.1:${hookSrv.port}/hook`,
      daemons: [{ name: 'codex-18087', port: health.port }],
      heartbeatHour: 23,
    });
    fs.writeFileSync(
      process.env.CC2WECHAT_WATCHDOG_EXPIRY!,
      JSON.stringify([{ name: 'ilink-token', expiresAt: '2020-01-01', note: '早过期了' }]),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main([])).toBe(0);
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted.some((p) => JSON.parse(p.body).content.text.includes('ilink-token'))).toBe(true);
  });

  it('--dry-run 不发消息也不落状态', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    writeConfig({
      machine: 'test-box',
      webhook: `http://127.0.0.1:${hookSrv.port}/hook`,
      daemons: [{ name: 'codex-18087', port: 1 }],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main(['--dry-run'])).toBe(0);
    expect(posted).toHaveLength(0);
    expect(fs.existsSync(process.env.CC2WECHAT_WATCHDOG_STATE!)).toBe(false);
  });

  it('--test-alert 直接打一条到 webhook', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const hookSrv = await mock(collectorMock(posted));
    writeConfig({
      machine: 'test-box',
      webhook: `http://127.0.0.1:${hookSrv.port}/hook`,
      daemons: [{ name: 'codex-18087', port: 1 }],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main(['--test-alert'])).toBe(0);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0].body).content.text).toContain('测试消息');
  });

  it('配置缺失 → 退 1 并说清楚去哪找', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main([])).toBe(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('配置不存在');
  });

  it('配置字段不全 → 退 1，不是半死不活地跑', async () => {
    fs.writeFileSync(process.env.CC2WECHAT_WATCHDOG_CONFIG!, JSON.stringify({ machine: 'x' }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main([])).toBe(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('webhook');
  });

  it('--status 打印状态文件', async () => {
    writeConfig({ machine: 'test-box', webhook: 'http://127.0.0.1:1/hook', daemons: [{ name: 'd', port: 1 }] });
    fs.writeFileSync(
      process.env.CC2WECHAT_WATCHDOG_STATE!,
      JSON.stringify({ version: 1, daemons: { d: { status: 'down', since: 1 } }, expiryNotified: {} }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--status'])).toBe(0);
    expect(String(logSpy.mock.calls[0][0])).toContain('down');
  });
});
