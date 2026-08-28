import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ChannelCore } from '../../../v6/channels/core.js';
import { ConversationService } from '../../../v6/channels/conversation-service.js';
import { TurnRingBuffer } from '../../../v6/poller.js';
import { InMemoryScheduler } from '../../../v6/scheduler.js';
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelReply,
  ChannelStartContext,
} from '../../../v6/channels/contracts.js';
import type { AgentEvent, AgentRequest } from '../../../v6/contracts.js';

/**
 * Core —— 不认识任何具体壳的那一层。
 * 这些用例里没有一个字提到微信 API:全部通过假壳驱动。
 */

class FakeChannel implements ChannelAdapter {
  descriptor: { sourceLabel: string };
  sent: Array<{ endpointId: string; reply: ChannelReply }> = [];
  ctx: ChannelStartContext | null = null;
  started = false;
  stopped = false;
  sendError: Error | null = null;

  constructor(
    readonly name = 'fake',
    sourceLabel = '[fake]',
  ) {
    this.descriptor = { sourceLabel };
  }

  async start(ctx: ChannelStartContext): Promise<void> {
    this.started = true;
    this.ctx = ctx;
  }

  async send(endpointId: string, reply: ChannelReply): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push({ endpointId, reply });
  }

  health(): { ok: boolean; detail?: string; lastOkAt?: number } {
    return { ok: this.started && !this.stopped, detail: this.stopped ? '已停止' : undefined, lastOkAt: 42 };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** 模拟"平台来了一条消息" */
  emit(over: Partial<ChannelMessage> = {}): void {
    this.ctx?.deliver({
      id: over.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
      channel: this.name,
      endpointId: 'peer-1',
      text: 'hi',
      mediaPaths: [],
      receivedAt: Date.now(),
      ...over,
    });
  }

  texts(): string[] {
    return this.sent.map((s) => s.reply.text);
  }
}

class TurnAwareChannel extends FakeChannel {
  turnLog: string[] = [];
  beginTurn(msg: ChannelMessage): () => void {
    this.turnLog.push(`begin:${msg.id}`);
    return () => this.turnLog.push(`end:${msg.id}`);
  }
}

function fakeAgent(script: AgentEvent[] = [{ type: 'final', text: 'ok' }]) {
  const requests: AgentRequest[] = [];
  const agent = {
    name: 'codex',
    persistent: false,
    requests,
    events: script,
    run: vi.fn(async function* (req: AgentRequest, _signal: AbortSignal): AsyncIterable<AgentEvent> {
      requests.push(req);
      for (const e of agent.events) yield e;
    }),
    reset: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  return agent;
}

function fakeStore() {
  return {
    get: vi.fn().mockReturnValue(null),
    saveProviderSession: vi.fn(),
    touch: vi.fn(),
    bump: vi.fn(),
    drop: vi.fn(),
    expireIdle: vi.fn().mockReturnValue([]),
    noteUser: vi.fn(),
  };
}

/**
 * deliver() 是**同步返回、后台干活**的(壳的收信循环不能等后端),
 * 所以断言之前要先让入队那几个 microtask 落地,再 drain。
 */
async function settle(scheduler: InMemoryScheduler): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await scheduler.drain();
  }
}

interface Built {
  core: ChannelCore;
  channel: FakeChannel;
  agent: ReturnType<typeof fakeAgent>;
  store: ReturnType<typeof fakeStore>;
  scheduler: InMemoryScheduler;
  turns: TurnRingBuffer;
}

function build(over: Record<string, unknown> = {}): Built {
  const channel = (over.channel as FakeChannel) ?? new FakeChannel();
  const channels = (over.channels as ChannelAdapter[]) ?? [channel];
  const agent = (over.agent as ReturnType<typeof fakeAgent>) ?? fakeAgent();
  const store = fakeStore();
  const scheduler = (over.scheduler as InMemoryScheduler) ?? new InMemoryScheduler({ maxConcurrent: 2, queueCap: 5, onError: () => {} });
  const turns = new TurnRingBuffer(20);
  const core = new ChannelCore({
    channels,
    agent: agent as any,
    scheduler,
    store: store as any,
    conversations: (over.conversations as ConversationService) ?? new ConversationService(),
    turns,
    cwd: '/work',
    ...(over.dedupeCapacity != null ? { dedupeCapacity: over.dedupeCapacity as number } : {}),
  });
  return { core, channel, agent, store, scheduler, turns };
}

let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
  errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errs.push(String(m)));
  delete process.env.CC2WECHAT_TURN_TIMEOUT_MS;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.useRealTimers();
  delete process.env.CC2WECHAT_TURN_TIMEOUT_MS;
});

// ---------------------------------------------------------------------------

