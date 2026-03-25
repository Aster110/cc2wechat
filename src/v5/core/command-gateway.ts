import type { Delivery } from '../interfaces/index.js';
import { log } from '../shared/logger.js';

/**
 * 命令网关：拦截微信消息中的指令，在到达 CC 之前处理
 *
 * 时间开销：一次 Map.get() 查找，O(1)，约 0.001ms，可忽略
 */

export interface CommandContext {
  userId: string;
  contextToken: string;
  text: string;
  delivery: Delivery;
  // 回复微信的函数（由外部注入，解耦 wechat-api）
  reply: (text: string) => Promise<void>;
  // 关闭 session 的函数（由外部注入，解耦 delivery 实现）
  closeSession: (userId: string) => Promise<void>;
  // 创建新 session（关旧开新）
  createNewSession: (userId: string) => Promise<void>;
}

export interface CommandHandler {
  description: string;
  handler: (ctx: CommandContext) => Promise<void>;
}

export class CommandGateway {
  private commands = new Map<string, CommandHandler>();

  register(triggers: string[], handler: CommandHandler): void {
    for (const trigger of triggers) {
      this.commands.set(trigger.toLowerCase(), handler);
    }
  }

  /**
   * 尝试匹配并执行命令
   * @returns true = 已处理（不需要路由到 CC），false = 普通消息
   */
  async tryHandle(ctx: CommandContext): Promise<boolean> {
    const trimmed = ctx.text.trim().toLowerCase();
    const handler = this.commands.get(trimmed);
    if (!handler) return false;

    log(`-> command: "${trimmed}" (${handler.description})`);
    await handler.handler(ctx);
    return true;
  }
}

/**
 * 创建默认网关，注册内置命令
 */
export function createDefaultGateway(): CommandGateway {
  const gw = new CommandGateway();

  // /new → 关旧窗口 + 立刻开新窗口
  gw.register(['/new'], {
    description: 'new session',
    handler: async (ctx) => {
      await ctx.closeSession(ctx.userId);
      await ctx.createNewSession(ctx.userId);
      await ctx.reply('已开启新对话 ✨');
    },
  });

  // /exit, 退出, 结束 → 关闭会话，告别
  gw.register(['/exit', '退出', '结束'], {
    description: 'close session',
    handler: async (ctx) => {
      await ctx.closeSession(ctx.userId);
      await ctx.reply('会话已关闭，下次发消息会自动开启新对话 👋');
    },
  });

  // /help → 显示可用命令
  gw.register(['/help', '帮助'], {
    description: 'show help',
    handler: async (ctx) => {
      await ctx.reply([
        '可用命令：',
        '/new - 关闭当前对话，开启新对话',
        '/exit - 关闭当前对话',
        '/help - 显示帮助',
        '',
        '直接发消息即可与 AI 对话',
      ].join('\n'));
    },
  });

  return gw;
}
