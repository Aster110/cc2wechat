import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import type { AIBackend, LaunchOpts, ChatOpts, PipeOpts, BackendEvent } from '../interfaces/index.js';

// codex 没有"指定 id 创建会话"的能力：thread_id 由首次 exec 生成。
// 这里维护 bridge sessionId(userIdToSessionUUID) → codex thread_id 的映射，按端口分文件，
// 重置某用户上下文 = 删掉映射文件里对应条目（或整个文件）。
const CHAT_TIMEOUT_MS = 10 * 60_000;
// aster 的使用习惯：codex 全程 bypass（等价 config.toml 的 approval_policy=never + danger-full-access，
// 但显式带旗更稳，与 claude-code 后端的 --dangerously-skip-permissions 对称）
const BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

function mapFile(): string {
  const port = process.env.CC2WECHAT_PORT ?? '18081';
  return path.join(os.homedir(), '.cc2wechat', `codex-threads-${port}.json`);
}

function loadThreads(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(mapFile(), 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveThread(sessionId: string, threadId: string): void {
  const m = loadThreads();
  if (m[sessionId] === threadId) return;
  m[sessionId] = threadId;
  fs.mkdirSync(path.dirname(mapFile()), { recursive: true });
  fs.writeFileSync(mapFile(), JSON.stringify(m, null, 2), 'utf-8');
}

function dropThread(sessionId: string): void {
  const m = loadThreads();
  if (!(sessionId in m)) return;
  delete m[sessionId];
  fs.writeFileSync(mapFile(), JSON.stringify(m, null, 2), 'utf-8');
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function codexEnvPrefix(): string {
  return process.env.CODEX_HOME ? `CODEX_HOME=${shellQuote(process.env.CODEX_HOME)} ` : '';
}

/**
 * 微信是聊天场景，等不起 xhigh 推理档（实测一轮 2~6 分钟）。
 * 设 CC2WECHAT_CODEX_EFFORT 覆盖 config.toml 的 model_reasoning_effort；
 * 不设就沿用 config.toml，不擅自改用户的默认档。
 */
function effortFlags(): string[] {
  const effort = process.env.CC2WECHAT_CODEX_EFFORT;
  return effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
}

export class CodexBackend implements AIBackend {
  readonly name = 'codex';

  // /new、/exit 时丢掉 thread 绑定，下一条消息开全新 codex 会话。
  // 不删 codex 自己的 rollout 文件（那是历史记录，用户可能还要翻）。
  resetSession(sessionId: string): void {
    dropThread(sessionId);
  }

  buildLaunchCommand(opts: LaunchOpts): string {
    const thread = loadThreads()[opts.resumeSessionId ?? opts.sessionId];
    if (thread) {
      return `cd ${opts.cwd} && ${codexEnvPrefix()}codex ${BYPASS_FLAG} resume ${thread}`;
    }
    return `cd ${opts.cwd} && ${codexEnvPrefix()}codex ${BYPASS_FLAG}; exit`;
  }

  async *chat(opts: ChatOpts): AsyncIterable<BackendEvent> {
    const thread = loadThreads()[opts.sessionId];
    // 注意：`codex exec resume` 不支持 -C/--cd（只有 `codex exec` 有），
    // 所以工作目录统一靠子进程 cwd 传，两条路径共用同一套旗子。
    // `--` 兜住以 - 开头的用户输入，避免被当成旗子解析。
    const flags = [BYPASS_FLAG, '--json', '--skip-git-repo-check', ...effortFlags()];
    const args = thread
      ? ['exec', 'resume', ...flags, '--', thread, opts.message]
      : ['exec', ...flags, '--', opts.message];

    const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
    let stderrTail = '';
    child.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHAT_TIMEOUT_MS);

    try {
      const rl = readline.createInterface({ input: child.stdout });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: BackendEvent;
        try {
          event = JSON.parse(trimmed) as BackendEvent;
        } catch {
          continue; // 非 JSON 行（banner 等）直接跳过
        }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          saveThread(opts.sessionId, event.thread_id);
        }
        yield event;
      }
      const code = await new Promise<number>((resolve) => {
        child.on('close', (c) => resolve(c ?? 0));
        if (child.exitCode != null) resolve(child.exitCode);
      });
      if (timedOut) {
        // SIGKILL 后 close code 是 null，不特判就会变成沉默的 "[No response]"
        yield {
          type: 'error',
          message: `这轮超过 ${Math.round(CHAT_TIMEOUT_MS / 60_000)} 分钟没跑完，已中止。把任务拆小一点再试。`,
        };
      } else if (code !== 0) {
        yield { type: 'error', message: `codex exited ${code}: ${stderrTail.slice(-300)}` };
      }
    } finally {
      clearTimeout(killer);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
  }

  buildPipeCommand(opts: PipeOpts): string {
    const thread = loadThreads()[opts.sessionId];
    const outFile = `/tmp/codex-last-${process.env.CC2WECHAT_PORT ?? '18081'}.txt`;
    const effort = effortFlags().map(shellQuote).join(' ');
    const flags = `${BYPASS_FLAG} --skip-git-repo-check${effort ? ' ' + effort : ''} -o ${shellQuote(outFile)}`;
    // 同 chat()：resume 不吃 -C，改用 cd 进工作目录
    const base = thread
      ? `${codexEnvPrefix()}codex exec resume ${flags} -- ${shellQuote(thread)} ${shellQuote(opts.prompt)}`
      : `${codexEnvPrefix()}codex exec ${flags} -- ${shellQuote(opts.prompt)}`;
    return `cd ${shellQuote(opts.cwd)} && ${base} >/dev/null 2>&1; cat ${shellQuote(outFile)}`;
  }

  extractResult(events: BackendEvent[]): string {
    for (const event of [...events].reverse()) {
      if (event.type === 'item.completed') {
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text;
      }
    }
    for (const event of [...events].reverse()) {
      if (event.type === 'turn.failed') {
        const err = event.error as { message?: string } | undefined;
        if (err?.message) return `[codex] ${err.message}`;
      }
      if (event.type === 'error' && typeof event.message === 'string') {
        return `[codex] ${event.message}`;
      }
    }
    return '';
  }
}
