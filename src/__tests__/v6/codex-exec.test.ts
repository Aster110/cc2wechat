import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { CodexExecAgent } from '../../v6/agents/codex-exec.js';
import type { AgentEvent, AgentRequest, SessionBinding } from '../../v6/contracts.js';

/** 假 codex 子进程:stdout 吐给定的行,exitCode 直接就位(等价"已经退出") */
function fakeChild(opts: { stdout?: string[]; stderr?: string; exitCode?: number | null; holdOpen?: boolean } = {}) {
  const child = new EventEmitter() as any;
  const lines = opts.stdout ?? [];
  child.stdout = opts.holdOpen
    ? new Readable({ read() {} }) // 永不结束,给 abort 测试用
    : Readable.from(lines.map((l) => `${l}\n`));
  child.stderr = new Readable({
    read() {
      if (opts.stderr) this.push(opts.stderr);
      this.push(null);
    },
  });
  child.exitCode = opts.exitCode === undefined ? 0 : opts.exitCode;
  child.kill = vi.fn(() => {
    child.exitCode = null;
    if (opts.holdOpen) child.stdout.push(null);
    return true;
  });
  child.unref = vi.fn();
  vi.spyOn(child.stdout, 'resume');
  return child;
}

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    conversationId: 'conv-1',
    text: 'hello',
    mediaPaths: [],
    cwd: '/work',
    binding: null,
    ...overrides,
  };
}

function binding(providerSessionId: string): SessionBinding {
  return {
    conversationId: 'conv-1',
    agentType: 'codex',
    providerSessionId,
    generation: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const savedEffort = process.env.CC2WECHAT_CODEX_EFFORT;
const savedCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  spawnMock.mockReset();
  delete process.env.CC2WECHAT_CODEX_EFFORT;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  if (savedEffort == null) delete process.env.CC2WECHAT_CODEX_EFFORT;
  else process.env.CC2WECHAT_CODEX_EFFORT = savedEffort;
  if (savedCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

describe('CodexExecAgent — 参数构造', () => {
  it('无绑定 = 新会话:codex exec ... -- <text>,cwd 走子进程', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: ['{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'] }));
    await collect(new CodexExecAgent().run(req(), new AbortController().signal));

    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args.slice(0, 1)).toEqual(['exec']);
    expect(args).not.toContain('resume');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('hello');
    expect(opts.cwd).toBe('/work');
  });

  it('有绑定 = 续会话:exec resume ... -- <threadId> <text>', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: ['{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'] }));
    await collect(new CodexExecAgent().run(req({ binding: binding('thread-abc') }), new AbortController().signal));

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args[args.length - 3]).toBe('--');
    expect(args[args.length - 2]).toBe('thread-abc');
    expect(args[args.length - 1]).toBe('hello');
  });

  it('空 providerSessionId(bump 之后)当新会话处理', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: [] }));
    await collect(new CodexExecAgent().run(req({ binding: binding('') }), new AbortController().signal));
    expect(spawnMock.mock.calls[0][1]).not.toContain('resume');
  });

  // 2026-08-06 实测:`codex exec resume` 不吃 -C(clap 报 "to pass '-C' as a value"),
  // 第二条消息起全部报错。这条守住"别再把 -C 加回来"。
  it('never passes -C to codex (工作目录只能靠子进程 cwd)', async () => {
    for (const b of [null, binding('thread-abc')]) {
      spawnMock.mockReturnValue(fakeChild({ stdout: [] }));
      await collect(new CodexExecAgent().run(req({ binding: b }), new AbortController().signal));
      const [, args, opts] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
      expect(args).not.toContain('-C');
      expect(args).not.toContain('--cd');
      expect(opts.cwd).toBe('/work');
    }
  });

  it('全程是 args 数组,没有任何 shell 字符串/shell:true', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: [] }));
    await collect(new CodexExecAgent().run(req({ text: "rm -rf / ; echo 'pwned'" }), new AbortController().signal));
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(Array.isArray(args)).toBe(true);
    expect(opts.shell).toBeUndefined();
    // 用户输入原样进 argv,不做引号拼接
    expect(args[args.length - 1]).toBe("rm -rf / ; echo 'pwned'");
  });

  it('CC2WECHAT_CODEX_EFFORT 存在才注入 -c model_reasoning_effort', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: [] }));
    await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    expect((spawnMock.mock.calls[0][1] as string[]).join(' ')).not.toContain('model_reasoning_effort');

    process.env.CC2WECHAT_CODEX_EFFORT = 'medium';
    spawnMock.mockReturnValue(fakeChild({ stdout: [] }));
    await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    const args = spawnMock.mock.calls[1][1] as string[];
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="medium"');
  });

  it('CODEX_HOME 走 spawn 的 env 选项,不做 shell 前缀', async () => {
    process.env.CODEX_HOME = '/Users/x/.codex-924';
    spawnMock.mockReturnValue(fakeChild({ stdout: [] }));
    await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(opts.env.CODEX_HOME).toBe('/Users/x/.codex-924');
    expect(args.join(' ')).not.toContain('CODEX_HOME');
  });
});

