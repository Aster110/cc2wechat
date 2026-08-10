import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../wechat-api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue({}),
  uploadAndSendMedia: vi.fn().mockResolvedValue(undefined),
  getUpdates: vi.fn(),
  downloadMedia: vi.fn(),
}));

import { Orchestrator } from '../../v6/orchestrator.js';
import { sendMessage, sendTyping, getConfig } from '../../wechat-api.js';
import type { AgentEvent, IncomingMessage } from '../../v6/contracts.js';

const account = {
  accountId: 'acc-1',
  token: 'tok',
  baseUrl: 'https://example.com',
  savedAt: '2026-01-01',
  port: 19001,
} as any;

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    text: '你好',
    mediaPaths: [],
    contextToken: 'ctx-1',
    receivedAt: Date.now(),
    ...overrides,
  };
}

function agentOf(events: AgentEvent[] | (() => AsyncIterable<AgentEvent>), name = 'codex') {
  return {
    name,
    persistent: false,
    run: vi.fn((_req: unknown, _signal: AbortSignal) => {
      if (typeof events === 'function') return events();
      return (async function* () {
        for (const e of events) yield e;
      })();
    }),
    reset: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function storeOf(binding: unknown = null) {
  return {
    get: vi.fn().mockReturnValue(binding),
    saveProviderSession: vi.fn(),
    touch: vi.fn(),
    bump: vi.fn(),
    drop: vi.fn(),
    expireIdle: vi.fn().mockReturnValue([]),
  };
}

function replierOf() {
  return { reply: vi.fn().mockResolvedValue(undefined), replyMedia: vi.fn().mockResolvedValue(undefined) };
}

function makeOrchestrator(agent: any, store: any, replier: any) {
  return new Orchestrator({ account, agent, store, replier: replier as any, cwd: '/work', accountName: 'main' });
}

const savedAck = process.env.CC2WECHAT_ACK_MS;
beforeEach(() => {
  vi.clearAllMocks();
  (getConfig as any).mockResolvedValue({});
  process.env.CC2WECHAT_ACK_MS = '0'; // 默认关掉慢任务提示,单独测
});
afterEach(() => {
  if (savedAck == null) delete process.env.CC2WECHAT_ACK_MS;
  else process.env.CC2WECHAT_ACK_MS = savedAck;
});

describe('Orchestrator — 一轮的正常生命周期', () => {
  it('final 事件回给用户,结束时 touch 会话', async () => {
    const agent = agentOf([{ type: 'started' }, { type: 'final', text: '答复内容' }]);
    const store = storeOf();
    const replier = replierOf();

    const result = await makeOrchestrator(agent, store, replier).runTurn(msg(), new AbortController().signal);

    expect(replier.reply).toHaveBeenCalledTimes(1);
    expect(replier.reply.mock.calls[0][1]).toBe('答复内容');
    expect(store.touch).toHaveBeenCalledWith('conv-1');
    expect(result.outcome).toBe('final');
    expect(typeof result.firstEventMs).toBe('number');
  });

  it('把 store 里的 binding 交给 agent,并带上 [微信] 前缀与 cwd', async () => {
    const binding = { conversationId: 'conv-1', agentType: 'codex', providerSessionId: 'th-1', generation: 1, createdAt: 0, updatedAt: 0 };
    const agent = agentOf([{ type: 'final', text: 'ok' }]);
    const store = storeOf(binding);

    await makeOrchestrator(agent, store, replierOf()).runTurn(msg({ mediaPaths: ['/tmp/a.jpg'] }), new AbortController().signal);

    const req = agent.run.mock.calls[0][0] as any;
    expect(req.conversationId).toBe('conv-1');
    expect(req.binding).toBe(binding);
    expect(req.cwd).toBe('/work');
    expect(req.mediaPaths).toEqual(['/tmp/a.jpg']);
    // v5 的 sdk-delivery 就是这么打前缀的,agent 侧靠它识别"这是微信来的"
    expect(req.text).toBe('[微信] 你好');
  });

  it('sessionChanged 立刻写进 SessionStore(别等 final)', async () => {
    const agent = agentOf(() =>
      (async function* () {
        yield { type: 'sessionChanged', providerSessionId: 'th-new' } as AgentEvent;
        yield { type: 'final', text: 'ok' } as AgentEvent;
      })(),
    );
    const store = storeOf();
    await makeOrchestrator(agent, store, replierOf()).runTurn(msg(), new AbortController().signal);
    expect(store.saveProviderSession).toHaveBeenCalledWith('conv-1', 'codex', 'th-new');
  });

  it('progress 不发微信', async () => {
    const agent = agentOf([{ type: 'progress', text: 'command_execution' }, { type: 'final', text: 'ok' }]);
    const replier = replierOf();
    await makeOrchestrator(agent, storeOf(), replier).runTurn(msg(), new AbortController().signal);
    expect(replier.reply).toHaveBeenCalledTimes(1);
  });

  it('final 带 mediaFiles 时逐个发媒体', async () => {
    const agent = agentOf([{ type: 'final', text: '给你图', mediaFiles: ['/tmp/1.png', '/tmp/2.png'] }]);
    const replier = replierOf();
    await makeOrchestrator(agent, storeOf(), replier).runTurn(msg(), new AbortController().signal);
    expect(replier.replyMedia).toHaveBeenCalledTimes(2);
    expect(replier.replyMedia.mock.calls[0][1]).toBe('/tmp/1.png');
  });
});

describe('Orchestrator — 错误与中止', () => {
  it('error 事件带 agent 名前缀回给用户,outcome=error', async () => {
    const agent = agentOf([{ type: 'error', code: 'codex-exit', message: '配额用尽', retryable: false }]);
    const replier = replierOf();
    const result = await makeOrchestrator(agent, storeOf(), replier).runTurn(msg(), new AbortController().signal);
    expect(replier.reply.mock.calls[0][1]).toBe('[codex] 配额用尽');
    expect(result.outcome).toBe('error');
  });

  it('agent 抛异常也要回一句话,不能静默', async () => {
    const agent = agentOf(() =>
      (async function* (): AsyncIterable<AgentEvent> {
        throw new Error('agent exploded');
      })(),
    );
    const replier = replierOf();
    const result = await makeOrchestrator(agent, storeOf(), replier).runTurn(msg(), new AbortController().signal);
    expect(replier.reply.mock.calls[0][1]).toContain('agent exploded');
    expect(result.outcome).toBe('error');
  });

  it('被 abort 的一轮不回复,outcome=aborted,也不 touch', async () => {
    const ctrl = new AbortController();
    const agent = agentOf(() =>
      (async function* (): AsyncIterable<AgentEvent> {
        ctrl.abort();
        return;
      })(),
    );
    const store = storeOf();
    const replier = replierOf();
    const result = await makeOrchestrator(agent, store, replier).runTurn(msg(), ctrl.signal);
    expect(result.outcome).toBe('aborted');
    expect(replier.reply).not.toHaveBeenCalled();
    expect(store.touch).not.toHaveBeenCalled();
  });

  it('回复失败(微信 errcode)不把异常冒出去', async () => {
    const agent = agentOf([{ type: 'final', text: 'ok' }]);
    const replier = replierOf();
    replier.reply.mockRejectedValue(new Error('sendMessage failed: errcode=-14'));
    await expect(
      makeOrchestrator(agent, storeOf(), replier).runTurn(msg(), new AbortController().signal),
    ).resolves.toMatchObject({ outcome: 'final' });
  });
});

describe('Orchestrator — typing 心跳', () => {
  it('拿到真 ticket 才发 typing,开始 1 结束 2', async () => {
    (getConfig as any).mockResolvedValue({ typing_ticket: 'tk-1' });
    const agent = agentOf(() =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 30));
        yield { type: 'final', text: 'ok' } as AgentEvent;
      })(),
    );
    await makeOrchestrator(agent, storeOf(), replierOf()).runTurn(msg(), new AbortController().signal);
    expect(sendTyping).toHaveBeenCalledWith('tok', 'user-1', 'tk-1', 1, 'https://example.com');
    expect(sendTyping).toHaveBeenCalledWith('tok', 'user-1', 'tk-1', 2, 'https://example.com');
  });

  // 空 ticket 发过去是静默无效——v5 早期"发了一整年却从没显示过"就栽在这
  it('没 ticket 宁可不发', async () => {
    (getConfig as any).mockResolvedValue({});
    const agent = agentOf([{ type: 'final', text: 'ok' }]);
    await makeOrchestrator(agent, storeOf(), replierOf()).runTurn(msg(), new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it('getConfig 挂了也不影响正事', async () => {
    (getConfig as any).mockRejectedValue(new Error('boom'));
    const agent = agentOf([{ type: 'final', text: 'ok' }]);
    const replier = replierOf();
    await makeOrchestrator(agent, storeOf(), replier).runTurn(msg(), new AbortController().signal);
    expect(replier.reply).toHaveBeenCalledTimes(1);
  });
});

describe('Orchestrator — 慢任务 ack(CC2WECHAT_ACK_MS)', () => {
  it('阈值内答完就不打扰用户', async () => {
    process.env.CC2WECHAT_ACK_MS = '200';
    const agent = agentOf([{ type: 'final', text: 'ok' }]);
    await makeOrchestrator(agent, storeOf(), replierOf()).runTurn(msg(), new AbortController().signal);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('超过阈值回一句"正在处理",只回一次', async () => {
    process.env.CC2WECHAT_ACK_MS = '20';
    const agent = agentOf(() =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 120));
        yield { type: 'final', text: 'ok' } as AgentEvent;
      })(),
    );
    await makeOrchestrator(agent, storeOf(), replierOf()).runTurn(msg(), new AbortController().signal);
    const acks = (sendMessage as any).mock.calls.filter((c: any[]) => String(c[2]).includes('正在处理'));
    expect(acks).toHaveLength(1);
  });

  it('设成 0 = 彻底关掉', async () => {
    process.env.CC2WECHAT_ACK_MS = '0';
    const agent = agentOf(() =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 60));
        yield { type: 'final', text: 'ok' } as AgentEvent;
      })(),
    );
    await makeOrchestrator(agent, storeOf(), replierOf()).runTurn(msg(), new AbortController().signal);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('不设时默认 60s(不会在短任务里冒出来)', async () => {
    delete process.env.CC2WECHAT_ACK_MS;
    const agent = agentOf([{ type: 'final', text: 'ok' }]);
    await makeOrchestrator(agent, storeOf(), replierOf()).runTurn(msg(), new AbortController().signal);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
