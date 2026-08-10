import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CodexAppServerAgent,
  answerForServerRequest,
  appServerArgs,
  buildTurnInput,
  lastAgentMessageOf,
  type ProcOps,
} from '../../v6/agents/codex-app-server.js';
import type { AgentAdapter, AgentEvent, AgentRequest, SessionBinding } from '../../v6/contracts.js';

// ---------------------------------------------------------------------------
// 假 app-server 子进程
//
// 协议帧全部取材自真实抓包 p4c-turns.json（2026-08-10 探针），不是凭印象编的。
// ---------------------------------------------------------------------------

interface FakeServerOptions {
  codexHome?: string;
  /** thread/resume 认得的线程；不在表里就返回 -32602 */
  knownThreads?: string[];
  /** 起来就直接死（模拟 spawn 失败/立刻崩） */
  dieImmediately?: boolean;
  /** initialize 不回（模拟卡死） */
  silentInitialize?: boolean;
  /** 自定义拦截：返回 true 表示已处理，跳过默认逻辑 */
  onRequest?: (ctx: FakeServer, msg: { id?: number; method: string; params: any }) => boolean | void;
  /** turn/start 之后不自动跑完，测试自己驱动 */
  manualTurn?: boolean;
}

class FakeServer {
  readonly child: any;
  readonly requests: Array<{ id?: number; method: string; params: any }> = [];
  readonly replies: Array<{ id: number; result?: any; error?: any }> = [];
  readonly killed: string[] = [];
  threadSeq = 0;
  turnSeq = 0;
  lastThreadId = '';
  lastTurnId = '';
  private buf = '';
  private known: Set<string>;

  constructor(private opts: FakeServerOptions = {}) {
    this.known = new Set(opts.knownThreads ?? []);
    const child = new EventEmitter() as any;
    child.pid = 40000 + Math.floor(Math.random() * 1000);
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.unref = vi.fn();
    child.kill = (sig: string) => {
      this.killed.push(sig);
      this.exit(0, sig);
      return true;
    };
    child.stdin = {
      write: (s: string) => {
        this.feed(s);
        return true;
      },
      end: vi.fn(),
    };
    this.child = child;

    if (opts.dieImmediately) setTimeout(() => this.exit(1, null), 0);
  }

  exit(code: number, signal: string | null): void {
    if (this.child.exitCode != null) return;
    this.child.exitCode = code;
    this.child.emit('exit', code, signal);
  }

