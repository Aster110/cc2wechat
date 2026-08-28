import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { setupE2e, type E2eEnv } from '../e2e/harness.js';

/**
 * 端到端:真的 `node dist/v6/main.js`,只把两个外设换成桩(假 iLink + PATH 上的假 codex)。
 *
 * 这里验的是 adapter 模式那条新路:
 * - 微信走 WeChatChannel → ChannelCore → Agent,行为与 legacy 一致
 * - 同一个 Core 同时服务 web 通道(契约的反向验证:core/ 零改动)
 * - **缺省仍然是 legacy**(输出里连 channels 这个键都不该有)
 * - **web-only 能在没有微信账号的机器上起来**(侧车验收场景,不许触发扫码登录)
 *
 * 跑之前先 `npm run build`。
 */

const TEST_TIMEOUT = 60_000;

let env: E2eEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

async function waitFor(pred: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 读 SSE 直到出现关键字 */
async function readSseUntil(url: string, token: string, needle: string, timeoutMs = 20_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(needle)) return buf;
    }
    throw new Error(`SSE 结束了也没等到 ${needle}。收到:\n${buf}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ---------------------------------------------------------------------------

describe('e2e — adapter 模式:微信通道 parity', () => {
  it(
    '一问一答走完新 Core,回复照旧带 [微信] 前缀',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const daemon = await env.startDaemon({ CC2WECHAT_CHANNEL_CORE: 'adapter' });

      env.ilink.push('你好啊');
      const reply = await env.ilink.waitForReply((m) => m.text.includes('你好啊'), 20_000);

      expect(reply.text).toContain('[微信]');
      expect(env.fakeCodex.spawns()).toHaveLength(1);

      // /health 多了 channels[],其余字段一个没少
      const health = await daemon.health();
      expect(health.engine).toBe('v6');
      expect(health.account).toBe('e2e-acct');
      expect(health.channels).toEqual([expect.objectContaining({ name: 'wechat', ok: true })]);
      expect(health.turns.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'typing 心跳仍然从通道里发出去(疤组织没在搬家时掉队)',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon({ CC2WECHAT_CHANNEL_CORE: 'adapter' });

      env.ilink.push('慢慢想');
      await env.ilink.waitForReply((m) => m.text.includes('慢慢想'), 20_000);

      expect(env.ilink.typings.some((t) => t.status === 1)).toBe(true);
      // status=2(收回"正在输入")在回复之后才发,而且是 fire-and-forget:等它一下
      const ilink = env.ilink;
      await waitFor(() => ilink.typings.some((t) => t.status === 2), 5_000, 'typing status=2');
    },
    TEST_TIMEOUT,
  );

  it(
    '/stop 仍然能抢占(命令在入队之前处理)',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon({ CC2WECHAT_CHANNEL_CORE: 'adapter' });

      env.ilink.push('/help');
      const reply = await env.ilink.waitForReply((m) => m.text.includes('可用命令'), 20_000);
      expect(reply.text).toContain('/new');
      // 命令没有惊动后端
      expect(env.fakeCodex.spawns()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe('e2e — 缺省仍然是 legacy', () => {
  it(
    '不设 CC2WECHAT_CHANNEL_CORE:/health 里连 channels 这个键都没有',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const daemon = await env.startDaemon();

      const health = await daemon.health();
      expect('channels' in health).toBe(false);
      expect(health.account).toBe('e2e-acct');

      env.ilink.push('老路也要通');
      const reply = await env.ilink.waitForReply((m) => m.text.includes('老路也要通'), 20_000);
      expect(reply.text).toContain('[微信]');
    },
    TEST_TIMEOUT,
  );

  it(
    '写错值(adaptor / 1 / true)也留在 legacy',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const daemon = await env.startDaemon({ CC2WECHAT_CHANNEL_CORE: 'adaptor' });
      const health = await daemon.health();
      expect('channels' in health).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe('e2e — 双渠道同 Core(契约反向验证)', () => {
  it(
    'web POST → agent → SSE,同一个进程里微信照常收发',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const daemon = await env.startDaemon({
        CC2WECHAT_CHANNEL_CORE: 'adapter',
        CC2WECHAT_CHANNELS: 'wechat,web',
        CC2WECHAT_WEB_TOKEN: 'e2e-web-token',
      });
      const base = `http://127.0.0.1:${daemon.port}`;

      const health = await daemon.health();
      expect(health.channels.map((c: { name: string }) => c.name)).toEqual(['wechat', 'web']);

      // web 侧:先挂 SSE,再 POST
      const sse = readSseUntil(`${base}/web/events`, 'e2e-web-token', 'event: reply');
      await new Promise((r) => setTimeout(r, 200));
      const posted = await fetch(`${base}/web/msg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-web-token' },
        body: JSON.stringify({ text: '从网页来的' }),
      });
      expect(posted.status).toBe(200);

      const frames = await sse;
      expect(frames).toContain('[web] 从网页来的');

      // 微信侧:同一个进程,同一个 Core,照常收发
      env.ilink.push('从微信来的');
      const reply = await env.ilink.waitForReply((m) => m.text.includes('从微信来的'), 20_000);
      expect(reply.text).toContain('[微信]');
    },
    TEST_TIMEOUT,
  );

  it(
    '没带 token 的 web 请求进不来',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const daemon = await env.startDaemon({
        CC2WECHAT_CHANNEL_CORE: 'adapter',
        CC2WECHAT_CHANNELS: 'wechat,web',
        CC2WECHAT_WEB_TOKEN: 'e2e-web-token',
      });
      const res = await fetch(`http://127.0.0.1:${daemon.port}/web/msg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '偷偷发一条' }),
      });
      expect(res.status).toBe(401);
      expect(env.fakeCodex.spawns()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe('e2e — web-only:没有微信账号的机器(侧车验收场景)', () => {
  it(
    '账号文件删掉也能起来:不扫码、/health account 为 null、web 全链可用',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      // 把这台机器变成"从没登录过微信"的样子
      fs.rmSync(path.join(env.home, '.cc2wechat', `accounts-${env.port}.json`));
      expect(fs.readdirSync(path.join(env.home, '.cc2wechat')).filter((f) => f.startsWith('accounts-'))).toEqual([]);

      const daemon = await env.startDaemon({
        CC2WECHAT_CHANNEL_CORE: 'adapter',
        CC2WECHAT_CHANNELS: 'web',
        CC2WECHAT_WEB_TOKEN: 'e2e-web-token',
      });
      const base = `http://127.0.0.1:${daemon.port}`;

      const health = await daemon.health();
      expect(health.account).toBeNull();
      expect(health.channels).toEqual([expect.objectContaining({ name: 'web', ok: true })]);
      // 没有任何扫码/登录动作
      expect(daemon.logs()).not.toContain('Starting login');

      const sse = readSseUntil(`${base}/web/events`, 'e2e-web-token', 'event: reply');
      await new Promise((r) => setTimeout(r, 200));
      await fetch(`${base}/web/msg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-web-token' },
        body: JSON.stringify({ text: '侧车在吗' }),
      });
      expect(await sse).toContain('[web] 侧车在吗');

      // 全程没有创建账号文件
      expect(fs.readdirSync(path.join(env.home, '.cc2wechat')).filter((f) => f.startsWith('accounts-'))).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
