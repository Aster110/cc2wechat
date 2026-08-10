import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../wechat-api.js', () => ({
  getUpdates: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue({}),
  uploadAndSendMedia: vi.fn().mockResolvedValue(undefined),
  downloadMedia: vi.fn(),
}));

vi.mock('../../v5/receiver/media.js', () => ({
  downloadMediaItems: vi.fn().mockResolvedValue(new Map()),
}));

import { MessageDispatcher, TurnRingBuffer, pollLoop, startIdleSweeper } from '../../v6/poller.js';
import { InMemoryScheduler } from '../../v6/scheduler.js';
import { deriveConversationId } from '../../v6/session-store.js';
import { getUpdates, sendMessage } from '../../wechat-api.js';
import { downloadMediaItems } from '../../v5/receiver/media.js';
import { MessageItemType } from '../../types.js';
import type { TurnResult } from '../../v6/orchestrator.js';
import type { IncomingMessage } from '../../v6/contracts.js';

let home: string;

const account = {
  accountId: 'acc-1',
  token: 'tok',
  baseUrl: 'https://example.com',
  savedAt: '2026-01-01',
  port: 19001,
} as any;

let msgIdCounter = 1000;
function textMsg(text: string, userId = 'user-1', id?: number) {
  return {
    message_type: 1,
    message_id: id ?? ++msgIdCounter,
    from_user_id: userId,
    context_token: 'ctx-1',
    create_time_ms: 1700000000000,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  } as any;
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

function fakeAgent() {
  return {
    name: 'codex',
    persistent: false,
    run: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const store = fakeStore();
  const agent = fakeAgent();
  const scheduler = new InMemoryScheduler({ maxConcurrent: 2, queueCap: 5, onError: () => {} });
  const orchestrator = {
    runTurn: vi.fn(
      async (_msg: IncomingMessage, _signal: AbortSignal): Promise<TurnResult> => ({ outcome: 'final', firstEventMs: 5 }),
    ),
  };
  const turns = new TurnRingBuffer(20);
  const deps = { account, cwd: '/work', agent, scheduler, store, orchestrator, turns, home, ...overrides };
  return { deps: deps as any, store, agent, scheduler, orchestrator, turns };
}

const savedTimeout = process.env.CC2WECHAT_TURN_TIMEOUT_MS;
const savedTtl = process.env.CC2WECHAT_SESSION_TTL_MS;

beforeEach(() => {
  vi.clearAllMocks();
  (downloadMediaItems as any).mockResolvedValue(new Map());
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-poller-home-'));
  process.env.CC2WECHAT_ACK_MS = '0';
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedTimeout == null) delete process.env.CC2WECHAT_TURN_TIMEOUT_MS;
  else process.env.CC2WECHAT_TURN_TIMEOUT_MS = savedTimeout;
  if (savedTtl == null) delete process.env.CC2WECHAT_SESSION_TTL_MS;
  else process.env.CC2WECHAT_SESSION_TTL_MS = savedTtl;
});

describe('MessageDispatcher — 去重', () => {
  it('同一条 message_id 只处理一次', async () => {
    const { deps, scheduler, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);
    const m = textMsg('hi', 'user-1', 5001);

    await d.handle(m);
    await d.handle(m);
    await scheduler.drain();

    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);
  });

  it('没有 message_id 时用 用户+时间+内容hash 兜底', async () => {
    const { deps, scheduler, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);
    const base = { ...textMsg('hi'), message_id: undefined };

    await d.handle({ ...base });
    await d.handle({ ...base });
    await scheduler.drain();
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);

    // 内容不同 = 不同消息
    await d.handle({ ...base, item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'other' } }] });
    await scheduler.drain();
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(2);
  });

  it('不同消息都处理', async () => {
    const { deps, scheduler, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);
    await d.handle(textMsg('a', 'user-1', 6001));
    await d.handle(textMsg('b', 'user-1', 6002));
    await scheduler.drain();
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(2);
  });

  it('LRU 有上限,超出后最老的 id 被挤出去', async () => {
    const { deps, scheduler, orchestrator } = makeDeps({ dedupeCapacity: 3 });
    const d = new MessageDispatcher(deps);
    for (const id of [1, 2, 3, 4]) await d.handle(textMsg('x', 'user-1', id));
    await scheduler.drain();
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(4);

    // id=1 已被挤出记忆 → 会被当成新消息
    await d.handle(textMsg('x', 'user-1', 1));
    await scheduler.drain();
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(5);

    // id=4 还在记忆里 → 拦住
    await d.handle(textMsg('x', 'user-1', 4));
    await scheduler.drain();
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(5);
  });

  it('非用户消息(message_type !== 1)直接忽略,也不占去重名额', async () => {
    const { deps, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);
    await d.handle({ ...textMsg('x'), message_type: 2 });
    expect(orchestrator.runTurn).not.toHaveBeenCalled();
    expect(downloadMediaItems).not.toHaveBeenCalled();
  });
});

