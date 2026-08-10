import type { Scheduler, SessionStore } from './contracts.js';

export type CommandName = 'new' | 'stop' | 'exit' | 'help';

/**
 * 精确匹配表(trim + lowercase,沿用 v5 gateway 的口径)。
 * 只认整条消息就是命令 —— "帮我 /new 一下"是聊天内容,不是指令。
 */
const TRIGGERS: Record<string, CommandName> = {
  '/new': 'new',
  '/stop': 'stop',
  停止: 'stop',
  '/exit': 'exit',
  退出: 'exit',
  结束: 'exit',
  '/help': 'help',
  帮助: 'help',
};

const HELP_TEXT = [
  '可用命令：',
  '/new  - 开启新对话（清空上下文）',
  '/stop - 停止当前任务（上下文保留）',
  '/exit - 关闭会话（退出 / 结束）',
  '/help - 显示帮助',
  '',
  '直接发消息即可与 AI 对话',
].join('\n');

/** 只负责丢绑定,不删后端历史文件 */
export interface ResettableAgent {
  reset(conversationId: string): Promise<void>;
}

export interface CommandDeps {
  conversationId: string;
  reply: (text: string) => Promise<void>;
  scheduler: Scheduler;
  store: SessionStore;
  agent: ResettableAgent;
}

export function matchCommand(text: string): CommandName | null {
  return TRIGGERS[text.trim().toLowerCase()] ?? null;
}

/**
 * 命中就地执行并返回 true。
 * 调用方(poller)在**入队之前**调它 —— 控制命令必须能抢占,
 * 排在长任务后面的 /stop 等于没有 /stop。
 */
export async function tryHandleCommand(text: string, deps: CommandDeps): Promise<boolean> {
  const cmd = matchCommand(text);
  if (!cmd) return false;
  await runCommand(cmd, deps);
  return true;
}

export async function runCommand(cmd: CommandName, deps: CommandDeps): Promise<void> {
  const { conversationId, reply, scheduler, store, agent } = deps;

  switch (cmd) {
    case 'new': {
      scheduler.abort(conversationId);
      scheduler.clear(conversationId);
      store.bump(conversationId);
      await safeReset(agent, conversationId);
      await reply('已开启新对话 ✨');
      return;
    }
    case 'stop': {
      // 只打断当前这一轮:排队的照跑,绑定不动 —— 用户要的是"别跑了",不是"忘了我"
      const hit = scheduler.abort(conversationId);
      await reply(hit ? '已停止当前任务 ⏹（上下文保留）' : '没有正在执行的任务');
      return;
    }
    case 'exit': {
      scheduler.abort(conversationId);
      scheduler.clear(conversationId);
      store.drop(conversationId);
      await safeReset(agent, conversationId);
      await reply('会话已关闭，下次发消息自动开启新对话 👋');
      return;
    }
    case 'help': {
      await reply(HELP_TEXT);
      return;
    }
  }
}

/** 后端挂了也得让用户看到命令生效了,别把 reset 的异常冒到微信 */
async function safeReset(agent: ResettableAgent, conversationId: string): Promise<void> {
  try {
    await agent.reset(conversationId);
  } catch {
    /* 绑定已在 store 侧清掉,后端侧清理失败不影响下一轮开新会话 */
  }
}
