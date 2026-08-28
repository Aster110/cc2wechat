import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  channelCoreEnabled,
  selectedChannels,
  bootstrapChannelCore,
  type ChannelCoreHandle,
} from '../../../v6/channels/bootstrap.js';
import type { AgentEvent, AgentRequest } from '../../../v6/contracts.js';

/**
 * 双开关渐进的守卫。
 *
 * 第一条铁律:**缺省什么都不变**。CC2WECHAT_CHANNEL_CORE 没设 / 设成别的值,
 * 走的必须是一字未动的 legacy 路径 —— 生产两台机器现在就跑在那条路上。
 *
 * 第二条:web-only 模式(CHANNELS=web)必须能在**一台没有 ~/.cc2wechat、
 * 没有微信账号**的机器上起来 —— 侧车验收就是这个场景,不许触发扫码登录。
 */

let home: string;
let handles: ChannelCoreHandle[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function fakeAgent() {
  const requests: AgentRequest[] = [];
  return {
    name: 'fake-agent',
    persistent: false,
    requests,
    run: vi.fn(async function* (req: AgentRequest): AsyncIterable<AgentEvent> {
      requests.push(req);
      yield { type: 'final', text: `echo: ${req.text}` } as AgentEvent;
    }),
    reset: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const h of handles) await h.stop().catch(() => {});
  handles = [];
  logSpy.mockRestore();
  errSpy.mockRestore();
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('channelCoreEnabled — 缺省 legacy 不变', () => {
  it('没设这个变量 = 走 legacy', () => {
    expect(channelCoreEnabled({})).toBe(false);
  });

  it('只有 adapter 这一个值开新路', () => {
    expect(channelCoreEnabled({ CC2WECHAT_CHANNEL_CORE: 'adapter' })).toBe(true);
    expect(channelCoreEnabled({ CC2WECHAT_CHANNEL_CORE: ' ADAPTER ' })).toBe(true);
  });

  it('别的值一律 legacy(1 / true / legacy / 拼错 都不许误开)', () => {
    for (const v of ['', '1', 'true', 'yes', 'on', 'legacy', 'adaptor', 'adapter-core', 'core']) {
      expect(channelCoreEnabled({ CC2WECHAT_CHANNEL_CORE: v })).toBe(false);
    }
  });
});

describe('selectedChannels — 选通道', () => {
  it('缺省只挂微信(与现网形态一致)', () => {
    expect(selectedChannels({})).toEqual(['wechat']);
    expect(selectedChannels({ CC2WECHAT_CHANNELS: '' })).toEqual(['wechat']);
  });

  it('逗号表,去空白、去重、保序', () => {
    expect(selectedChannels({ CC2WECHAT_CHANNELS: 'wechat,web' })).toEqual(['wechat', 'web']);
    expect(selectedChannels({ CC2WECHAT_CHANNELS: ' web , wechat ' })).toEqual(['web', 'wechat']);
    expect(selectedChannels({ CC2WECHAT_CHANNELS: 'web,web' })).toEqual(['web']);
  });

  it('只要 web 就只有 web —— 一个字都不提微信', () => {
    expect(selectedChannels({ CC2WECHAT_CHANNELS: 'web' })).toEqual(['web']);
  });

  it('不认识的名字丢掉并告警,不静默当成微信', () => {
    expect(selectedChannels({ CC2WECHAT_CHANNELS: 'web,mesh' })).toEqual(['web']);
    expect(errSpy).toHaveBeenCalled();
  });

  it('全是不认识的名字 → 空表(宁可什么都不挂,也别猜)', () => {
    expect(selectedChannels({ CC2WECHAT_CHANNELS: 'telegram' })).toEqual([]);
  });
});

describe('bootstrapChannelCore — web-only(没有 ~/.cc2wechat、没有微信账号的机器)', () => {
  async function bootWebOnly(): Promise<{ handle: ChannelCoreHandle; base: string; agent: ReturnType<typeof fakeAgent>; loadAccount: ReturnType<typeof vi.fn> }> {
    const agent = fakeAgent();
    const loadAccount = vi.fn();
    const handle = await bootstrapChannelCore({
      env: { CC2WECHAT_CHANNEL_CORE: 'adapter', CC2WECHAT_CHANNELS: 'web', CC2WECHAT_WEB_TOKEN: 'secret' },
      port: 0,
      home,
      cwd: '/work',
      agent: agent as any,
      loadAccount: loadAccount as any,
    });
    handles.push(handle);
    return { handle, base: `http://127.0.0.1:${handle.port}`, agent, loadAccount };
  }

  it('完全不碰账号存储:loadAccount 一次都没被调用,也没有登录', async () => {
    const { loadAccount } = await bootWebOnly();
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it('不在 HOME 下留下任何 accounts-*.json', async () => {
    await bootWebOnly();
    const dir = path.join(home, '.cc2wechat');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files.filter((f) => f.startsWith('accounts-'))).toEqual([]);
  });

  it('/health 起得来:account 允许为 null,channels[] 里有 web', async () => {
    const { base } = await bootWebOnly();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.status).toBe('running');
    expect(body.engine).toBe('v6');
    expect(body.agent).toBe('fake-agent');
    expect(body.account).toBeNull();
    expect(body.channels).toEqual([expect.objectContaining({ name: 'web', ok: true })]);
  });

  it('POST /web/msg 全链可用:agent 收到 [web] 前缀,SSE 回显', async () => {
    const { base, agent } = await bootWebOnly();

    const controller = new AbortController();
    const sse = fetch(`${base}/web/events`, { headers: { Authorization: 'Bearer secret' }, signal: controller.signal });
    const sseRes = await sse;
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    const posted = await fetch(`${base}/web/msg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ text: '在吗' }),
    });
    expect(posted.status).toBe(200);

    let buf = '';
    for (let i = 0; i < 8 && !buf.includes('event: reply'); i++) {
      const { value } = await reader.read();
      buf += decoder.decode(value ?? new Uint8Array(), { stream: true });
    }
    controller.abort();

    expect(buf).toContain('event: reply');
    expect(buf).toContain('echo: [web] 在吗');
    expect(agent.requests[0]!.text).toBe('[web] 在吗');
  });

  it('stop() 收摊:通道停、agent shutdown、端口放开', async () => {
    const { handle, base, agent } = await bootWebOnly();
    await handle.stop();
    handles = [];

    expect(agent.shutdown).toHaveBeenCalled();
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });
});

describe('bootstrapChannelCore — 有微信通道时才加载账号', () => {
  it('CHANNELS 含 wechat 时才调 loadAccount,并把它挂进 channels[]', async () => {
    const agent = fakeAgent();
    const account = { accountId: 'acc-1', token: 'tok', baseUrl: 'https://example.com', savedAt: 'x', port: 19001 };
    const loadAccount = vi.fn().mockResolvedValue(account);

    const handle = await bootstrapChannelCore({
      env: { CC2WECHAT_CHANNEL_CORE: 'adapter', CC2WECHAT_CHANNELS: 'wechat' },
      port: 0,
      home,
      cwd: '/work',
      agent: agent as any,
      loadAccount: loadAccount as any,
      // 不让它真去打微信 API
      wechat: { loadSyncBuf: () => '', saveSyncBuf: () => {} },
    });
    handles.push(handle);

    expect(loadAccount).toHaveBeenCalledTimes(1);
    const body = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as any;
    expect(body.account).toBe('acc-1');
    expect(body.channels.map((c: any) => c.name)).toEqual(['wechat']);
  });

  it('微信 + web 双挂:同一个 Core 服务两个入口', async () => {
    const agent = fakeAgent();
    const loadAccount = vi.fn().mockResolvedValue({
      accountId: 'acc-1',
      token: 'tok',
      baseUrl: 'https://example.com',
      savedAt: 'x',
      port: 19001,
    });

    const handle = await bootstrapChannelCore({
      env: {
        CC2WECHAT_CHANNEL_CORE: 'adapter',
        CC2WECHAT_CHANNELS: 'wechat,web',
        CC2WECHAT_WEB_TOKEN: 'secret',
      },
      port: 0,
      home,
      cwd: '/work',
      agent: agent as any,
      loadAccount: loadAccount as any,
      wechat: { loadSyncBuf: () => '', saveSyncBuf: () => {} },
    });
    handles.push(handle);

    const body = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as any;
    expect(body.channels.map((c: any) => c.name)).toEqual(['wechat', 'web']);
  });

  it('微信会话 id 走兼容映射:与现网 deriveConversationId 一致', async () => {
    const { deriveConversationId } = await import('../../../v6/session-store.js');
    const agent = fakeAgent();
    const handle = await bootstrapChannelCore({
      env: { CC2WECHAT_CHANNEL_CORE: 'adapter', CC2WECHAT_CHANNELS: 'wechat' },
      port: 0,
      home,
      cwd: '/work',
      agent: agent as any,
      loadAccount: vi.fn().mockResolvedValue({
        accountId: 'acc-1',
        token: 'tok',
        baseUrl: 'https://example.com',
        savedAt: 'x',
        port: 19001,
      }) as any,
      wechat: { loadSyncBuf: () => '', saveSyncBuf: () => {} },
    });
    handles.push(handle);

    expect(handle.conversations.idFor({ channel: 'wechat', endpointId: 'user-1' })).toBe(
      deriveConversationId('acc-1', 'user-1'),
    );
  });
});