describe('MessageDispatcher — 会话身份与常规链路', () => {
  it('conversationId 按 accountId 派生,与端口无关', async () => {
    const { deps, scheduler, orchestrator, store } = makeDeps();
    const d = new MessageDispatcher(deps);
    await d.handle(textMsg('hi', 'user-1'));
    await scheduler.drain();

    const expected = deriveConversationId('acc-1', 'user-1');
    expect(store.noteUser).toHaveBeenCalledWith(expected, 'user-1');
    expect((orchestrator.runTurn.mock.calls[0][0] as any).conversationId).toBe(expected);
  });

  it('媒体下载后把路径与拼好的文本交给 orchestrator', async () => {
    (downloadMediaItems as any).mockResolvedValue(new Map([[0, '/tmp/pic-0.jpg']]));
    const { deps, scheduler, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);
    await d.handle({
      message_type: 1,
      message_id: 7001,
      from_user_id: 'user-1',
      context_token: 'ctx-1',
      item_list: [{ type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } }],
    } as any);
    await scheduler.drain();

    const incoming = orchestrator.runTurn.mock.calls[0][0] as any;
    expect(incoming.mediaPaths).toEqual(['/tmp/pic-0.jpg']);
    expect(incoming.text).toContain('/tmp/pic-0.jpg');
  });

  it('写 ctx 路由文件,且里面绝不含 token / baseUrl', async () => {
    const { deps, scheduler } = makeDeps();
    const d = new MessageDispatcher(deps);
    await d.handle(textMsg('hi', 'user-1'));
    await scheduler.drain();

    const dir = path.join(home, '.cc2wechat', 'ctx');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf-8');
    expect(raw).not.toContain('tok');
    expect(raw).not.toContain('example.com');
    expect(JSON.parse(raw)).toEqual({
      userId: 'user-1',
      contextToken: 'ctx-1',
      port: 19001,
      accountId: 'acc-1',
    });
  });

  it('账号记录里没写 port 时退回本进程端口(不然 reply-cli 查不到 token)', async () => {
    process.env.CC2WECHAT_PORT = '19007';
    try {
      const { deps, scheduler } = makeDeps({ account: { ...account, port: undefined } });
      const d = new MessageDispatcher(deps);
      await d.handle(textMsg('hi', 'user-1'));
      await scheduler.drain();

      const dir = path.join(home, '.cc2wechat', 'ctx');
      const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf-8');
      expect(JSON.parse(raw).port).toBe(19007);
    } finally {
      delete process.env.CC2WECHAT_PORT;
    }
  });
});