describe('ChannelCore — 启停', () => {
  it('start() 把所有通道挂上,每个通道拿到自己的 deliver', async () => {
    const a = new FakeChannel('a', '[a]');
    const b = new FakeChannel('b', '[b]');
    const { core } = build({ channels: [a, b], channel: a });
    await core.start();

    expect(a.started).toBe(true);
    expect(b.started).toBe(true);
    expect(typeof a.ctx?.deliver).toBe('function');
    expect(typeof a.ctx?.isDuplicate).toBe('function');
    await core.stop();
  });

  it('stop() 把所有通道停掉,一个抛错不影响其他', async () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    a.stop = vi.fn().mockRejectedValue(new Error('stop boom'));
    const { core } = build({ channels: [a, b], channel: b });
    await core.start();
    await core.stop();

    expect(b.stopped).toBe(true);
    expect(errs.some((l) => l.includes('stop boom'))).toBe(true);
  });

  it('channelHealth() 汇总每个通道的自报健康', async () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    const { core } = build({ channels: [a, b], channel: a });
    await core.start();
    await b.stop();

    expect(core.channelHealth()).toEqual([
      { name: 'a', ok: true, lastOkAt: 42 },
      { name: 'b', ok: false, detail: '已停止', lastOkAt: 42 },
    ]);
    await core.stop();
  });
});

describe('ChannelCore — Ingress 去重', () => {
  it('同 channel 同 id 只处理一次,并打 skip duplicate', async () => {
    const { core, channel, agent, scheduler } = build();
    await core.start();
    channel.emit({ id: 'm-1' });
    channel.emit({ id: 'm-1' });
    await settle(scheduler);

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('skip duplicate message fake:m-1'))).toBe(true);
    await core.stop();
  });

  it('去重键带上通道名:两个壳的同名 id 互不干扰', async () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    const { core, agent, scheduler } = build({ channels: [a, b], channel: a });
    await core.start();
    a.emit({ id: 'same' });
    b.emit({ id: 'same' });
    await settle(scheduler);

    expect(agent.run).toHaveBeenCalledTimes(2);
    await core.stop();
  });

  it('去重记忆有容量上限,最老的会被挤出去', async () => {
    const { core, channel, agent, scheduler } = build({ dedupeCapacity: 3 });
    await core.start();
    for (const id of ['1', '2', '3', '4']) channel.emit({ id });
    await settle(scheduler);
    expect(agent.run).toHaveBeenCalledTimes(4);

    channel.emit({ id: '1' }); // 已被挤出 → 当新消息
    await settle(scheduler);
    expect(agent.run).toHaveBeenCalledTimes(5);

    channel.emit({ id: '4' }); // 还在记忆里 → 拦住
    await settle(scheduler);
    expect(agent.run).toHaveBeenCalledTimes(5);
    await core.stop();
  });

  it('ctx.isDuplicate 是纯查询:问过之后这条消息照样能正常处理', async () => {
    const { core, channel, agent, scheduler } = build();
    await core.start();

    expect(channel.ctx!.isDuplicate!('m-9')).toBe(false);
    expect(channel.ctx!.isDuplicate!('m-9')).toBe(false); // peek 不登记
    channel.emit({ id: 'm-9' });
    await settle(scheduler);
    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(channel.ctx!.isDuplicate!('m-9')).toBe(true); // 处理过了才算见过
    await core.stop();
  });
});

describe('ChannelCore — 会话身份与入站日志', () => {
  it('conversationId 由 ConversationService 决定,壳给的 endpointId 只是原料', async () => {
    const conversations = new ConversationService();
    conversations.register('fake', (endpointId) => `conv-${endpointId}`);
    const { core, channel, agent, store, scheduler } = build({ conversations });
    await core.start();
    channel.emit({ endpointId: 'peer-7' });
    await settle(scheduler);

    expect(agent.requests[0]!.conversationId).toBe('conv-peer-7');
    expect(store.noteUser).toHaveBeenCalledWith('conv-peer-7', 'peer-7');
    await core.stop();
  });

  it('入站日志口径:`<- endpointId 前10位...: 文本前50字`', async () => {
    const { core, channel, scheduler } = build();
    await core.start();
    channel.emit({ endpointId: 'user-1234567890abc', text: 'hello world' });
    await settle(scheduler);

    expect(logs.some((l) => l.includes('<- user-12345...: hello world'))).toBe(true);
    await core.stop();
  });
});

