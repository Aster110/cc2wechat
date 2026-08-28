import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { WebChannel, readWebToken } from '../../../v6/channels/web-channel.js';
import { ChannelCore } from '../../../v6/channels/core.js';
import { ConversationService } from '../../../v6/channels/conversation-service.js';
import { TurnRingBuffer } from '../../../v6/poller.js';
import { InMemoryScheduler } from '../../../v6/scheduler.js';
import type { AgentEvent, AgentRequest } from '../../../v6/contracts.js';

/**
 * Web 薄通道 —— 契约的反向验证。
 *
 * 这个壳存在的理由不是"我们需要一个网页版",而是:**只有第二个真实渠道
 * 才能证明契约不是照着微信描出来的**。所以它必须走完全同一条 Core,
 * 一行 core/ 代码都不许为它改。
 *
 * 安全默认关:没配 token 一律 403 —— 这是个能让人替你跟 agent 说话的口子。
 */

let home: string;
let servers: http.Server[] = [];
let channels: WebChannel[] = [];
let cores: ChannelCore[] = [];
let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function fakeAgent(reply = (text: string) => `echo: ${text}`) {
  const requests: AgentRequest[] = [];
  return {
    name: 'fake-agent',
    persistent: false,
    requests,
    run: vi.fn(async function* (req: AgentRequest): AsyncIterable<AgentEvent> {
      requests.push(req);
      yield { type: 'final', text: reply(req.text) } as AgentEvent;
    }),
    reset: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeStore() {
  return {
    get: vi.fn().mockReturnValue(null),
    saveProviderSession: vi.fn(),
    touch: vi.fn(),
    bump: vi.fn(),
    drop: vi.fn(),
    expireIdle: vi.fn().mockReturnValue([]),
  };
}

/** 起一个真的 http server(随机端口),模拟 v6 health server */
async function startServer(): Promise<{ server: http.Server; port: number; base: string }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'running' }));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}

interface Wired {
  base: string;
  channel: WebChannel;
  agent: ReturnType<typeof fakeAgent>;
  core: ChannelCore;
}

async function wire(opts: { token?: string | null; agent?: ReturnType<typeof fakeAgent> } = {}): Promise<Wired> {
  const { server, base } = await startServer();
  const channel = new WebChannel({ token: opts.token, home, heartbeatMs: 50 });
  channel.attach(server);
  channels.push(channel);

  const agent = opts.agent ?? fakeAgent();
  const core = new ChannelCore({
    channels: [channel],
    agent: agent as any,
    scheduler: new InMemoryScheduler({ maxConcurrent: 2, queueCap: 5, onError: () => {} }),
    store: fakeStore() as any,
    conversations: new ConversationService(),
    turns: new TurnRingBuffer(20),
    cwd: '/work',
  });
  await core.start();
  cores.push(core);
  return { base, channel, agent, core };
}

/** 挂上 SSE,收够 n 个 reply 事件就 resolve */
function collectReplies(base: string, token: string, n = 1): { done: Promise<Array<Record<string, unknown>>>; close(): void } {
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}/web/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const out: Array<Record<string, unknown>> = [];
    let buf = '';
    while (out.length < n) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.includes('event: reply')) continue;
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) out.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
      }
    }
    controller.abort();
    return out;
  })();
  return { done, close: () => controller.abort() };
}

async function post(base: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/web/msg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'web-channel-'));
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
  errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => void logs.push(String(m)));
  delete process.env.CC2WECHAT_WEB_TOKEN;
});

afterEach(async () => {
  for (const c of cores) await c.stop().catch(() => {});
  for (const c of channels) await c.stop().catch(() => {});
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  cores = [];
  channels = [];
  servers = [];
  logSpy.mockRestore();
  errSpy.mockRestore();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CC2WECHAT_WEB_TOKEN;
});

// ---------------------------------------------------------------------------

describe('WebChannel — 契约形状', () => {
  it('name / sourceLabel 对得上', () => {
    const ch = new WebChannel({ token: 't', home });
    expect(ch.name).toBe('web');
    expect(ch.descriptor.sourceLabel).toBe('[web]');
  });
});