describe('CodexExecAgent — 流式事件', () => {
  it('thread.started → sessionChanged,agent_message → final', async () => {
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: [
          '{"type":"thread.started","thread_id":"th-1"}',
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"答案"}}',
          '{"type":"turn.completed"}',
        ],
      }),
    );
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));

    expect(events[0]).toEqual({ type: 'started' });
    expect(events).toContainEqual({ type: 'sessionChanged', providerSessionId: 'th-1' });
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '答案' });
  });

  it('多条 agent_message 取最后一条', async () => {
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: [
          '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
          '{"type":"item.completed","item":{"type":"command_execution","text":"ls"}}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}',
        ],
      }),
    );
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: 'final answer' });
  });

  it('非 JSON 行(banner 等)直接跳过,不影响结果', async () => {
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: [
          'OpenAI Codex v1.2.3',
          '',
          'not json at all',
          '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
        ],
      }),
    );
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: 'ok' });
  });

  it('事件是流式吐的,不是攒完数组再吐', async () => {
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: [
          '{"type":"thread.started","thread_id":"th-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
        ],
      }),
    );
    const seen: string[] = [];
    for await (const e of new CodexExecAgent().run(req(), new AbortController().signal)) {
      seen.push(e.type);
      // sessionChanged 必须在 final 之前就到手(orchestrator 靠它及时存绑定)
      if (e.type === 'sessionChanged') expect(seen).not.toContain('final');
    }
    expect(seen.indexOf('sessionChanged')).toBeLessThan(seen.indexOf('final'));
  });
});

// 实测：turn.completed 之后 codex 还要 3.3~3.8s 才真的退出（写 rollout、卸 MCP 子服务）。
// 那三秒的等待原本整个算在用户头上，而答案早就在手里了。
describe('CodexExecAgent — 拿到答案就交付，不等进程退出', () => {
  it('看到 turn.completed 立刻 final —— 进程一直不退也不影响', async () => {
    // exitCode=null 且永远不 emit close：老实现会在这里挂死
    const child = fakeChild({
      stdout: [
        '{"type":"thread.started","thread_id":"th-1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"答案"}}',
        '{"type":"turn.completed"}',
      ],
      exitCode: null,
    });
    spawnMock.mockReturnValue(child);

    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '答案' });
    expect(child.exitCode).toBeNull(); // 交付的时候它还活着
  });

  it('放生而不是补刀：不 kill、排空 stdout、unref 防僵尸', async () => {
    const child = fakeChild({
      stdout: [
        '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
        '{"type":"turn.completed"}',
      ],
      exitCode: null,
    });
    spawnMock.mockReturnValue(child);

    await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    // 补刀会把 rollout 写坏 —— 那是下一轮 resume 的依据
    expect(child.kill).not.toHaveBeenCalled();
    // 不排空管道，子进程会卡在 write 上永远收不了尾
    expect(child.stdout.resume).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
  });

  it('只 final 一次（turn.completed 之后流再断也不补发）', async () => {
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: [
          '{"type":"item.completed","item":{"type":"agent_message","text":"一次就好"}}',
          '{"type":"turn.completed"}',
        ],
        exitCode: null,
      }),
    );
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });

  it('没有 turn.completed 但流断了：有答案照样立刻交付', async () => {
    const child = fakeChild({
      stdout: ['{"type":"item.completed","item":{"type":"agent_message","text":"旧版本也认"}}'],
      exitCode: null,
    });
    spawnMock.mockReturnValue(child);
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '旧版本也认' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('没有答案时才等退出码（错误路径的语义一点没变）', async () => {
    const child = fakeChild({ stdout: ['{"type":"turn.completed"}'], exitCode: null, stderr: 'boom' });
    spawnMock.mockReturnValue(child);
    setTimeout(() => child.emit('close', 3), 5);
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.message).toContain('codex exited 3');
  });

  it('abort 语义不变：中途打断照样 SIGKILL，不产出 final', async () => {
    const child = fakeChild({ holdOpen: true });
    spawnMock.mockReturnValue(child);
    const ctrl = new AbortController();
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of new CodexExecAgent().run(req(), ctrl.signal)) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await done;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(events.find((e) => e.type === 'final')).toBeUndefined();
  });
});

