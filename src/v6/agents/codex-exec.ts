import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

import type { AgentAdapter, AgentEvent, AgentHealth, AgentRequest } from '../contracts.js';

/**
 * aster 的使用习惯:codex 全程 bypass(等价 config.toml 的 approval_policy=never
 * + danger-full-access,但显式带旗更稳)。
 */
const BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const STDERR_TAIL_MAX = 2000;
const STDERR_IN_MESSAGE = 300;

/**
 * 微信是聊天场景,等不起 xhigh 推理档(实测一轮 2~6 分钟)。
 * 设 CC2WECHAT_CODEX_EFFORT 覆盖 config.toml 的 model_reasoning_effort;
 * 不设就沿用 config.toml,不擅自改用户的默认档。
 */
function effortFlags(): string[] {
  const effort = process.env.CC2WECHAT_CODEX_EFFORT;
  return effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
}

interface CodexLine {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: { type?: string; text?: string };
  error?: { message?: string };
}

/**
 * 一次性 spawn 的 codex agent(persistent=false)。
 *
 * 两条从 v5 生产里带血带泪搬过来的约束:
 * 1. `codex exec resume` **不支持 -C/--cd**(只有 `codex exec` 有)——工作目录只能靠子进程 cwd
 * 2. 错误提取里语义失败优先于 `codex exited N` 噪音——否则用户看到一句莫名其妙的 invalid YAML,
 *    真正的原因(配额用尽/鉴权失效)被盖掉
 *
 * 不内置墙钟看门狗，用户 /stop、进程关停或显式运维超时统一由 AbortSignal 管。
 *
 * 2026-08-10 提速:拿到答案就吐,不等进程退出。
 * 实测 `turn.completed` 到进程真的 exit 还有 3.3~3.8 秒(收尾写 rollout、卸 MCP 子服务),
 * 这三秒全算在用户等待里 —— 而那时候答案早就躺在手上了。
 */
export class CodexExecAgent implements AgentAdapter {
  readonly name = 'codex';
  readonly persistent = false;

  /**
   * 我们不再等它退出,但也不能撒手不管:
   * - stdout 要继续排空,否则管道写满,子进程卡在 write 上永远收不了尾
   * - exit 要挂个监听让 Node 帮我们 reap,不然留一地僵尸
   * - unref 让它别拖住事件循环(daemon 要能正常退出)
   */
  private detach(child: ReturnType<typeof spawn>): void {
    try {
      child.stdout?.resume();
      child.stderr?.resume();
      child.once('exit', () => {});
      child.unref();
    } catch {
      /* 已经没了 */
    }
  }

  async *run(req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (signal.aborted) return;

    const threadId = req.binding?.providerSessionId || '';
    const flags = [BYPASS_FLAG, '--json', '--skip-git-repo-check', ...effortFlags()];
    // `--` 兜住以 - 开头的用户输入,避免被当成旗子解析。全程 argv 数组,不拼 shell 字符串。
    const args = threadId
      ? ['exec', 'resume', ...flags, '--', threadId, req.text]
      : ['exec', ...flags, '--', req.text];

    const child = spawn('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: req.cwd,
      env: { ...process.env },
    });

    let stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_MAX);
    });

    /** 已经交付答案、把子进程放生了 —— finally 里就不能再补刀 */
    let detached = false;

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let lastAgentMessage: string | null = null;
    let semanticError: string | null = null;
    let answered = false;

    try {
      yield { type: 'started' };

      const rl = readline.createInterface({ input: child.stdout! });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: CodexLine;
        try {
          event = JSON.parse(trimmed) as CodexLine;
        } catch {
          continue; // 非 JSON 行(banner 等)直接跳过
        }

        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          yield { type: 'sessionChanged', providerSessionId: event.thread_id };
          continue;
        }
        if (event.type === 'item.completed') {
          const item = event.item;
          if (item?.type === 'agent_message' && typeof item.text === 'string') {
            lastAgentMessage = item.text;
          } else if (item?.type) {
            yield { type: 'progress', text: item.type };
          }
          continue;
        }
        // 这一轮已经完了,答案在手上 —— 剩下的 3 秒是 codex 自己在收尾,不该由用户来等
        if (event.type === 'turn.completed' && lastAgentMessage != null) {
          if (signal.aborted) return;
          answered = true;
          detached = true;
          this.detach(child);
          yield { type: 'final', text: lastAgentMessage };
          return;
        }
        if (event.type === 'turn.failed' && event.error?.message) {
          semanticError = event.error.message;
          continue;
        }
        if (event.type === 'error' && typeof event.message === 'string') {
          // `codex exited N` 是我们自己在 v5 里合成的噪音口径,这里同样排除
          if (!event.message.startsWith('codex exited')) semanticError = event.message;
        }
      }

      if (signal.aborted) return; // 用户 /stop 或超时:安静收尾,回什么话由上层决定

      // 流断了但没见到 turn.completed(老版本 codex / 输出被截断):
      // 只要答案在手上就照样立刻交付,同样不等退出码。
      if (!answered && lastAgentMessage != null) {
        answered = true;
        detached = true;
        this.detach(child);
        yield { type: 'final', text: lastAgentMessage };
        return;
      }

      // 到这里说明**没有**答案,那退出码/stderr 就是唯一线索,只好等它退。
      const code = await new Promise<number>((resolve) => {
        child.on('close', (c) => resolve(c ?? 0));
        if (child.exitCode != null) resolve(child.exitCode);
      });

      if (signal.aborted) return;

      // ---- 结果优先级(与 v5 extractResult 同序)----
      if (semanticError) {
        yield { type: 'error', code: 'codex-turn-failed', message: semanticError, retryable: false };
        return;
      }
      if (code !== 0) {
        yield {
          type: 'error',
          code: 'codex-exit',
          message: `codex exited ${code}: ${stderrTail.slice(-STDERR_IN_MESSAGE)}`,
          retryable: true,
        };
        return;
      }
      // v5 这里返回空串,router 就什么也不回,用户对着屏幕干等。宁可说一句人话。
      yield {
        type: 'error',
        code: 'codex-no-output',
        message: '这轮没有拿到任何输出（codex 没有产出 agent_message）',
        retryable: true,
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      // detached 的那条路是"答案已交付、让它自己收尾",这时候补刀等于把 rollout 写坏
      if (!detached && child.exitCode == null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经没了 */
        }
      }
    }
  }

  /** 绑定归 SessionStore 管;codex 自己的 rollout 历史文件不删(用户可能还要翻) */
  async reset(_conversationId: string): Promise<void> {}

  async health(): Promise<AgentHealth> {
    return { ok: true, detail: 'spawn-per-turn' };
  }

  async shutdown(): Promise<void> {}
}
