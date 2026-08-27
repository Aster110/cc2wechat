import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentAdapter, AgentEvent, AgentRequest } from '../../../v6/contracts.js';
import { ClaudeAppAgent, buildEnvelope } from '../../../v6/agents/claude-app.js';
import type { AckResult, InjectJob, ResolveJob, ResolveResult } from '../../../v6/claude-app/gateway-bus.js';
import { InboxRegistry } from '../../../v6/claude-app/inbox-registry.js';
import type { TranscriptBaseline, WatchOptions, WatchResult } from '../../../v6/claude-app/transcript-watcher.js';

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

class FakeBus {
  connected = true;
  injected: InjectJob[] = [];
  resolved: ResolveJob[] = [];
  ackResult: AckResult = { ok: true, ms: 12 };
  resolveResult: ResolveResult = { ok: true, localId: 'local_resolved' };
  closed = false;
  heartbeatStarted = false;
  testSendHandler: unknown = null;

  gatewayConnected(): boolean {
    return this.connected;
  }
  async dispatchInject(job: InjectJob): Promise<AckResult> {
    this.injected.push(job);
    return this.ackResult;
  }
  async dispatchResolve(job: ResolveJob): Promise<ResolveResult> {
    this.resolved.push(job);
    return this.resolveResult;
  }
  stats(): Record<string, unknown> {
    return { connected: this.connected, connections: this.connected ? 1 : 0, lastAckMs: 12 };
  }
  startHeartbeat(): void {
    this.heartbeatStarted = true;
  }
  stopHeartbeat(): void {
    this.heartbeatStarted = false;
  }
  close(): void {
    this.closed = true;
  }
  attach(): void {}
  setTestSend(h: unknown): void {
    this.testSendHandler = h;
  }
}

class FakeWatcher {
  calls: WatchOptions[] = [];
  result: WatchResult = { ok: true, text: '收到啦', doneBy: 'end_turn', transcript: '/t.jsonl' };
  baselineCalls: string[] = [];
  progress: string[] = [];

  baseline(cwd: string): TranscriptBaseline {
    this.baselineCalls.push(cwd);
    return { '/x.jsonl': 10 };
  }
  async watch(opts: WatchOptions): Promise<WatchResult> {
    this.calls.push(opts);
    for (const p of this.progress) opts.onProgress?.(p);
    return this.result;
  }
}

class FakeFallback implements AgentAdapter {
  readonly name = 'codex';
  readonly persistent = true;
  runs: AgentRequest[] = [];
  resets: string[] = [];
  didShutdown = false;