describe('MessageDispatcher — 控制命令抢占', () => {
  it('长任务跑着的时候 /stop 立刻生效,不排在后面', async () => {
    const { deps, scheduler, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);

    let aborted = false;
    orchestrator.runTurn.mockImplementation(
      (_m: IncomingMessage, signal: AbortSignal) =>
        new Promise<TurnResult>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ outcome: 'aborted', firstEventMs: 1 });
          });
        }),
    );

    await d.handle(textMsg('跑个长任务', 'user-1', 8001));
    await new Promise((r) => setTimeout(r, 5));
    expect(scheduler.running(deriveConversationId('acc-1', 'user-1'))).toBe(true);

    await d.handle(textMsg('/stop', 'user-1', 8002));

    expect(aborted).toBe(true);
    // 命令不占调度槽:只跑了那一个长任务
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);
    const replies = (sendMessage as any).mock.calls.map((c: any[]) => c[2]);
    expect(replies.some((t: string) => t.includes('已停止当前任务'))).toBe(true);
    await scheduler.drain();
  });

  it('/new 抢占:打断在跑的 + 清排队 + bump + agent.reset', async () => {
    const { deps, scheduler, orchestrator, store, agent } = makeDeps();
    const d = new MessageDispatcher(deps);
    orchestrator.runTurn.mockImplementation(
      (_m: IncomingMessage, signal: AbortSignal) =>
        new Promise<TurnResult>((resolve) => {
          signal.addEventListener('abort', () => resolve({ outcome: 'aborted', firstEventMs: 1 }));
        }),
    );

    await d.handle(textMsg('长任务', 'user-1', 8101));
    await d.handle(textMsg('排队的', 'user-1', 8102));
    await new Promise((r) => setTimeout(r, 5));

    await d.handle(textMsg('/new', 'user-1', 8103));
    await scheduler.drain();

    const conv = deriveConversationId('acc-1', 'user-1');
    expect(store.bump).toHaveBeenCalledWith(conv);
    expect(agent.reset).toHaveBeenCalledWith(conv);
    // 排队的那条被清掉了,只有第一条真正跑过
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);
  });

  it('命令消息不进 scheduler', async () => {
    const { deps, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);
    const spy = vi.spyOn(deps.scheduler, 'enqueue');
    await d.handle(textMsg('/help', 'user-1'));
    expect(spy).not.toHaveBeenCalled();
    expect(orchestrator.runTurn).not.toHaveBeenCalled();
  });
});

describe('MessageDispatcher — 背压', () => {
  it('积压超上限时明确告诉用户排不下了', async () => {
    const scheduler = new InMemoryScheduler({ maxConcurrent: 1, queueCap: 2, onError: () => {} });
    const { deps, orchestrator } = makeDeps({ scheduler });
    const d = new MessageDispatcher(deps);
    orchestrator.runTurn.mockImplementation(() => new Promise<TurnResult>(() => {})); // 永不结束

    for (const id of [9001, 9002, 9003, 9004]) await d.handle(textMsg('x', 'user-1', id));

    const replies = (sendMessage as any).mock.calls.map((c: any[]) => String(c[2]));
    const rejected = replies.filter((t: string) => t.includes('排队'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('2');
  });
});

describe('MessageDispatcher — 每轮观测', () => {
  it('每轮推一条 TurnTiming 进环形缓冲', async () => {
    const { deps, scheduler, turns } = makeDeps();
    const d = new MessageDispatcher(deps);
    await d.handle(textMsg('hi', 'user-1', 9101));
    await scheduler.drain();

    const list = turns.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      conversationId: deriveConversationId('acc-1', 'user-1'),
      agent: 'codex',
      outcome: 'final',
      firstEventMs: 5,
    });
    expect(typeof list[0]!.queueMs).toBe('number');
    expect(typeof list[0]!.totalMs).toBe('number');
  });

  it('环形缓冲只留最近 N 轮', async () => {
    const ring = new TurnRingBuffer(2);
    for (let i = 0; i < 5; i++) {
      ring.push({ conversationId: `c${i}`, agent: 'a', queueMs: 0, firstEventMs: 0, totalMs: 0, outcome: 'final', endedAt: i });
    }
    expect(ring.list().map((t) => t.conversationId)).toEqual(['c3', 'c4']);
  });

  it('runTurn 抛异常也留一条 error 记录,不吞掉', async () => {
    const { deps, scheduler, orchestrator, turns } = makeDeps();
    orchestrator.runTurn.mockRejectedValue(new Error('boom'));
    const d = new MessageDispatcher(deps);
    await d.handle(textMsg('hi', 'user-1', 9201));
    await scheduler.drain();
    expect(turns.list()[0]).toMatchObject({ outcome: 'error' });
  });
});