  send(msg: unknown): void {
    this.child.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** 服务端主动发起的请求（审批之类） */
  serverRequest(id: number, method: string, params: unknown = {}): void {
    this.send({ jsonrpc: '2.0', id, method, params });
  }

  /** 跑完一轮：形状照抄真实 dump */
  completeTurn(text: string, opts: { deltas?: string[]; rateLimits?: boolean } = {}): void {
    const threadId = this.lastThreadId;
    const turnId = this.lastTurnId;
    this.notify('turn/started', {
      threadId,
      turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null },
    });
    for (const d of opts.deltas ?? [text]) {
      this.notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg_1', delta: d });
    }
    this.notify('item/completed', {
      item: { type: 'agentMessage', id: 'msg_1', text, phase: 'final_answer', memoryCitation: null },
      threadId,
      turnId,
      completedAtMs: 2,
    });
    if (opts.rateLimits !== false) {
      this.notify('account/rateLimits/updated', {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 1 }, planType: 'pro' },
      });
    }
    this.notify('turn/completed', {
      threadId,
      turn: {
        id: turnId,
        items: [{ type: 'agentMessage', id: 'msg_1', text, phase: 'final_answer', memoryCitation: null }],
        itemsView: 'summary',
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 100,
      },
    });
  }

  failTurn(message: string): void {
    this.notify('turn/completed', {
      threadId: this.lastThreadId,
      turn: { id: this.lastTurnId, items: [], itemsView: 'summary', status: 'failed', error: { message }, startedAt: 1, completedAt: 2, durationMs: 1 },
    });
  }

  interruptedTurn(): void {
    this.notify('turn/completed', {
      threadId: this.lastThreadId,
      turn: { id: this.lastTurnId, items: [], itemsView: 'summary', status: 'interrupted', error: null, startedAt: 1, completedAt: 2, durationMs: 1 },
    });
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const idx = this.buf.indexOf('\n');
      if (idx < 0) return;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method) this.handleRequest(msg);
      else this.replies.push(msg);
    }
  }

  private handleRequest(msg: { id?: number; method: string; params: any }): void {
    this.requests.push({ id: msg.id, method: msg.method, params: msg.params });
    // 立刻就崩的进程当然也不会回 initialize —— 不装死的话它会抢在退出定时器前把握手答完
    if (this.opts.dieImmediately) return;
    if (this.opts.onRequest?.(this, msg)) return;

    const reply = (result: unknown): void => this.send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string): void => this.send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    switch (msg.method) {
      case 'initialize':
        if (this.opts.silentInitialize) return;
        reply({
          userAgent: 'fake/0.0.1',
          codexHome: this.opts.codexHome ?? '/tmp/fake-codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        });
        return;
      case 'initialized':
        return;
      case 'thread/start': {
        const id = `th-new-${++this.threadSeq}`;
        this.known.add(id);
        this.lastThreadId = id;
        reply({ thread: { id, turns: [], status: { type: 'idle' } } });
        return;
      }
      case 'thread/resume': {
        const id = msg.params?.threadId as string;
        if (!this.known.has(id)) {
          fail(-32602, 'thread not found');
          return;
        }
        this.lastThreadId = id;
        reply({ thread: { id, turns: [], status: { type: 'idle' } } });
        return;
      }
      case 'turn/start': {
        const turnId = `turn-${++this.turnSeq}`;
        this.lastTurnId = turnId;
        this.lastThreadId = msg.params?.threadId ?? this.lastThreadId;
        reply({ turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } });
        if (!this.opts.manualTurn) setTimeout(() => this.completeTurn('答案'), 0);
        return;
      }
      case 'turn/interrupt':
        reply({});
        setTimeout(() => this.interruptedTurn(), 0);
        return;
      case 'thread/loaded/list':
        reply({ data: [...this.known], nextCursor: null });
        return;
      default:
        fail(-32601, `unknown ${msg.method}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return { conversationId: 'conv-1', text: '你好', mediaPaths: [], cwd: '/work', binding: null, ...overrides };
}

function binding(providerSessionId: string): SessionBinding {
  return { conversationId: 'conv-1', agentType: 'codex', providerSessionId, generation: 1, createdAt: 0, updatedAt: 0 };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

interface Harness {
  agent: CodexAppServerAgent;
  servers: FakeServer[];
  spawnFn: ReturnType<typeof vi.fn>;
  sleeps: number[];
  procOps: ProcOps & { alive: Set<number>; cmdlines: Map<number, string>; kills: Array<[number, string]> };
  pidFile: string;
  tmpDir: string;
}

let tmpRoot: string;

function makeAgent(opts: {
  serverFactory?: (n: number) => FakeServer;
  env?: NodeJS.ProcessEnv;
  fallback?: AgentAdapter;
  pidFileContent?: string;
} = {}): Harness {
  const servers: FakeServer[] = [];
  const sleeps: number[] = [];
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'agent-'));
  const pidFile = path.join(tmpDir, 'appserver-19999.pid');
  if (opts.pidFileContent != null) fs.writeFileSync(pidFile, opts.pidFileContent);

  const alive = new Set<number>();
  const cmdlines = new Map<number, string>();
  const kills: Array<[number, string]> = [];
  const procOps = {
    alive,
    cmdlines,
    kills,
    isAlive: (pid: number) => alive.has(pid),
    cmdline: (pid: number) => cmdlines.get(pid) ?? null,
    kill: (pid: number, sig: NodeJS.Signals) => {
      kills.push([pid, sig]);
      if (sig === 'SIGKILL') alive.delete(pid);
    },
  };

  const factory = opts.serverFactory ?? (() => new FakeServer());
  const spawnFn = vi.fn(() => {
    const s = factory(servers.length);
    servers.push(s);
    return s.child;
  });

  const agent = new CodexAppServerAgent({
    env: opts.env ?? {},
    pidFilePath: pidFile,
    spawnFn: spawnFn as any,
    procOps,
    fallback: opts.fallback,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    cwd: '/work',
  });

  return { agent, servers, spawnFn, sleeps, procOps, pidFile, tmpDir };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2wechat-appserver-test-'));
});

// ---------------------------------------------------------------------------

describe('纯函数 — 入参组装', () => {
  it('纯文本只有一个 text 元素，带空 text_elements', () => {
    expect(buildTurnInput('hi', [])).toEqual([{ type: 'text', text: 'hi', text_elements: [] }]);
  });

  it('图片走 localImage，音频走 localAudio', () => {
    const input = buildTurnInput('看图', ['/tmp/a.PNG', '/tmp/b.m4a']);
    expect(input[1]).toEqual({ type: 'localImage', path: '/tmp/a.PNG' });
    expect(input[2]).toEqual({ type: 'localAudio', path: '/tmp/b.m4a' });
  });

  it('不认识的扩展名退化成正文附注，不丢文件', () => {
    const input = buildTurnInput('看文件', ['/tmp/spec.pdf']);
    expect(input).toHaveLength(1);
    expect((input[0] as any).text).toContain('/tmp/spec.pdf');
  });

  it('text 永远是第一个元素（协议要求）', () => {
    const input = buildTurnInput('x', ['/a.png', '/b.png']);
    expect(input[0].type).toBe('text');
  });
});

describe('纯函数 — server request 兜底表', () => {
  // 漏一个 = 那一轮永久挂死，所以这张表逐条钉死
  it.each([
    ['execCommandApproval', { decision: 'approved' }],
    ['applyPatchApproval', { decision: 'approved' }],
    ['item/commandExecution/requestApproval', { decision: 'accept' }],
    ['item/fileChange/requestApproval', { decision: 'accept' }],
    ['mcpServer/elicitation/request', { action: 'decline' }],
    ['item/tool/requestUserInput', { answers: {} }],
    ['attestation/generate', { token: '' }],
  ])('%s → %o', (method, expected) => {
    expect(answerForServerRequest(method).result).toEqual(expected);
  });

  it('item/permissions/requestApproval 按 bypass 语义放行', () => {
    const r = answerForServerRequest('item/permissions/requestApproval').result as any;
    expect(r.permissions.network.enabled).toBe(true);
    expect(r.scope).toBe('session');
  });

  it('currentTime/read 回秒级 unix 时间', () => {
    const r = answerForServerRequest('currentTime/read').result as any;
    expect(typeof r.currentTimeAt).toBe('number');
    expect(Math.abs(r.currentTimeAt - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('未知方法也必须给个回应（哪怕是 error），不能沉默', () => {
    const r = answerForServerRequest('some/brand/new/request');
    expect(r.error?.code).toBe(-32601);
    expect(r.result).toBeUndefined();
  });

  it('lastAgentMessageOf 从 turn.items 捞最后一条', () => {
    expect(lastAgentMessageOf([{ type: 'agentMessage', text: 'a' }, { type: 'reasoning' }, { type: 'agentMessage', text: 'b' }])).toBe('b');
    expect(lastAgentMessageOf(undefined)).toBeNull();
  });
});

describe('spawn 参数', () => {
  it('起的是 app-server 且每次都带 bypass 配置', async () => {
    const h = makeAgent();
    await collect(h.agent.run(req(), new AbortController().signal));
    const args = h.spawnFn.mock.calls[0][1] as string[];
    expect(args[0]).toBe('app-server');
    expect(args.join(' ')).toContain('approval_policy="never"');
    expect(args.join(' ')).toContain('sandbox_mode="danger-full-access"');
    await h.agent.shutdown();
  });

  it('CC2WECHAT_CODEX_EFFORT 才注入 model_reasoning_effort（进程级）', () => {
    expect(appServerArgs({}).join(' ')).not.toContain('model_reasoning_effort');
    expect(appServerArgs({ CC2WECHAT_CODEX_EFFORT: 'low' } as NodeJS.ProcessEnv).join(' ')).toContain('model_reasoning_effort="low"');
  });

  it('CODEX_HOME 走 spawn env，不拼 shell', async () => {
    const h = makeAgent({ env: { CODEX_HOME: '/tmp/x-codex' } });
    await collect(h.agent.run(req(), new AbortController().signal));
    const opts = h.spawnFn.mock.calls[0][2] as any;
    expect(opts.env.CODEX_HOME).toBe('/tmp/x-codex');
    expect((h.spawnFn.mock.calls[0][1] as string[]).join(' ')).not.toContain('CODEX_HOME');
    await h.agent.shutdown();
  });
});

describe('握手', () => {
  it('initialize + initialized，codexHome 记下来', async () => {
    const h = makeAgent({ serverFactory: () => new FakeServer({ codexHome: '/Users/x/.codex' }) });
    await collect(h.agent.run(req(), new AbortController().signal));

    const methods = h.servers[0].requests.map((r) => r.method);
    expect(methods[0]).toBe('initialize');
    expect(methods).toContain('initialized');
    expect(methods.indexOf('initialized')).toBeGreaterThan(0);

    const init = h.servers[0].requests[0];
    expect(init.params.capabilities.experimentalApi).toBe(true);
    expect((await h.agent.health()).detail).toContain('/Users/x/.codex');
    await h.agent.shutdown();
  });
});

describe('一轮的完整流程', () => {
  it('新会话：thread/start → started + sessionChanged → final', async () => {
    const h = makeAgent();
    const events = await collect(h.agent.run(req(), new AbortController().signal));

    expect(events[0]).toEqual({ type: 'started', providerSessionId: 'th-new-1' });
    expect(events).toContainEqual({ type: 'sessionChanged', providerSessionId: 'th-new-1' });
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '答案' });

    const start = h.servers[0].requests.find((r) => r.method === 'thread/start')!;
    expect(start.params.cwd).toBe('/work');
    await h.agent.shutdown();
  });

  it('turn/start 每轮都带 bypass（camelCase tagged union）', async () => {
    const h = makeAgent();
    await collect(h.agent.run(req(), new AbortController().signal));
    const turn = h.servers[0].requests.find((r) => r.method === 'turn/start')!;
    expect(turn.params.approvalPolicy).toBe('never');
    // 写成 { mode: 'danger-full-access' } 会 -32600 missing field 'type'
    expect(turn.params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    expect(turn.params.input[0]).toEqual({ type: 'text', text: '你好', text_elements: [] });
    await h.agent.shutdown();
  });

  it('有绑定就 thread/resume，不再开新线程，也不重复 sessionChanged', async () => {
    const h = makeAgent({ serverFactory: () => new FakeServer({ knownThreads: ['th-old'] }) });
    const events = await collect(h.agent.run(req({ binding: binding('th-old') }), new AbortController().signal));

    const resume = h.servers[0].requests.find((r) => r.method === 'thread/resume')!;
    expect(resume.params).toMatchObject({ threadId: 'th-old', excludeTurns: true, cwd: '/work' });
    expect(h.servers[0].requests.find((r) => r.method === 'thread/start')).toBeUndefined();
    expect(events.find((e) => e.type === 'sessionChanged')).toBeUndefined();
    expect(events[0]).toEqual({ type: 'started', providerSessionId: 'th-old' });
    await h.agent.shutdown();
  });

  it('resume 失败 → 开新线程并 sessionChanged 换 id', async () => {
    const h = makeAgent({ serverFactory: () => new FakeServer({ knownThreads: [] }) });
    const events = await collect(h.agent.run(req({ binding: binding('th-gone') }), new AbortController().signal));

    expect(h.servers[0].requests.map((r) => r.method)).toContain('thread/start');
    expect(events).toContainEqual({ type: 'sessionChanged', providerSessionId: 'th-new-1' });
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '答案' });
    await h.agent.shutdown();
  });

  it('常驻：两轮之间不再 spawn（这就是 13.5s → 1.6s 的来源）', async () => {
    const h = makeAgent({ serverFactory: () => new FakeServer({ knownThreads: ['th-old'] }) });
    await collect(h.agent.run(req({ binding: binding('th-old') }), new AbortController().signal));
    await collect(h.agent.run(req({ binding: binding('th-old') }), new AbortController().signal));
    expect(h.spawnFn).toHaveBeenCalledTimes(1);
    await h.agent.shutdown();
  });
});

describe('事件映射', () => {
  it('delta 节流成 progress，item/completed 的 agentMessage 变 final', async () => {
    const h = makeAgent({
      serverFactory: () =>
        new FakeServer({
          manualTurn: true,
          onRequest: (s, m) => {
            if (m.method !== 'turn/start') return false;
            s.lastThreadId = m.params.threadId;
            s.lastTurnId = 'turn-x';
            s.send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-x', status: 'inProgress' } } });
            setTimeout(() => s.completeTurn('拼好的答案', { deltas: ['拼', '好', '的'] }), 0);
            return true;
          },
        }),
    });
    const events = await collect(h.agent.run(req(), new AbortController().signal));
    // 节流后至多一条 progress（三个 delta 在同一毫秒窗口里）
    expect(events.filter((e) => e.type === 'progress').length).toBeLessThanOrEqual(1);
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '拼好的答案' });
    await h.agent.shutdown();
  });

  it('account/rateLimits/updated 是状态播报，不是错误', async () => {
    const h = makeAgent();
    const events = await collect(h.agent.run(req(), new AbortController().signal));
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    await h.agent.shutdown();
  });

  it('turn.status=failed → error', async () => {
    const h = makeAgent({
      serverFactory: () =>
        new FakeServer({
          manualTurn: true,
          onRequest: (s, m) => {
            if (m.method !== 'turn/start') return false;
            s.lastThreadId = m.params.threadId;
            s.lastTurnId = 'turn-x';
            s.send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-x' } } });
            setTimeout(() => s.failTurn('You have hit your usage limit.'), 0);
            return true;
          },
        }),
    });
    const events = await collect(h.agent.run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.message).toBe('You have hit your usage limit.');
    expect(err.retryable).toBe(false);
    await h.agent.shutdown();
  });

  it('error{willRetry:true} 不打扰用户，最终答案照常送达', async () => {
    const h = makeAgent({
      serverFactory: () =>
        new FakeServer({
          manualTurn: true,
          onRequest: (s, m) => {
            if (m.method !== 'turn/start') return false;
            s.lastThreadId = m.params.threadId;
            s.lastTurnId = 'turn-x';
            s.send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-x' } } });
            setTimeout(() => {
              s.notify('error', { error: { message: 'stream disconnected' }, willRetry: true, threadId: s.lastThreadId, turnId: 'turn-x' });
              s.completeTurn('重试后的答案');
            }, 0);
            return true;
          },
        }),
    });
    const events = await collect(h.agent.run(req(), new AbortController().signal));
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '重试后的答案' });
    await h.agent.shutdown();
  });

  it('error{willRetry:false} 立刻收口成 error', async () => {
    const h = makeAgent({
      serverFactory: () =>
        new FakeServer({
          manualTurn: true,
          onRequest: (s, m) => {
            if (m.method !== 'turn/start') return false;
            s.lastThreadId = m.params.threadId;
            s.lastTurnId = 'turn-x';
            s.send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-x' } } });
            setTimeout(() => {
              s.notify('error', { error: { message: '401 unauthorized' }, willRetry: false, threadId: s.lastThreadId, turnId: 'turn-x' });
            }, 0);
            return true;
          },
        }),
    });
    const events = await collect(h.agent.run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.message).toBe('401 unauthorized');
    expect(err.retryable).toBe(false);
    await h.agent.shutdown();
  });

  it('服务端发来的审批请求会被应答（不然这轮永久挂死）', async () => {
    const h = makeAgent({
      serverFactory: () =>
        new FakeServer({
          manualTurn: true,
          onRequest: (s, m) => {
            if (m.method !== 'turn/start') return false;
            s.lastThreadId = m.params.threadId;
            s.lastTurnId = 'turn-x';
            s.send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'turn-x' } } });
            setTimeout(() => {
              s.serverRequest(9001, 'execCommandApproval', { callId: 'c1', conversationId: s.lastThreadId, command: ['rm', '-rf', 'x'] });
              setTimeout(() => s.completeTurn('干完了'), 5);
            }, 0);
            return true;
          },
        }),
    });
    const events = await collect(h.agent.run(req(), new AbortController().signal));
    const approval = h.servers[0].replies.find((r) => r.id === 9001);
    expect(approval?.result).toEqual({ decision: 'approved' });
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '干完了' });
    await h.agent.shutdown();
  });
});

describe('打断', () => {
  it('/stop → turn/interrupt（不是 kill 进程），并且安静收尾', async () => {
    const h = makeAgent({ serverFactory: () => new FakeServer({ manualTurn: true }) });
    const ctrl = new AbortController();

    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of h.agent.run(req(), ctrl.signal)) events.push(e);
    })();

    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    await expect(done).resolves.toBeUndefined();

    const interrupt = h.servers[0].requests.find((r) => r.method === 'turn/interrupt');
    expect(interrupt).toBeDefined();
    expect(interrupt!.params.turnId).toBe('turn-1');
    // 进程要活着 —— 上面可能还挂着别的会话
    expect(h.servers[0].killed).toEqual([]);
    // 回执由命令层发，agent 再喊一句就是双回复
    expect(events.find((e) => e.type === 'final' || e.type === 'error')).toBeUndefined();
    await h.agent.shutdown();
  });

  it('进来时已经 abort 就不 spawn', async () => {
    const h = makeAgent();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await collect(h.agent.run(req(), ctrl.signal))).toEqual([]);
    expect(h.spawnFn).not.toHaveBeenCalled();
  });
});

describe('崩溃自愈', () => {
  it('轮到一半后端没了 → 可重试的 error，措辞告诉用户会自己接上', async () => {
    const h = makeAgent({ serverFactory: () => new FakeServer({ manualTurn: true }) });
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of h.agent.run(req(), new AbortController().signal)) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 20));
    h.servers[0].exit(9, null);
    await done;

    const err = events.find((e) => e.type === 'error') as any;
    expect(err.code).toBe('codex-appserver-lost');
    expect(err.retryable).toBe(true);
  });

  it('下一轮自动重启并 resume 续上（binding 还在）', async () => {
    const h = makeAgent({ serverFactory: () => new FakeServer({ knownThreads: ['th-old'] }) });
    await collect(h.agent.run(req({ binding: binding('th-old') }), new AbortController().signal));
    h.servers[0].exit(9, null);

    await collect(h.agent.run(req({ binding: binding('th-old') }), new AbortController().signal));
    expect(h.spawnFn).toHaveBeenCalledTimes(2);
    expect(h.servers[1].requests.find((r) => r.method === 'thread/resume')?.params.threadId).toBe('th-old');
    await h.agent.shutdown();
  });

  it('起不来时按 1s / 5s 退避重试', async () => {
    let n = 0;
    const h = makeAgent({
      serverFactory: () => {
        n++;
        return n < 3 ? new FakeServer({ dieImmediately: true }) : new FakeServer();
      },
    });
    const events = await collect(h.agent.run(req(), new AbortController().signal));
    expect(h.sleeps).toEqual([1000, 5000]);
    expect(h.spawnFn).toHaveBeenCalledTimes(3);
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '答案' });
    await h.agent.shutdown();
  });

  it('连续 3 次起不来 → 进程级降级到 exec，health 报 degraded', async () => {
    const fallbackRun = vi.fn(async function* () {
      yield { type: 'final', text: 'exec 顶上了' } as AgentEvent;
    });
    const fallback: AgentAdapter = {
      name: 'codex',
      persistent: false,
      run: fallbackRun as any,
      reset: vi.fn(async () => {}),
      health: vi.fn(async () => ({ ok: true })),
      shutdown: vi.fn(async () => {}),
    };

    const h = makeAgent({ serverFactory: () => new FakeServer({ dieImmediately: true }), fallback });

    const first = await collect(h.agent.run(req(), new AbortController().signal));
    expect(h.spawnFn).toHaveBeenCalledTimes(3);
    expect(first[first.length - 1]).toEqual({ type: 'final', text: 'exec 顶上了' });

    // 降级之后不再尝试 app-server：直接走 exec
    const second = await collect(h.agent.run(req(), new AbortController().signal));
    expect(h.spawnFn).toHaveBeenCalledTimes(3);
    expect(second).toEqual([{ type: 'final', text: 'exec 顶上了' }]);

    const health = await h.agent.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('degraded');
    await h.agent.shutdown();
  });
});

describe('孤儿防护与 pid 文件', () => {
  it('起进程时写 pid，shutdown 时清掉', async () => {
    const h = makeAgent();
    await collect(h.agent.run(req(), new AbortController().signal));
    expect(fs.readFileSync(h.pidFile, 'utf-8')).toBe(String(h.servers[0].child.pid));
    await h.agent.shutdown();
    expect(fs.existsSync(h.pidFile)).toBe(false);
  });

  it('pid 还活着且命令行是 app-server → 先 SIGTERM 再 SIGKILL', async () => {
    const h = makeAgent({ pidFileContent: '31337' });
    h.procOps.alive.add(31337);
    h.procOps.cmdlines.set(31337, '/usr/local/bin/codex app-server --stdio');

    await collect(h.agent.run(req(), new AbortController().signal));
    expect(h.procOps.kills).toEqual([
      [31337, 'SIGTERM'],
      [31337, 'SIGKILL'],
    ]);
    await h.agent.shutdown();
  });

  it('pid 被复用给了别的进程 → 绝不误杀', async () => {
    const h = makeAgent({ pidFileContent: '31338' });
    h.procOps.alive.add(31338);
    h.procOps.cmdlines.set(31338, '/Applications/Safari.app/Contents/MacOS/Safari');

    await collect(h.agent.run(req(), new AbortController().signal));
    expect(h.procOps.kills).toEqual([]);
    await h.agent.shutdown();
  });

  it('pid 早死了 → 静默清理，不报错', async () => {
    const h = makeAgent({ pidFileContent: '31339' });
    await collect(h.agent.run(req(), new AbortController().signal));
    expect(h.procOps.kills).toEqual([]);
    expect(fs.readFileSync(h.pidFile, 'utf-8')).toBe(String(h.servers[0].child.pid));
    await h.agent.shutdown();
  });
});

describe('health / shutdown', () => {
  it('没起过进程时是 ok（懒启动不是故障）', async () => {
    const h = makeAgent();
    const r = await h.agent.health();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('懒启动');
  });

  it('起来之后查 thread/loaded/list', async () => {
    const h = makeAgent();
    await collect(h.agent.run(req(), new AbortController().signal));
    const r = await h.agent.health();
    expect(r.ok).toBe(true);
    expect(h.servers[0].requests.map((x) => x.method)).toContain('thread/loaded/list');
    await h.agent.shutdown();
  });

  it('CODEX_HOME 串号 → 不健康（用错身份比挂了更糟）', async () => {
    const h = makeAgent({
      env: { CODEX_HOME: '/Users/x/.codex-wechat' },
      serverFactory: () => new FakeServer({ codexHome: '/Users/x/.codex' }),
    });
    await collect(h.agent.run(req(), new AbortController().signal));
    const r = await h.agent.health();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('CODEX_HOME 不符');
    await h.agent.shutdown();
  });

  it('shutdown 关 stdin 再 SIGTERM', async () => {
    const h = makeAgent();
    await collect(h.agent.run(req(), new AbortController().signal));
    await h.agent.shutdown();
    expect(h.servers[0].child.stdin.end).toHaveBeenCalled();
    expect(h.servers[0].killed).toContain('SIGTERM');
  });

  it('元信息：常驻', () => {
    const h = makeAgent();
    expect(h.agent.name).toBe('codex');
    expect(h.agent.persistent).toBe(true);
  });
});