  async *run(req: AgentRequest): AsyncIterable<AgentEvent> {
    this.runs.push(req);
    yield { type: 'final', text: 'codex 兜底答的' };
  }
  async reset(id: string): Promise<void> {
    this.resets.push(id);
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async shutdown(): Promise<void> {
    this.didShutdown = true;
  }
}

// ---------------------------------------------------------------------------

let dir: string;
let bus: FakeBus;
let watcher: FakeWatcher;
let fallback: FakeFallback;
let inboxes: InboxRegistry;
let ids: number;

function agent(extra: Record<string, unknown> = {}): ClaudeAppAgent {
  return new ClaudeAppAgent({
    inboxes,
    bus: bus as never,
    watcher: watcher as never,
    fallback,
    now: () => 1_700_000_000_000,
    newJobId: () => `J${++ids}`,
    ...extra,
  });
}

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    conversationId: 'conv-1',
    text: '[微信] 在吗',
    mediaPaths: [],
    cwd: '/work',
    binding: null,
    ...over,
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-')));
  bus = new FakeBus();
  watcher = new FakeWatcher();
  fallback = new FakeFallback();
  inboxes = new InboxRegistry({ accountId: 'acct', dir, now: () => 1 });
  ids = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('buildEnvelope —— 注入信封', () => {
  it('形如 [微信|<name>|job:<id>|<ts>] 原文', () => {
    const s = buildEnvelope({ name: 'kiki', jobId: 'J1', at: 1_700_000_000_000, text: '在吗' });
    expect(s.startsWith('[微信|kiki|job:J1|2023-11-14T22:13:20.000Z] ')).toBe(true);
    expect(s).toContain('在吗');
  });

  it('原文里的 [微信] 前缀(Core 加的)不再叠一层', () => {
    const s = buildEnvelope({ name: 'kiki', jobId: 'J1', at: 0, text: '[微信] 在吗' });
    expect(s.match(/\[微信/g)).toHaveLength(1);
  });

  it('媒体走本地路径附一行 —— 收件箱自己有读文件的权限', () => {
    const s = buildEnvelope({ name: 'kiki', jobId: 'J1', at: 0, text: '看图', mediaPaths: ['/tmp/a.png'] });
    expect(s).toContain('/tmp/a.png');
  });

  it('重置标记走单独一行,不混进正文', () => {
    const s = buildEnvelope({ name: 'kiki', jobId: 'J1', at: 0, text: '新问题', reset: true });
    expect(s).toContain('新话题');
    const marker = s.indexOf('新话题');
    expect(marker).toBeGreaterThan(s.indexOf('[微信|'));
  });

  it('jobId 一定出现在信封里(它是 transcript 锚点)', () => {
    expect(buildEnvelope({ name: 'a', jobId: 'ABC', at: 0, text: 'x' })).toContain('job:ABC');
  });
});

describe('ClaudeAppAgent 契约字段', () => {
  it('name=claude-app,常驻', () => {
    const a = agent();
    expect(a.name).toBe('claude-app');
    expect(a.persistent).toBe(true);
  });
});

describe('run —— 正常一轮', () => {
  it('started → final,并把回复原样交给 Core', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events[0]).toMatchObject({ type: 'started', providerSessionId: 'local_k' });
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '收到啦' });
  });

  it('先记 baseline 再注入 —— 顺序反了就会漏掉秒回的那一轮', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const order: string[] = [];
    const w = new FakeWatcher();
    const origBaseline = w.baseline.bind(w);
    w.baseline = (cwd: string) => {
      order.push('baseline');
      return origBaseline(cwd);
    };
    const b = new FakeBus();
    const origInject = b.dispatchInject.bind(b);
    b.dispatchInject = async (job) => {
      order.push('inject');
      return origInject(job);
    };
    await collect(agent({ bus: b as never, watcher: w as never }).run(req(), new AbortController().signal));
    expect(order).toEqual(['baseline', 'inject']);
  });

  it('注入的是收件箱的 localId,不是 conversationId', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    await collect(agent().run(req(), new AbortController().signal));
    expect(bus.injected[0]).toMatchObject({ jobId: 'J1', localId: 'local_k' });
    expect(bus.injected[0].text).toContain('job:J1');
  });

  it('watcher 盯的是收件箱 cwd,不是 daemon 的 cwd', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    await collect(agent().run(req({ cwd: '/daemon/work' }), new AbortController().signal));
    expect(watcher.calls[0].cwd).toBe('/inbox/kiki');
    expect(watcher.calls[0].marker).toBe('job:J1');
  });

  it('回程旋钮透传给 watcher(但 cwd/marker/timeout 不许被旋钮盖掉)', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const a = agent({
      watchTuning: { pollMs: 7, settleMs: 8, silenceMs: 9, engineWaitMs: 10 },
      turnTimeoutMs: 4_242,
    });
    await collect(a.run(req(), new AbortController().signal));
    expect(watcher.calls[0]).toMatchObject({
      pollMs: 7,
      settleMs: 8,
      silenceMs: 9,
      engineWaitMs: 10,
      timeoutMs: 4_242,
      cwd: '/inbox/kiki',
    });
  });

  it('watcher 的 progress 转成 AgentEvent.progress', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    watcher.progress = ['工具 Bash'];
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events.some((e) => e.type === 'progress' && e.text === '工具 Bash')).toBe(true);
  });

  it('静默兜底完成时留一条 progress,运维一眼看出在吃兜底', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    watcher.result = { ok: true, text: 'x', doneBy: 'silence', transcript: '/t' };
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events.some((e) => e.type === 'progress' && String(e.text).includes('silence'))).toBe(true);
  });
});

