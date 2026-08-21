/**
 * waku-dm 的文本命令词表与回执文案（契约 §3.3「文本命令沿用 V1/v6：/new /stop /exit /help」）。
 *
 * 触发表直接复用 v6 `commands.ts` 的 `matchCommand`（trim + lowercase 精确匹配，
 * 含「停止 / 退出 / 结束 / 帮助」中文别名）：同一个人在微信和 Waku 里学到的是同一套口令。
 * 执行语义不在这里——ingress 把命令翻成 Core 的 control（stop / new）；这里只管词表与文案。
 */
import { matchCommand, type CommandName } from '../../v6/commands.js';

export type DmCommand = CommandName;

export function matchDmCommand(text: string): DmCommand | null {
  return matchCommand(text);
}

const HELP_TEXT = [
  '可用命令：',
  '/new  - 开启新对话（清空上下文）',
  '/stop - 停止当前任务（上下文保留）',
  '/exit - 关闭会话（退出 / 结束）',
  '/help - 显示帮助',
  '',
  '直接发文字即可与 Codex 对话；图片/语音暂不支持。',
].join('\n');

export const DM_REPLY = {
  help: HELP_TEXT,
  new: '已开启新对话 ✨',
  stop: '已停止当前任务 ⏹（上下文保留）',
  stopNoop: '没有正在执行的任务',
  exit: '会话已关闭，下次发消息自动开启新对话 👋',
} as const;
