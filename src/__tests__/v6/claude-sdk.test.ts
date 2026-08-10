import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeSdkAgent } from '../../v6/agents/claude-sdk.js';
import type { AgentEvent, AgentRequest, SessionBinding } from '../../v6/contracts.js';

/**
 * 假 cc-core:只保留 v6 真正依赖的四个接口面
 * (chat / closeSession / closeAllSessions / getOrCreateSession 不用)。
 * 依据 node_modules/@aster110/cc-core/dist/adapters/official.js —— chat() 里
 * extractSessionId 只认 `type:"system"` 且带 session_id 的消息,那才是真实 session id。
 */
function makeFakeCore(events: unknown[] | (() => AsyncIterable<unknown>)) {
  const chat = vi.fn((_params: unknown) => {
    if (typeof events === 'function') return events();
    return (async function* () {
      for (const e of events) yield e;
    })();
  });
  const closeSession = vi.fn();
  const closeAllSessions = vi.fn();
  const adapter = { chat, closeSession, closeAllSessions };
  return {
    adapter,
    chat,
    closeSession,
    closeAllSessions,
    loadModule: vi.fn(async () => ({ OfficialAdapter: function () { return adapter; } })) as any,
  };
}

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return { conversationId: 'conv-1', text: '你好', mediaPaths: [], cwd: '/work', binding: null, ...overrides };
}

function binding(providerSessionId: string): SessionBinding {
  return { conversationId: 'conv-1', agentType: 'claude-code', providerSessionId, generation: 1, createdAt: 0, updatedAt: 0 };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe('ClaudeSdkAgent — 会话身份', () => {
  it('全新会话不传 sessionId(v5 传伪 UUID 会让 SDK 走 resume 一个不存在的会话)', async () => {
    const core = makeFakeCore([
      { type: 'system', session_id: 'real-uuid-1' },
      { type: 'result', result: '答案' },
    ]);
    await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));

    expect(core.chat).toHaveBeenCalledTimes(1);
    const params = core.chat.mock.calls[0][0] as any;
    expect(params.sessionId).toBeUndefined();
    expect(params.cwd).toBe('/work');
    expect(params.message).toBe('你好');
  });

  it('从 system 事件捕获真实 session id 并上报 sessionChanged', async () => {
    const core = makeFakeCore([
      { type: 'system', session_id: 'real-uuid-1' },
      { type: 'result', result: '答案' },
    ]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    expect(events).toContainEqual({ type: 'sessionChanged', providerSessionId: 'real-uuid-1' });
    // 必须早于 final 到手,orchestrator 才能及时存绑定
    const idx = events.findIndex((e) => e.type === 'sessionChanged');
    const finalIdx = events.findIndex((e) => e.type === 'final');
    expect(idx).toBeLessThan(finalIdx);
  });

  it('有绑定时把真实 session id 传回去续聊,且不重复上报 sessionChanged', async () => {
    const core = makeFakeCore([
      { type: 'system', session_id: 'real-uuid-1' },
      { type: 'result', result: '继续' },
    ]);
    const events = await collect(
      new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req({ binding: binding('real-uuid-1') }), new AbortController().signal),
    );
    expect((core.chat.mock.calls[0][0] as any).sessionId).toBe('real-uuid-1');
    expect(events.find((e) => e.type === 'sessionChanged')).toBeUndefined();
  });

  it('后端换了 session id(SDK 侧 resume 失败重开)会如实上报', async () => {
    const core = makeFakeCore([
      { type: 'system', session_id: 'brand-new-uuid' },
      { type: 'result', result: 'ok' },
    ]);
    const events = await collect(
      new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req({ binding: binding('old-uuid') }), new AbortController().signal),
    );
    expect(events).toContainEqual({ type: 'sessionChanged', providerSessionId: 'brand-new-uuid' });
  });

  it('空 providerSessionId(bump 之后)当新会话', async () => {
    const core = makeFakeCore([{ type: 'result', result: 'ok' }]);
    await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req({ binding: binding('') }), new AbortController().signal));
    expect((core.chat.mock.calls[0][0] as any).sessionId).toBeUndefined();
  });
});