describe('run —— 收件箱认领', () => {
  it('第一条消息认领一个空收件箱,并落盘', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    await collect(agent().run(req(), new AbortController().signal));
    expect(inboxes.forConversation('conv-1')!.name).toBe('kiki');
  });

  it('一个都没播种 → 明确报错并降级到 codex(不许哑死)', async () => {
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: 'codex 兜底答的' });
    expect(fallback.runs).toHaveLength(1);
  });

  it('关掉降级时,没收件箱就如实报错', async () => {
    const events = await collect(agent({ fallback: null }).run(req(), new AbortController().signal));
    const err = events[events.length - 1];
    expect(err.type).toBe('error');
    expect((err as { code: string }).code).toBe('claude-app-no-inbox');
    expect((err as { message: string }).message).toContain('seed');
  });
});

describe('run —— localId 懒解析', () => {
  it('没有 localId 就先 resolve,拿到后落盘并上报 sessionChanged', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(bus.resolved[0]).toMatchObject({ cwd: '/inbox/kiki' });
    expect(inboxes.byName('kiki')!.localId).toBe('local_resolved');
    expect(events.some((e) => e.type === 'sessionChanged' && e.providerSessionId === 'local_resolved')).toBe(true);
  });

  it('已有 localId 就不再打扰网关', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    await collect(agent().run(req(), new AbortController().signal));
    expect(bus.resolved).toHaveLength(0);
  });

  it('台账丢了但 SessionStore 还记着 → 从 binding 捡回来,不白跑一趟 resolve', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const binding = {
      conversationId: 'conv-1',
      agentType: 'claude-app',
      providerSessionId: 'local_from_store',
      generation: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    await collect(agent().run(req({ binding }), new AbortController().signal));
    expect(bus.resolved).toHaveLength(0);
    expect(bus.injected[0].localId).toBe('local_from_store');
  });

  it('别的后端留下的 binding 不能当 localId 用', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const binding = {
      conversationId: 'conv-1',
      agentType: 'codex',
      providerSessionId: 'thread_abc',
      generation: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    await collect(agent().run(req({ binding }), new AbortController().signal));
    expect(bus.resolved).toHaveLength(1);
  });

  it('网关说这个 cwd 没有会话 → 报错并提示去播种', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    bus.resolveResult = { ok: true, localId: null };
    const events = await collect(agent({ fallback: null }).run(req(), new AbortController().signal));
    const err = events[events.length - 1];
    expect(err).toMatchObject({ type: 'error', code: 'claude-app-unresolved-inbox' });
    expect((err as { message: string }).message).toContain('/inbox/kiki');
  });

  it('resolve 本身失败(网关掉线)→ 错误如实上报', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    bus.resolveResult = { ok: false, code: 'claude-app-ack-timeout', error: '网关没回执' };
    const events = await collect(agent({ fallback: null }).run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'claude-app-ack-timeout' });
  });
});

describe('run —— 注入失败', () => {
  it('网关不在线 → 降级 codex,并且不去 watch', async () => {
    bus.ackResult = { ok: false, code: 'claude-app-gateway-offline', error: '网关不在线' };
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: 'codex 兜底答的' });
    expect(watcher.calls).toHaveLength(0);
  });

  it('网关在线但 send_message 失败 → 报错,不降级(这是单轮问题,不是通道塌了)', async () => {
    bus.ackResult = { ok: false, code: 'claude-app-inject-failed', error: 'session not found' };
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'claude-app-inject-failed' });
    expect(fallback.runs).toHaveLength(0);
  });

  it('send_message 说会话没了 → 顺手清掉 localId,下一轮重解析', async () => {
    bus.ackResult = { ok: false, code: 'claude-app-inject-failed', error: 'session not found' };
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    await collect(agent().run(req(), new AbortController().signal));
    expect(inboxes.needResolve('kiki')).toBe(true);
  });
});

