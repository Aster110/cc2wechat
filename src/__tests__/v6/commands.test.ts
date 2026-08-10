import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchCommand, tryHandleCommand } from '../../v6/commands.js';

function makeDeps(overrides: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const scheduler = {
    abort: vi.fn().mockReturnValue(true),
    clear: vi.fn().mockReturnValue(0),
    enqueue: vi.fn(),
    depth: vi.fn().mockReturnValue(0),
    running: vi.fn().mockReturnValue(false),
    drain: vi.fn(),
  };
  const store = {
    get: vi.fn().mockReturnValue(null),
    saveProviderSession: vi.fn(),
    touch: vi.fn(),
    bump: vi.fn(),
    drop: vi.fn(),
    expireIdle: vi.fn().mockReturnValue([]),
  };
  const agent = { reset: vi.fn().mockResolvedValue(undefined) };
  const deps = {
    conversationId: 'conv-1',
    reply: vi.fn(async (t: string) => {
      replies.push(t);
    }),
    scheduler: scheduler as any,
    store: store as any,
    agent: agent as any,
    ...overrides,
  };
  return { deps, replies, scheduler, store, agent };
}

describe('matchCommand', () => {
  it('精确匹配四组命令(trim + lowercase)', () => {
    expect(matchCommand('/new')).toBe('new');
    expect(matchCommand('  /NEW  ')).toBe('new');
    expect(matchCommand('/exit')).toBe('exit');
    expect(matchCommand('退出')).toBe('exit');
    expect(matchCommand('结束')).toBe('exit');
    expect(matchCommand('/stop')).toBe('stop');
    expect(matchCommand('停止')).toBe('stop');
    expect(matchCommand('/help')).toBe('help');
    expect(matchCommand('帮助')).toBe('help');
  });

  it('只认精确匹配,句子里带命令词不算', () => {
    expect(matchCommand('帮我 /new 一下')).toBeNull();
    expect(matchCommand('/newxyz')).toBeNull();
    expect(matchCommand('结束了吗')).toBeNull();
    expect(matchCommand('')).toBeNull();
    expect(matchCommand('你好')).toBeNull();
  });
});

describe('tryHandleCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('普通消息返回 false,什么都不做', async () => {
    const { deps, scheduler, store } = makeDeps();
    expect(await tryHandleCommand('今天天气怎么样', deps)).toBe(false);
    expect(scheduler.abort).not.toHaveBeenCalled();
    expect(store.bump).not.toHaveBeenCalled();
    expect(deps.reply).not.toHaveBeenCalled();
  });

  it('/new：abort + clear + bump + agent.reset,回"已开启新对话"', async () => {
    const { deps, replies, scheduler, store, agent } = makeDeps();
    expect(await tryHandleCommand('/new', deps)).toBe(true);
    expect(scheduler.abort).toHaveBeenCalledWith('conv-1');
    expect(scheduler.clear).toHaveBeenCalledWith('conv-1');
    expect(store.bump).toHaveBeenCalledWith('conv-1');
    expect(agent.reset).toHaveBeenCalledWith('conv-1');
    expect(store.drop).not.toHaveBeenCalled();
    expect(replies).toEqual(['已开启新对话 ✨']);
  });

  it('/stop：只 abort,不清排队,不动会话绑定', async () => {
    const { deps, replies, scheduler, store, agent } = makeDeps();
    scheduler.abort.mockReturnValue(true);
    expect(await tryHandleCommand('/stop', deps)).toBe(true);
    expect(scheduler.abort).toHaveBeenCalledWith('conv-1');
    expect(scheduler.clear).not.toHaveBeenCalled();
    expect(store.bump).not.toHaveBeenCalled();
    expect(store.drop).not.toHaveBeenCalled();
    expect(agent.reset).not.toHaveBeenCalled();
    expect(replies[0]).toContain('已停止当前任务');
    expect(replies[0]).toContain('上下文保留');
  });

  it('/stop 没有任务在跑时如实告知', async () => {
    const { deps, replies, scheduler } = makeDeps();
    scheduler.abort.mockReturnValue(false);
    await tryHandleCommand('停止', deps);
    expect(replies).toEqual(['没有正在执行的任务']);
  });

  it('/exit：abort + clear + drop + agent.reset,回告别语', async () => {
    const { deps, replies, scheduler, store, agent } = makeDeps();
    expect(await tryHandleCommand('退出', deps)).toBe(true);
    expect(scheduler.abort).toHaveBeenCalledWith('conv-1');
    expect(scheduler.clear).toHaveBeenCalledWith('conv-1');
    expect(store.drop).toHaveBeenCalledWith('conv-1');
    expect(store.bump).not.toHaveBeenCalled();
    expect(agent.reset).toHaveBeenCalledWith('conv-1');
    expect(replies[0]).toContain('会话已关闭');
  });

  it('/help 列出全部四个命令', async () => {
    const { deps, replies } = makeDeps();
    expect(await tryHandleCommand('帮助', deps)).toBe(true);
    const help = replies[0];
    expect(help).toContain('/new');
    expect(help).toContain('/stop');
    expect(help).toContain('/exit');
    expect(help).toContain('/help');
  });

  it('agent.reset 失败不影响回复(用户要看到反馈)', async () => {
    const { deps, replies, agent } = makeDeps();
    agent.reset.mockRejectedValue(new Error('backend down'));
    await expect(tryHandleCommand('/new', deps)).resolves.toBe(true);
    expect(replies).toEqual(['已开启新对话 ✨']);
  });
});