describe('ClaudeSdkAgent — 事件转换', () => {
  it('result 事件转 final', async () => {
    const core = makeFakeCore([{ type: 'result', result: '最终答复' }]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '最终答复' });
  });

  it('assistant 的 text block 也能出 final(沿用 v5 extractResult 口径)', async () => {
    const core = makeFakeCore([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '第一段' }, { type: 'tool_use' }, { type: 'text', text: '第二段' }] },
      },
    ]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '第一段\n第二段' });
  });

  it('assistant.content 是字符串也支持', async () => {
    const core = makeFakeCore([{ type: 'assistant', message: { content: '纯文本' } }]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '纯文本' });
  });

  it('多条候选取最后一条(倒着扫的增量版)', async () => {
    const core = makeFakeCore([
      { type: 'assistant', message: { content: '中间产物' } },
      { type: 'result', result: '真正的答复' },
    ]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '真正的答复' });
  });

  it('heartbeat / turn_complete / 工具调用转成 progress,不直接发微信', async () => {
    const core = makeFakeCore([
      { type: 'heartbeat', ts: 1 },
      { type: 'turn_complete' },
      { type: 'result', result: 'ok' },
    ]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });

  it('一句话都没产出时报错而不是静默', async () => {
    const core = makeFakeCore([{ type: 'system', session_id: 'u1' }]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err?.code).toBe('claude-no-output');
  });

  it('SDK 抛异常转成 error 事件,不把异常冒给 orchestrator', async () => {
    const core = makeFakeCore(() =>
      (async function* () {
        yield { type: 'system', session_id: 'u1' };
        throw new Error('stream exploded');
      })(),
    );
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.code).toBe('claude-sdk-error');
    expect(err.message).toContain('stream exploded');
  });
});

describe('ClaudeSdkAgent — abort', () => {
  it('abort 后停止消费并关掉池里的 session,不产出 final', async () => {
    const ctrl = new AbortController();
    const core = makeFakeCore(() =>
      (async function* () {
        yield { type: 'system', session_id: 'real-uuid-1' };
        ctrl.abort();
        yield { type: 'result', result: '不该被回出去' };
      })(),
    );
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), ctrl.signal));
    expect(events.find((e) => e.type === 'final')).toBeUndefined();
    expect(core.closeSession).toHaveBeenCalledWith('real-uuid-1');
  });

  it('进来时已 abort 就不发请求', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const core = makeFakeCore([{ type: 'result', result: 'x' }]);
    const events = await collect(new ClaudeSdkAgent({ loadModule: core.loadModule }).run(req(), ctrl.signal));
    expect(core.chat).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('ClaudeSdkAgent — cc-core 缺失', () => {
  it('codex-only 部署没装 cc-core 时给不可重试的 error,不崩进程', async () => {
    const loadModule = vi.fn(async () => {
      throw new Error("Cannot find package '@aster110/cc-core'");
    });
    const events = await collect(new ClaudeSdkAgent({ loadModule: loadModule as any }).run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.code).toBe('claude-sdk-missing');
    expect(err.retryable).toBe(false);
  });

  it('构造时不 import cc-core(留给 run 时才加载)', () => {
    const loadModule = vi.fn();
    new ClaudeSdkAgent({ loadModule: loadModule as any });
    expect(loadModule).not.toHaveBeenCalled();
  });
});

describe('ClaudeSdkAgent — reset / shutdown / 元信息', () => {
  it('name/persistent 标明是常驻池', () => {
    const a = new ClaudeSdkAgent();
    expect(a.name).toBe('claude-code');
    expect(a.persistent).toBe(true);
  });

  it('reset 关掉池里这条会话(cc-core 有 closeSession 接口)', async () => {
    const core = makeFakeCore([{ type: 'system', session_id: 'real-uuid-1' }, { type: 'result', result: 'ok' }]);
    const agent = new ClaudeSdkAgent({ loadModule: core.loadModule });
    await collect(agent.run(req(), new AbortController().signal));

    await agent.reset('conv-1');
    expect(core.closeSession).toHaveBeenCalledWith('real-uuid-1');

    // 忘干净了:再 reset 一次不会重复去关
    core.closeSession.mockClear();
    await agent.reset('conv-1');
    expect(core.closeSession).not.toHaveBeenCalled();
  });

  it('没跑过的会话 reset 是 no-op', async () => {
    await expect(new ClaudeSdkAgent().reset('never-seen')).resolves.toBeUndefined();
  });

  it('shutdown 关掉整个池', async () => {
    const core = makeFakeCore([{ type: 'result', result: 'ok' }]);
    const agent = new ClaudeSdkAgent({ loadModule: core.loadModule });
    await collect(agent.run(req(), new AbortController().signal));
    await agent.shutdown();
    expect(core.closeAllSessions).toHaveBeenCalledTimes(1);
  });

  it('health 不为了回答健康检查去 import cc-core', async () => {
    const loadModule = vi.fn();
    const h = await new ClaudeSdkAgent({ loadModule: loadModule as any }).health();
    expect(h.ok).toBe(true);
    expect(loadModule).not.toHaveBeenCalled();
  });
});