describe('WebChannel — 端到端(POST → agent → SSE)', () => {
  it('一条消息走完全链:agent 收到带 [web] 前缀的文本,回复从 SSE 出来', async () => {
    const { base, agent } = await wire({ token: 'secret' });
    const sse = collectReplies(base, 'secret', 1);
    await new Promise((r) => setTimeout(r, 50)); // 等 SSE 挂上

    const res = await post(base, { text: '你好' }, 'secret');
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ ok: true });

    const replies = await sse.done;
    expect(replies[0]).toEqual({ endpointId: 'default', text: 'echo: [web] 你好' });
    expect(agent.requests[0]!.text).toBe('[web] 你好');
  });

  it('endpointId 缺省是 default,给了就带着走', async () => {
    const { base } = await wire({ token: 'secret' });
    const sse = collectReplies(base, 'secret', 1);
    await new Promise((r) => setTimeout(r, 50));

    await post(base, { text: 'hi', endpointId: 'browser-7' }, 'secret');
    const replies = await sse.done;
    expect(replies[0]!.endpointId).toBe('browser-7');
  });

  it('不同 endpointId 落到不同会话', async () => {
    const { base, agent } = await wire({ token: 'secret' });
    await post(base, { text: 'a', endpointId: 'e1' }, 'secret');
    await post(base, { text: 'b', endpointId: 'e2' }, 'secret');
    await vi.waitFor(() => expect(agent.requests.length).toBe(2));

    expect(agent.requests[0]!.conversationId).not.toBe(agent.requests[1]!.conversationId);
  });

  it('同 endpointId 连发两条不会被当成重复(id 每条唯一)', async () => {
    const { base, agent } = await wire({ token: 'secret' });
    await post(base, { text: 'one' }, 'secret');
    await post(base, { text: 'two' }, 'secret');
    await vi.waitFor(() => expect(agent.requests.length).toBe(2));
  });

  it('SSE 有心跳注释行,长连接不被中间件掐掉', async () => {
    const { base } = await wire({ token: 'secret' });
    const controller = new AbortController();
    const res = await fetch(`${base}/web/events`, {
      headers: { Authorization: 'Bearer secret' },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 4 && !text.includes(': ping'); i++) {
      const { value } = await reader.read();
      text += decoder.decode(value ?? new Uint8Array(), { stream: true });
    }
    controller.abort();
    expect(text).toContain(': ping');
  });

  it('/health 这类不归它管的路径原样交回原处理器', async () => {
    const { base } = await wire({ token: 'secret' });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ status: 'running' });
  });
});

describe('WebChannel — 鉴权(安全默认关)', () => {
  it('没配 token 时两个端点一律 403,并在日志里说清楚怎么开', async () => {
    const { base } = await wire({ token: null });
    expect((await post(base, { text: 'hi' })).status).toBe(403);
    expect((await fetch(`${base}/web/events`)).status).toBe(403);
    expect(logs.some((l) => l.includes('CC2WECHAT_WEB_TOKEN'))).toBe(true);
  });

  it('配了 token 但不带 → 401', async () => {
    const { base } = await wire({ token: 'secret' });
    expect((await post(base, { text: 'hi' })).status).toBe(401);
    expect((await fetch(`${base}/web/events`)).status).toBe(401);
  });

  it('token 不对 → 401,而且不泄露正确值', async () => {
    const { base } = await wire({ token: 'secret' });
    const res = await post(base, { text: 'hi' }, 'wrong');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('secret');
  });

  it('长度不同的错 token 也稳妥拒绝(定长比较不能崩)', async () => {
    const { base } = await wire({ token: 'secret' });
    expect((await post(base, { text: 'hi' }, 'x')).status).toBe(401);
    expect((await post(base, { text: 'hi' }, 'secret-plus-more')).status).toBe(401);
  });

  it('没配 token 时不产出任何消息', async () => {
    const { base, agent } = await wire({ token: null });
    await post(base, { text: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    expect(agent.run).not.toHaveBeenCalled();
  });
});

describe('readWebToken — token 来源', () => {
  it('env CC2WECHAT_WEB_TOKEN 优先', () => {
    process.env.CC2WECHAT_WEB_TOKEN = 'from-env';
    fs.mkdirSync(path.join(home, '.cc2wechat'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cc2wechat', 'web-token'), 'from-file');
    expect(readWebToken(process.env, home)).toBe('from-env');
  });

  it('没有 env 就读 ~/.cc2wechat/web-token(去掉首尾空白)', () => {
    fs.mkdirSync(path.join(home, '.cc2wechat'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cc2wechat', 'web-token'), '  from-file\n');
    expect(readWebToken({}, home)).toBe('from-file');
  });

  it('都没有 → null(不生成、不猜)', () => {
    expect(readWebToken({}, home)).toBeNull();
  });

  it('空文件当没配', () => {
    fs.mkdirSync(path.join(home, '.cc2wechat'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cc2wechat', 'web-token'), '   \n');
    expect(readWebToken({}, home)).toBeNull();
  });
});

describe('WebChannel — 请求校验与健康', () => {
  it('body 不是合法 JSON → 400', async () => {
    const { base } = await wire({ token: 'secret' });
    expect((await post(base, '{ not json', 'secret')).status).toBe(400);
  });

  it('缺 text → 400', async () => {
    const { base } = await wire({ token: 'secret' });
    expect((await post(base, { endpointId: 'e1' }, 'secret')).status).toBe(400);
  });

  it('GET /web/msg → 405', async () => {
    const { base } = await wire({ token: 'secret' });
    const res = await fetch(`${base}/web/msg`, { headers: { Authorization: 'Bearer secret' } });
    expect(res.status).toBe(405);
  });

  it('health():没 token = 不健康且说明原因', async () => {
    const { channel } = await wire({ token: null });
    expect(channel.health()).toMatchObject({ ok: false });
    expect(channel.health().detail).toContain('token');
  });

  it('health():配好 token 且挂上了 = ok', async () => {
    const { channel } = await wire({ token: 'secret' });
    expect(channel.health().ok).toBe(true);
  });

  it('send() 在没有任何 SSE 连接时不抛错(浏览器没开着不算故障)', async () => {
    const { channel } = await wire({ token: 'secret' });
    await expect(channel.send('default', { text: 'nobody home' })).resolves.toBeUndefined();
  });

  it('stop() 之后 SSE 关掉,端点不再服务', async () => {
    const { base, channel } = await wire({ token: 'secret' });
    await channel.stop();
    expect(channel.health().ok).toBe(false);
    expect((await post(base, { text: 'hi' }, 'secret')).status).toBe(503);
  });
});