describe('run —— 回程失败', () => {
  it('超时 → error(retryable)', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    watcher.result = { ok: false, code: 'claude-app-turn-timeout', error: '等回复超时' };
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'claude-app-turn-timeout',
      retryable: true,
    });
  });

  it('被 /stop 打断 → 一句话都不回(回执由命令层发,再喊一句就成双回复)', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    watcher.result = { ok: false, code: 'claude-app-aborted', error: '取消' };
    const events = await collect(agent().run(req(), new AbortController().signal));
    expect(events.some((e) => e.type === 'error' || e.type === 'final')).toBe(false);
  });

  it('run 开始前就 aborted → 直接收摊,不注入', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const ac = new AbortController();
    ac.abort();
    const events = await collect(agent().run(req(), ac.signal));
    expect(events).toEqual([]);
    expect(bus.injected).toHaveLength(0);
  });
});

describe('run —— 上下文重置标记', () => {
  it('reset 之后那一条注入带新话题标记,再下一条就不带了', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const a = agent();
    await collect(a.run(req(), new AbortController().signal));
    await a.reset('conv-1');
    await collect(a.run(req(), new AbortController().signal));
    await collect(a.run(req(), new AbortController().signal));
    expect(bus.injected[0].text).not.toContain('新话题');
    expect(bus.injected[1].text).toContain('新话题');
    expect(bus.injected[2].text).not.toContain('新话题');
  });

  it('reset 不换收件箱、不解绑(收件箱永续)', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const a = agent();
    await collect(a.run(req(), new AbortController().signal));
    await a.reset('conv-1');
    expect(inboxes.forConversation('conv-1')!.name).toBe('kiki');
    expect(inboxes.byName('kiki')!.localId).toBe('local_k');
  });

  it('reset 也转告降级后端', async () => {
    await agent().reset('conv-1');
    expect(fallback.resets).toEqual(['conv-1']);
  });
});

describe('health', () => {
  it('网关在线 + 有收件箱 = 健康', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const h = await agent().health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('收件箱');
  });

  it('网关掉线 = 不健康(而且要说清怎么救)', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    bus.connected = false;
    const h = await agent().health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('网关');
  });

  it('一个收件箱都没播种 = 不健康', async () => {
    const h = await agent().health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('seed');
  });

  it('/health 有 1s 超时,这里必须是纯本地判断(不打网络)', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    const t0 = Date.now();
    await agent().health();
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe('shutdown', () => {
  it('关总线 + 关降级后端', async () => {
    const a = agent();
    await a.shutdown();
    expect(bus.closed).toBe(true);
    expect(fallback.didShutdown).toBe(true);
  });
});

describe('attachHttp —— 挂到 health server 上', () => {
  it('挂上去就开心跳', () => {
    agent().attachHttp({ on: () => {}, listeners: () => [], removeAllListeners: () => {} } as never);
    expect(bus.heartbeatStarted).toBe(true);
  });

  it('默认接上 test-send 处理器(真 E2E 要用)', () => {
    agent().attachHttp({ on: () => {}, listeners: () => [], removeAllListeners: () => {} } as never);
    expect(bus.testSendHandler).toBeTypeOf('function');
  });

  it('CC2WECHAT_CLAUDE_APP_TEST_SEND=0 时不挂 test-send', () => {
    agent({ env: { CC2WECHAT_CLAUDE_APP_TEST_SEND: '0' } }).attachHttp({
      on: () => {},
      listeners: () => [],
      removeAllListeners: () => {},
    } as never);
    expect(bus.testSendHandler).toBeNull();
  });

  it('test-send 走的就是 run() 全链,回复原样返回', async () => {
    inboxes.seed('kiki', '/inbox/kiki');
    inboxes.bindLocalId('kiki', 'local_k');
    const a = agent();
    a.attachHttp({ on: () => {}, listeners: () => [], removeAllListeners: () => {} } as never);
    const handler = bus.testSendHandler as (p: { text: string }) => Promise<{ ok: boolean; text?: string }>;
    const r = await handler({ text: '探针' });
    expect(r).toMatchObject({ ok: true, text: '收到啦' });
    expect(bus.injected[0].text).toContain('探针');
  });

  it('test-send 出错时如实回报,不抛', async () => {
    const a = agent({ fallback: null });
    a.attachHttp({ on: () => {}, listeners: () => [], removeAllListeners: () => {} } as never);
    const handler = bus.testSendHandler as (p: { text: string }) => Promise<{ ok: boolean; error?: string }>;
    const r = await handler({ text: '探针' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('claude-app-no-inbox');
  });
});