describe('MessageDispatcher — 单轮超时', () => {
  it('超时 abort 该轮并回超时文案', async () => {
    process.env.CC2WECHAT_TURN_TIMEOUT_MS = '30';
    const { deps, scheduler, orchestrator } = makeDeps();
    const d = new MessageDispatcher(deps);
    orchestrator.runTurn.mockImplementation(
      (_m: IncomingMessage, signal: AbortSignal) =>
        new Promise<TurnResult>((resolve) => {
          signal.addEventListener('abort', () => resolve({ outcome: 'aborted', firstEventMs: 1 }));
        }),
    );

    await d.handle(textMsg('慢活', 'user-1', 9301));
    await scheduler.drain();

    const replies = (sendMessage as any).mock.calls.map((c: any[]) => String(c[2]));
    expect(replies.some((t: string) => t.includes('已中止'))).toBe(true);
    expect(replies.some((t: string) => t.includes('拆小'))).toBe(true);
  });

  it('没超时就不发那句话', async () => {
    process.env.CC2WECHAT_TURN_TIMEOUT_MS = '5000';
    const { deps, scheduler } = makeDeps();
    const d = new MessageDispatcher(deps);
    await d.handle(textMsg('快活', 'user-1', 9401));
    await scheduler.drain();
    const replies = (sendMessage as any).mock.calls.map((c: any[]) => String(c[2]));
    expect(replies.some((t: string) => t.includes('已中止'))).toBe(false);
  });
});

describe('startIdleSweeper — 空闲 TTL', () => {
  it('过期的会话逐个 agent.reset', async () => {
    vi.useFakeTimers();
    try {
      const { deps, store, agent } = makeDeps();
      store.expireIdle.mockReturnValue(['conv-a', 'conv-b']);
      const stop = startIdleSweeper(deps);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(store.expireIdle).toHaveBeenCalledWith(43_200_000);
      expect(agent.reset).toHaveBeenCalledWith('conv-a');
      expect(agent.reset).toHaveBeenCalledWith('conv-b');
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CC2WECHAT_SESSION_TTL_MS=0 = 关掉清理', () => {
    process.env.CC2WECHAT_SESSION_TTL_MS = '0';
    const { deps, store } = makeDeps();
    const stop = startIdleSweeper(deps);
    expect(store.expireIdle).not.toHaveBeenCalled();
    stop();
  });

  it('env 能改 TTL', async () => {
    vi.useFakeTimers();
    try {
      process.env.CC2WECHAT_SESSION_TTL_MS = '60000';
      const { deps, store } = makeDeps();
      const stop = startIdleSweeper(deps);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(store.expireIdle).toHaveBeenCalledWith(60_000);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pollLoop', () => {
  it('把一批消息派发下去,保存 buf,收到停止信号退出', async () => {
    const { deps, scheduler, orchestrator } = makeDeps();
    const stop = new AbortController();
    const saveSyncBuf = vi.fn();

    (getUpdates as any).mockImplementation(async () => {
      stop.abort();
      return { ret: 0, msgs: [textMsg('hi', 'user-1', 9501)], get_updates_buf: 'buf-2', longpolling_timeout_ms: 40_000 };
    });

    await pollLoop({ ...deps, stopSignal: stop.signal, loadSyncBuf: () => 'buf-1', saveSyncBuf });
    // 派发是 fire-and-forget(循环不能等后端),给它一拍时间落进 scheduler
    await new Promise((r) => setTimeout(r, 20));
    await scheduler.drain();

    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);
    expect(saveSyncBuf).toHaveBeenCalledWith('acc-1', 'buf-2');
  });

  it('轮询不被后端阻塞:长任务跑着时循环照样继续', async () => {
    const { deps, scheduler, orchestrator } = makeDeps();
    const stop = new AbortController();
    orchestrator.runTurn.mockImplementation(() => new Promise<TurnResult>(() => {})); // 永不结束

    let calls = 0;
    (getUpdates as any).mockImplementation(async () => {
      calls++;
      if (calls >= 3) stop.abort();
      return { ret: 0, msgs: [textMsg('hi', `user-${calls}`, 9600 + calls)], get_updates_buf: `buf-${calls}` };
    });

    await pollLoop({ ...deps, stopSignal: stop.signal, loadSyncBuf: () => '', saveSyncBuf: vi.fn() });
    expect(calls).toBe(3);
    scheduler.clear(deriveConversationId('acc-1', 'user-1'));
  });

  it('API 错误码不崩循环', async () => {
    const { deps } = makeDeps();
    const stop = new AbortController();
    let calls = 0;
    (getUpdates as any).mockImplementation(async () => {
      calls++;
      if (calls >= 2) stop.abort();
      return { ret: 500, errmsg: 'server oops' };
    });
    await expect(
      pollLoop({ ...deps, stopSignal: stop.signal, loadSyncBuf: () => '', saveSyncBuf: vi.fn(), retryDelayMs: 1 }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