describe('ChannelCore — 控制命令抢占', () => {
  it('/stop 在**入队之前**处理,不排在长任务后面', async () => {
    const agent = fakeAgent();
    let aborted = false;
    agent.run = vi.fn(async function* (_req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      }));
    }) as any;

    const { core, channel, scheduler } = build({ agent });
    await core.start();
    channel.emit({ id: 'long', text: '跑个长任务' });
    await new Promise((r) => setTimeout(r, 5));
    channel.emit({ id: 'cmd', text: '/stop' });
    await new Promise((r) => setTimeout(r, 5));

    expect(aborted).toBe(true);
    expect(agent.run).toHaveBeenCalledTimes(1); // 命令不占调度槽
    expect(channel.texts().some((t) => t.includes('已停止当前任务'))).toBe(true);
    await settle(scheduler);
    await core.stop();
  });

  it('/new bump + reset,且回复走来源通道', async () => {
    const { core, channel, agent, store, scheduler } = build();
    await core.start();
    channel.emit({ text: '/new' });
    await settle(scheduler);

    expect(store.bump).toHaveBeenCalled();
    expect(agent.reset).toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes('已开启新对话'))).toBe(true);
    expect(agent.run).not.toHaveBeenCalled();
    await core.stop();
  });

  it('/help 不进 scheduler', async () => {
    const { core, channel, scheduler } = build();
    const spy = vi.spyOn(scheduler, 'enqueue');
    await core.start();
    channel.emit({ text: '/help' });
    await new Promise((r) => setTimeout(r, 5));

    expect(spy).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes('可用命令'))).toBe(true);
    await core.stop();
  });

  it('多通道时命令只影响自己那条会话', async () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    const { core, scheduler } = build({ channels: [a, b], channel: a });
    await core.start();
    a.emit({ text: '/help' });
    await new Promise((r) => setTimeout(r, 5));

    expect(a.texts()).toHaveLength(1);
    expect(b.texts()).toHaveLength(0);
    await settle(scheduler);
    await core.stop();
  });
});

describe('ChannelCore — Delivery', () => {
  it('final 事件回给来源通道,带上 mediaFiles', async () => {
    const agent = fakeAgent([{ type: 'final', text: '答案', mediaFiles: ['/tmp/a.png'] }]);
    const { core, channel, scheduler } = build({ agent });
    await core.start();
    channel.emit({ endpointId: 'peer-3' });
    await settle(scheduler);

    expect(channel.sent[0]).toEqual({ endpointId: 'peer-3', reply: { text: '答案', mediaFiles: ['/tmp/a.png'] } });
    await core.stop();
  });

  it('sourceLabel 由壳自报并注入 AgentRequest.text —— agent 靠它识别来源', async () => {
    const wechatish = new FakeChannel('wechat', '[微信]');
    const webish = new FakeChannel('web', '[web]');
    const { core, agent, scheduler } = build({ channels: [wechatish, webish], channel: wechatish });
    await core.start();
    wechatish.emit({ text: '你好' });
    await settle(scheduler);
    webish.emit({ text: 'yo' });
    await settle(scheduler);

    expect(agent.requests[0]!.text).toBe('[微信] 你好');
    expect(agent.requests[1]!.text).toBe('[web] yo');
    await core.stop();
  });

  it('回复只回来源通道,不广播', async () => {
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    const { core, scheduler } = build({ channels: [a, b], channel: a });
    await core.start();
    b.emit({ endpointId: 'peer-b' });
    await settle(scheduler);

    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
    await core.stop();
  });

  it('error 事件带上 agent 名字回给用户', async () => {
    const agent = fakeAgent([{ type: 'error', code: 'quota', message: '配额没了', retryable: false }]);
    const { core, channel, scheduler } = build({ agent });
    await core.start();
    channel.emit({});
    await settle(scheduler);

    expect(channel.texts()[0]).toBe('[codex] 配额没了');
    expect(core.turnsSnapshot()[0]!.outcome).toBe('error');
    await core.stop();
  });

  it('sessionChanged 立刻落盘,轮末 touch', async () => {
    const agent = fakeAgent([{ type: 'sessionChanged', providerSessionId: 'thread-9' }, { type: 'final', text: 'ok' }]);
    const { core, channel, store, scheduler } = build({ agent });
    await core.start();
    channel.emit({});
    await settle(scheduler);

    expect(store.saveProviderSession).toHaveBeenCalledWith(expect.any(String), 'codex', 'thread-9');
    expect(store.touch).toHaveBeenCalled();
    await core.stop();
  });

  it('agent 一句话没说也不让用户对着空气等', async () => {
    const agent = fakeAgent([]);
    const { core, channel, scheduler } = build({ agent });
    await core.start();
    channel.emit({});
    await settle(scheduler);

    expect(channel.texts()[0]).toContain('这轮没有任何输出');
    await core.stop();
  });

  it('通道 send 失败不把这一轮拖成 crash', async () => {
    const { core, channel, scheduler, turns } = build();
    channel.sendError = new Error('send boom');
    await core.start();
    channel.emit({});
    await settle(scheduler);

    expect(errs.some((l) => l.includes('reply failed') && l.includes('send boom'))).toBe(true);
    expect(turns.list()).toHaveLength(1);
    await core.stop();
  });

  it('agent 抛异常 → 把原因回给用户,记一条 error', async () => {
    const agent = fakeAgent();
    agent.run = vi.fn(async function* (): AsyncIterable<AgentEvent> {
      throw new Error('后端炸了');
    }) as any;
    const { core, channel, scheduler, turns } = build({ agent });
    await core.start();
    channel.emit({});
    await settle(scheduler);

    expect(channel.texts()[0]).toBe('[codex] 后端炸了');
    expect(turns.list()[0]!.outcome).toBe('error');
    await core.stop();
  });
});