describe('CodexExecAgent — 错误优先级(移植自 v5 的三条回归)', () => {
  it('语义失败优先于进程退出噪音', async () => {
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: [
          '{"type":"thread.started","thread_id":"th-1"}',
          '{"type":"error","message":"You\'ve hit your usage limit."}',
          '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}',
        ],
        exitCode: 1,
        stderr: 'md: invalid YAML: did not find expected key',
      }),
    );
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.message).toBe("You've hit your usage limit.");
    expect(err.message).not.toContain('invalid YAML');
  });

  it('没有别的解释时才报进程退出错误', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: [], exitCode: 1, stderr: 'something broke' }));
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.message).toContain('codex exited 1');
    expect(err.message).toContain('something broke');
  });

  it('有正常答复时,退出码噪音不该盖掉答复', async () => {
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: ['{"type":"item.completed","item":{"type":"agent_message","text":"答完了"}}'],
        exitCode: 1,
        stderr: 'skill 加载警告',
      }),
    );
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'final', text: '答完了' });
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
  });

  it('close 事件异步到达时也能拿到退出码', async () => {
    const child = fakeChild({ stdout: [], exitCode: null, stderr: 'boom' });
    spawnMock.mockReturnValue(child);
    setTimeout(() => child.emit('close', 2), 5);
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err.message).toContain('codex exited 2');
  });

  it('什么都没产出时给一句人话,而不是静默', async () => {
    spawnMock.mockReturnValue(fakeChild({ stdout: [], exitCode: 0 }));
    const events = await collect(new CodexExecAgent().run(req(), new AbortController().signal));
    const err = events.find((e) => e.type === 'error') as any;
    expect(err).toBeDefined();
    expect(err.code).toBe('codex-no-output');
  });
});

describe('CodexExecAgent — abort', () => {
  it('signal abort → SIGKILL 子进程并正常 return(不 throw)', async () => {
    const child = fakeChild({ holdOpen: true });
    spawnMock.mockReturnValue(child);
    const ctrl = new AbortController();

    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of new CodexExecAgent().run(req(), ctrl.signal)) events.push(e);
    })();

    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await expect(done).resolves.toBeUndefined();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // 被中止的一轮不产出 final/error —— 回什么话由 orchestrator/命令层决定
    expect(events.find((e) => e.type === 'final' || e.type === 'error')).toBeUndefined();
  });

  it('进来时 signal 已经 abort 了就别 spawn', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const events = await collect(new CodexExecAgent().run(req(), ctrl.signal));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('CodexExecAgent — 元信息', () => {
  it('name/persistent 与常驻实现区分开', () => {
    const a = new CodexExecAgent();
    expect(a.name).toBe('codex');
    expect(a.persistent).toBe(false);
  });

  it('reset 是 no-op:绑定归 store 管,不删 codex 历史文件', async () => {
    await expect(new CodexExecAgent().reset('conv-1')).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('health / shutdown 可用', async () => {
    const a = new CodexExecAgent();
    expect((await a.health()).ok).toBe(true);
    await expect(a.shutdown()).resolves.toBeUndefined();
  });
});