describe('ChannelCore — 观测与背压', () => {
  it('每轮一条 TurnTiming + 一行 [turn] 日志', async () => {
    const { core, channel, scheduler, turns } = build();
    await core.start();
    channel.emit({});
    await settle(scheduler);

    expect(turns.list()).toHaveLength(1);
    expect(turns.list()[0]).toMatchObject({ agent: 'codex', outcome: 'final' });
    expect(logs.some((l) => l.includes('[turn] conv=') && l.includes('agent=codex') && l.includes('outcome=final'))).toBe(true);
    await core.stop();
  });

  it('积压超上限时明确告诉用户排不下了', async () => {
    const agent = fakeAgent();
    agent.run = vi.fn(async function* (): AsyncIterable<AgentEvent> {
      await new Promise(() => {});
    }) as any;
    const scheduler = new InMemoryScheduler({ maxConcurrent: 1, queueCap: 2, onError: () => {} });
    const { core, channel } = build({ agent, scheduler });
    await core.start();
    for (const id of ['1', '2', '3', '4']) channel.emit({ id });
    await new Promise((r) => setTimeout(r, 20));

    const rejected = channel.texts().filter((t) => t.includes('排队'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('2');
    await core.stop();
  });

  it('CC2WECHAT_TURN_TIMEOUT_MS 到点 abort 并回超时文案', async () => {
    process.env.CC2WECHAT_TURN_TIMEOUT_MS = '30';
    const agent = fakeAgent();
    agent.run = vi.fn(async function* (_req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    }) as any;
    const { core, channel, scheduler } = build({ agent });
    await core.start();
    channel.emit({});
    await settle(scheduler);

    expect(channel.texts().some((t) => t.includes('已中止') && t.includes('拆小'))).toBe(true);
    await core.stop();
  });
});

describe('ChannelCore — 通道级 turn 生命周期 hook', () => {
  it('实现了 beginTurn 的壳:每轮开始/结束都被通知', async () => {
    const channel = new TurnAwareChannel('wechat', '[微信]');
    const { core, scheduler } = build({ channel, channels: [channel] });
    await core.start();
    channel.emit({ id: 'm-1' });
    await settle(scheduler);

    expect(channel.turnLog).toEqual(['begin:m-1', 'end:m-1']);
    await core.stop();
  });

  it('agent 抛异常也保证 end 被调用(typing 不能永远停不掉)', async () => {
    const channel = new TurnAwareChannel();
    const agent = fakeAgent();
    agent.run = vi.fn(async function* (): AsyncIterable<AgentEvent> {
      throw new Error('boom');
    }) as any;
    const { core, scheduler } = build({ channel, channels: [channel], agent });
    await core.start();
    channel.emit({ id: 'm-2' });
    await settle(scheduler);

    expect(channel.turnLog).toEqual(['begin:m-2', 'end:m-2']);
    await core.stop();
  });

  it('没实现 beginTurn 的壳照常跑', async () => {
    const { core, channel, scheduler, turns } = build();
    await core.start();
    channel.emit({});
    await settle(scheduler);
    expect(turns.list()).toHaveLength(1);
    await core.stop();
  });
});

describe('ChannelCore — 空闲清理', () => {
  it('接上 idle sweeper:过期会话逐个 agent.reset', async () => {
    vi.useFakeTimers();
    const { core, store, agent } = build();
    store.expireIdle.mockReturnValue(['conv-a']);
    await core.start();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(store.expireIdle).toHaveBeenCalled();
    expect(agent.reset).toHaveBeenCalledWith('conv-a');
    await core.stop();
  });

  it('stop() 之后清理定时器不再跑', async () => {
    vi.useFakeTimers();
    const { core, store } = build();
    await core.start();
    await core.stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(store.expireIdle).not.toHaveBeenCalled();
  });
});
