import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { log, logError } from '../../utils.js';
import type { AgentAdapter, AgentEvent, AgentHealth, AgentRequest } from '../contracts.js';
import { CodexExecAgent } from './codex-exec.js';

/**
 * 常驻 codex agent —— 载体是 `codex app-server`。
 *
 * 为什么不是 `codex exec`:实测(2026-08-10 探针)同一条 thread 追加一轮,
 * exec 每轮 13.5s(每次冷启 + 读盘),app-server 常驻进程 1.6s。
 * 为什么不是 mcp-server:app-server 才有 turn/interrupt、thread/loaded/list 这些运维接口。
 *
 * 协议要点(全部实测,别凭印象改):
 * - 传输是**换行分隔的 JSON-RPC 2.0**,不是 LSP 的 Content-Length 分帧
 * - bypass 必须**每轮**带 `approvalPolicy:'never'` + `sandboxPolicy:{type:'dangerFullAccess'}`
 *   (camelCase tagged union;写成 `{mode:'danger-full-access'}` 会 -32600 missing field 'type')
 * - 打断是 `turn/interrupt`,不是 kill 进程 —— 杀进程会把同一个 app-server 上别的会话一起带走
 * - 服务端发过来的 ServerRequest **必须应答**,不答那一轮永远挂着(见 answerForServerRequest)
 * - `account/rateLimits/updated` 只是状态播报,不是错误
 */

const BYPASS_CONFIG = [
  '-c',
  'approval_policy="never"',
  '-c',
  'sandbox_mode="danger-full-access"',
  // 常驻进程别去跑用户的 notify 钩子:一轮一次弹窗/脚本,微信场景纯噪音
  '-c',
  'notify=[]',
];

const BACKOFF_MS = [1_000, 5_000, 30_000];
const MAX_START_FAILURES = 3;
const INITIALIZE_TIMEOUT_MS = 30_000;
const THREAD_OP_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 1_000;
const SHUTDOWN_GRACE_MS = 2_000;
const ORPHAN_KILL_GRACE_MS = 300;
const PROGRESS_THROTTLE_MS = 1_000;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.amr', '.silk', '.opus']);

/** 连接死掉时给订阅者的合成信号,不是协议里的方法名 */
const LOST = '__connection_lost__';

// ---------------------------------------------------------------------------
// 纯函数(单测直接打这里)
// ---------------------------------------------------------------------------

/**
 * 微信是聊天场景,等不起 xhigh 推理档。
 * 与 codex-exec 同口径:设了才注入,不擅自改用户 config.toml 的默认档。
 * app-server 是进程级注入(整个常驻进程一个档),不是每轮参数。
 */
export function effortConfigFlags(env: NodeJS.ProcessEnv): string[] {
  const effort = env.CC2WECHAT_CODEX_EFFORT;
  return effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
}

export function appServerArgs(env: NodeJS.ProcessEnv): string[] {
  return ['app-server', '--stdio', ...BYPASS_CONFIG, ...effortConfigFlags(env)];
}

export interface UserInputItem {
  type: string;
  [key: string]: unknown;
}

/**
 * 组装 turn/start 的 input。
 * 图片/音频走 localImage / localAudio(codex 能真的看/听);
 * 其余扩展名(pdf、zip、docx…)codex 没有对应的输入类型,退化成正文里附一行路径 ——
 * 让模型自己决定要不要去读这个文件,总比默默丢掉强。
 */
export function buildTurnInput(text: string, mediaPaths: string[]): UserInputItem[] {
  const media: UserInputItem[] = [];
  const notes: string[] = [];

  for (const p of mediaPaths) {
    const ext = path.extname(p).toLowerCase();
    if (IMAGE_EXT.has(ext)) media.push({ type: 'localImage', path: p });
    else if (AUDIO_EXT.has(ext)) media.push({ type: 'localAudio', path: p });
    else notes.push(`[附件] ${p}`);
  }

  const fullText = notes.length > 0 ? `${text}\n${notes.join('\n')}` : text;
  return [{ type: 'text', text: fullText, text_elements: [] }, ...media];
}

export interface ServerRequestReply {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * 服务端 → 客户端的请求应答表。
 *
 * **这张表漏一个,那一轮就永久挂死** —— codex 在等我们回话,而我们在等 turn/completed。
 * 语义按 aster 的使用习惯(全程 bypass)一律准了;
 * 需要人当场决策的(MCP elicitation、工具追问)一律拒绝而不是挂着 —— 微信那头没人能填表单。
 */
export function answerForServerRequest(method: string): ServerRequestReply {
  switch (method) {
    // 旧版审批入口
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'approved' } };

    // v2 审批入口
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'accept' } };

    case 'item/permissions/requestApproval':
      return { result: { permissions: { network: { enabled: true }, fileSystem: {} }, scope: 'session' } };

    // 没人能回答的,明确拒绝,别把 turn 吊在那
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline' } };
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } };
    case 'item/tool/call':
      return { result: { contentItems: [], success: false } };

    case 'attestation/generate':
      // initialize 时已声明 requestAttestation:false,正常不会走到这
      return { result: { token: '' } };
    case 'currentTime/read':
      return { result: { currentTimeAt: Math.floor(Date.now() / 1000) } };

    case 'account/chatgptAuthTokens/refresh':
      return { error: { code: -32601, message: 'cc2wechat 不持有 ChatGPT 凭据,无法刷新' } };

    default:
      // 未知方法也要回 —— 回错误至少能让 codex 往下走,沉默只会挂死
      return { error: { code: -32601, message: `cc2wechat 未处理的 server request: ${method}` } };
  }
}

/** turn/completed 里 turn.items 是 summary 视图,兜底从里面捞最后一条 agentMessage */
export function lastAgentMessageOf(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  let text: string | null = null;
  for (const raw of items) {
    const item = raw as { type?: string; text?: string };
    if (item?.type === 'agentMessage' && typeof item.text === 'string') text = item.text;
  }
  return text;
}

// ---------------------------------------------------------------------------
// 事件队列:通知是推过来的,run() 是拉的,中间要一个缓冲
// ---------------------------------------------------------------------------

class EventQueue {
  private items: AgentEvent[] = [];
  private closed = false;
  private waiter: (() => void) | null = null;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.items.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}

// ---------------------------------------------------------------------------
// 一条 app-server 连接
// ---------------------------------------------------------------------------

export interface RpcResult {
  result?: any;
  error?: { code: number; message: string };
}

type NotifyHandler = (method: string, params: any) => void;

export class AppServerConnection {
  codexHome = '';
  alive = true;

  private nextId = 1;
  private pending = new Map<number, (r: RpcResult) => void>();
  private subs = new Map<string, NotifyHandler>();
  private stderrTail = '';
  private deadReason = '';
  private exitWaiters: Array<() => void> = [];

  constructor(
    readonly child: ChildProcess,
    private readonly onExit: (conn: AppServerConnection) => void,
  ) {
    this.attach();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  subscribe(threadId: string, handler: NotifyHandler): () => void {
    this.subs.set(threadId, handler);
    return () => {
      if (this.subs.get(threadId) === handler) this.subs.delete(threadId);
    };
  }

  /**
   * 请求不 reject,失败也走 `{error}` —— 调用方全是"失败就换条路"的分支,
   * 到处 try/catch 只会让 run() 里的控制流长得像迷宫。
   */
  request(method: string, params: unknown, timeoutMs: number): Promise<RpcResult> {
    return new Promise<RpcResult>((resolve) => {
      if (!this.alive) {
        resolve({ error: { code: -1, message: this.deadReason || 'app-server 已退出' } });
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: -2, message: `${method} 超过 ${timeoutMs}ms 没有回应` } });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** stdin 关 → SIGTERM → 宽限期后 SIGKILL */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    if (!this.alive) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* 管道早没了 */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* 已经没了 */
    }
    const exited = await this.waitExit(graceMs);
    if (!exited) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
      await this.waitExit(graceMs);
    }
  }

  private waitExit(ms: number): Promise<boolean> {
    if (!this.alive) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      if (typeof timer.unref === 'function') timer.unref();
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private attach(): void {
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    if (this.child.stdout) {
      const rl = readline.createInterface({ input: this.child.stdout });
      rl.on('line', (line) => this.onLine(line));
    }
    this.child.on('error', (err) => {
      this.die(`spawn 失败: ${err.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.die(`app-server 退出 code=${code} signal=${signal}${this.stderrTail ? ` stderr=${this.stderrTail.slice(-300)}` : ''}`);
    });
  }

  private onLine(line: string): void {
    const s = line.trim();
    if (!s.startsWith('{')) return; // banner / 日志行
    let msg: any;
    try {
      msg = JSON.parse(s);
    } catch {
      return;
    }

    // 我们发出去的请求的回包
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve({ result: msg.result, error: msg.error });
      }
      return;
    }

    // 服务端发起的请求:必须回,不然那一轮永久挂死
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      const reply = answerForServerRequest(msg.method);
      this.write({ jsonrpc: '2.0', id: msg.id, ...reply });
      return;
    }

    if (typeof msg.method === 'string') {
      const params = msg.params ?? {};
      const threadId = typeof params.threadId === 'string' ? params.threadId : '';
      const handler = threadId ? this.subs.get(threadId) : undefined;
      handler?.(msg.method, params);
    }
  }

  private write(msg: unknown): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.die(`写 stdin 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private die(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.deadReason = reason;

    for (const [, resolve] of this.pending) resolve({ error: { code: -3, message: reason } });
    this.pending.clear();

    // 正在跑的那些轮要立刻知道后端没了,否则它们会等到 turn 超时(默认 10 分钟)
    for (const [, handler] of [...this.subs]) handler(LOST, { reason });
    this.subs.clear();

    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();

    this.onExit(this);
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface ProcOps {
  isAlive(pid: number): boolean;
  cmdline(pid: number): string | null;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export const defaultProcOps: ProcOps = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  cmdline(pid) {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
    } catch {
      return null;
    }
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已经没了 */
    }
  },
};

export interface CodexAppServerOptions {
  env?: NodeJS.ProcessEnv;
  /** 健康检查端口,只用来给 pid 文件命名(一台机器多账号 = 多 daemon = 多 app-server) */
  port?: number;
  pidFilePath?: string;
  spawnFn?: typeof spawn;
  procOps?: ProcOps;
  /** 降级目标,默认内部造一个 CodexExecAgent */
  fallback?: AgentAdapter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number[];
  cwd?: string;
  clientVersion?: string;
}

export class CodexAppServerAgent implements AgentAdapter {
  readonly name = 'codex';
  readonly persistent = true;

  private conn: AppServerConnection | null = null;
  private starting: Promise<AppServerConnection> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private degraded = false;
  private degradeReason = '';
  private fallbackAgent: AgentAdapter | null;
  private shuttingDown = false;

  private readonly env: NodeJS.ProcessEnv;
  private readonly procOps: ProcOps;
  private readonly spawnFn: typeof spawn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoff: number[];

  constructor(private readonly opts: CodexAppServerOptions = {}) {
    this.env = opts.env ?? process.env;
    this.procOps = opts.procOps ?? defaultProcOps;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.backoff = opts.backoffMs ?? BACKOFF_MS;
    this.fallbackAgent = opts.fallback ?? null;
  }

  // ---- 对外契约 ----------------------------------------------------------

  async *run(req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (signal.aborted) return;

    if (this.degraded) {
      yield* this.fallback().run(req, signal);
      return;
    }

    let conn: AppServerConnection;
    try {
      conn = await this.ensure();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.degraded) {
        logError(`[codex] ${message}`);
        yield* this.fallback().run(req, signal);
        return;
      }
      yield { type: 'error', code: 'codex-appserver-unavailable', message, retryable: true };
      return;
    }
    if (signal.aborted) return;

    const wanted = req.binding?.providerSessionId || '';
    const resolved = await this.resolveThread(conn, wanted, req.cwd);
    if (signal.aborted) return;
    if (!resolved.threadId) {
      yield {
        type: 'error',
        code: 'codex-thread-start-failed',
        message: resolved.error ?? '开不了 codex 线程',
        retryable: true,
      };
      return;
    }

    const threadId = resolved.threadId;
    yield { type: 'started', providerSessionId: threadId };
    if (threadId !== wanted) yield { type: 'sessionChanged', providerSessionId: threadId };

    yield* this.runTurn(conn, threadId, req, signal);
  }

  /** 绑定归 SessionStore 管;codex 自己的 rollout 历史不删(用户可能还要翻) */
  async reset(conversationId: string): Promise<void> {
    if (this.fallbackAgent) await this.fallbackAgent.reset(conversationId);
  }

  async health(): Promise<AgentHealth> {
    if (this.degraded) {
      return { ok: false, detail: `degraded → codex-exec(${this.degradeReason})` };
    }
    const conn = this.conn;
    if (!conn || !conn.alive) {
      return { ok: true, detail: 'app-server 未启动(懒启动,下一条消息拉起)' };
    }

    const expected = (this.env.CODEX_HOME ?? '').trim();
    if (expected && conn.codexHome && path.resolve(conn.codexHome) !== path.resolve(expected)) {
      // 账号目录串了 = 用错身份在跟人聊天,比挂了还糟
      return { ok: false, detail: `CODEX_HOME 不符:期望 ${expected},实际 ${conn.codexHome}` };
    }

    const r = await conn.request('thread/loaded/list', {}, HEALTH_TIMEOUT_MS);
    if (r.error) return { ok: false, detail: `thread/loaded/list: ${r.error.message}` };
    const loaded = Array.isArray(r.result?.data) ? r.result.data.length : 0;
    return { ok: true, detail: `app-server up, loadedThreads=${loaded}, codexHome=${conn.codexHome || 'unknown'}` };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const conn = this.conn;
    this.conn = null;
    if (conn) await conn.shutdown(SHUTDOWN_GRACE_MS);
    this.clearPidFile();
    if (this.fallbackAgent) await this.fallbackAgent.shutdown();
  }

  // ---- 一轮 --------------------------------------------------------------

  private async resolveThread(
    conn: AppServerConnection,
    wanted: string,
    cwd: string,
  ): Promise<{ threadId: string; error?: string }> {
    if (wanted) {
      const r = await conn.request('thread/resume', { threadId: wanted, excludeTurns: true, cwd }, THREAD_OP_TIMEOUT_MS);
      if (!r.error) {
        const id = (r.result?.thread?.id as string | undefined) ?? wanted;
        return { threadId: id };
      }
      // 续不上就开新的:历史丢了总比这条消息石沉大海强,换了 id 会 yield sessionChanged
      log(`[codex] thread/resume ${wanted.slice(0, 8)} 失败(${r.error.message}),改开新线程`);
    }

    const started = await conn.request('thread/start', { cwd }, THREAD_OP_TIMEOUT_MS);
    if (started.error) return { threadId: '', error: started.error.message };
    const id = started.result?.thread?.id as string | undefined;
    if (!id) return { threadId: '', error: 'thread/start 没有返回 thread.id' };
    return { threadId: id };
  }

  private async *runTurn(
    conn: AppServerConnection,
    threadId: string,
    req: AgentRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const queue = new EventQueue();

    let turnId = '';
    let finalText: string | null = null;
    let lastError: { message: string; retryable: boolean } | null = null;
    let lastProgressAt = 0;
    let deltaChars = 0;
    let settled = false;

    const settle = (event?: AgentEvent): void => {
      if (settled) return;
      settled = true;
      if (event) queue.push(event);
      queue.close();
    };

    const unsubscribe = conn.subscribe(threadId, (method, params) => {
      switch (method) {
        case LOST:
          settle({
            type: 'error',
            code: 'codex-appserver-lost',
            message: `codex app-server 中途退出(${String(params?.reason ?? '')});下一条消息会自动重启并续上这个会话`,
            retryable: true,
          });
          return;

        case 'turn/started':
          if (!turnId && typeof params?.turn?.id === 'string') turnId = params.turn.id;
          return;

        case 'item/agentMessage/delta': {
          deltaChars += typeof params?.delta === 'string' ? params.delta.length : 0;
          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
            lastProgressAt = now;
            queue.push({ type: 'progress', text: `agentMessage ${deltaChars}字` });
          }
          return;
        }

        case 'item/completed': {
          const item = params?.item as { type?: string; text?: string } | undefined;
          if (item?.type === 'agentMessage' && typeof item.text === 'string') finalText = item.text;
          else if (item?.type && item.type !== 'userMessage') queue.push({ type: 'progress', text: item.type });
          return;
        }

        case 'error': {
          const message =
            (typeof params?.error?.message === 'string' && params.error.message) ||
            (typeof params?.message === 'string' && params.message) ||
            'codex 报了一个没有正文的错误';
          const willRetry = params?.willRetry === true;
          lastError = { message, retryable: willRetry };
          if (willRetry) {
            // codex 自己会重试,这时候给用户发"出错了"纯属吓人;真挂了 turn/completed 会带 failed
            queue.push({ type: 'progress', text: `重试中: ${message.slice(0, 80)}` });
          } else {
            settle({ type: 'error', code: 'codex-error', message, retryable: false });
          }
          return;
        }

        case 'turn/completed': {
          const turn = (params?.turn ?? {}) as { status?: string; error?: { message?: string }; items?: unknown };
          if (turn.status === 'interrupted') {
            settle();
            return;
          }
          if (turn.status === 'failed') {
            settle({
              type: 'error',
              code: 'codex-turn-failed',
              message: turn.error?.message ?? lastError?.message ?? 'turn failed',
              retryable: false,
            });
            return;
          }
          const text = finalText ?? lastAgentMessageOf(turn.items);
          if (text != null) {
            settle({ type: 'final', text });
          } else if (lastError) {
            settle({ type: 'error', code: 'codex-turn-error', message: lastError.message, retryable: lastError.retryable });
          } else {
            settle({
              type: 'error',
              code: 'codex-no-output',
              message: '这轮没有拿到任何输出（codex 没有产出 agentMessage）',
              retryable: true,
            });
          }
          return;
        }

        // account/rateLimits/updated 是状态播报不是错误;warning 是 chronicle 那类
        // "长得像错误的正常事件";其余 thread/* mcpServer/* item/started 一律不打扰用户。
        default:
          return;
      }
    });

    const interrupt = (): void => {
      if (!turnId) return;
      // 打断是发消息,不是杀进程 —— 这个 app-server 上还挂着别人的会话
      conn.notify('turn/interrupt', { threadId, turnId });
    };

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      interrupt();
      // 被 /stop 打断的一轮不回话 —— 回执由命令层发,agent 再喊一句就成了双回复
      settle();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const ack = await conn.request(
        'turn/start',
        {
          threadId,
          input: buildTurnInput(req.text, req.mediaPaths),
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
        },
        THREAD_OP_TIMEOUT_MS,
      );

      if (ack.error) {
        settle({ type: 'error', code: 'codex-turn-start-failed', message: ack.error.message, retryable: true });
      } else {
        if (!turnId && typeof ack.result?.turn?.id === 'string') turnId = ack.result.turn.id;
        // abort 可能赶在 ack 回来之前:那会儿还没有 turnId,补一刀
        if (aborted) interrupt();
      }

      for await (const event of queue.drain()) {
        if (aborted) break;
        yield event;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
    }
  }

  // ---- 进程生命周期 ------------------------------------------------------

  private fallback(): AgentAdapter {
    if (!this.fallbackAgent) this.fallbackAgent = new CodexExecAgent();
    return this.fallbackAgent;
  }

  private async ensure(): Promise<AppServerConnection> {
    if (this.conn?.alive) return this.conn;
    if (this.starting) return this.starting;
    this.starting = this.startWithBackoff().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startWithBackoff(): Promise<AppServerConnection> {
    for (;;) {
      const wait = this.nextAttemptAt - this.now();
      if (wait > 0) await this.sleep(wait);

      try {
        const conn = await this.startOnce();
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.conn = conn;
        return conn;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.failures++;
        logError(`codex app-server 起不来 (${this.failures}/${MAX_START_FAILURES}): ${message}`);

        if (this.failures >= MAX_START_FAILURES) {
          // 降级不是权宜之计:exec 与 app-server 共用同一套 rollout 存储,
          // 会话历史一条不丢,只是每轮慢十来秒。比微信那头彻底哑掉强。
          this.degraded = true;
          this.degradeReason = message;
          throw new Error(`codex app-server 连续 ${MAX_START_FAILURES} 次起不来,降级到一次性 spawn:${message}`);
        }
        this.nextAttemptAt = this.now() + (this.backoff[Math.min(this.failures - 1, this.backoff.length - 1)] ?? 0);
      }
    }
  }

  private async startOnce(): Promise<AppServerConnection> {
    await this.killOrphan();

    const child = this.spawnFn('codex', appServerArgs(this.env), {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd ?? process.cwd(),
      env: { ...this.env } as NodeJS.ProcessEnv,
    });

    const conn = new AppServerConnection(child, (dead) => this.handleExit(dead));
    this.writePidFile(child.pid);

    const init = await conn.request(
      'initialize',
      {
        clientInfo: { name: 'cc2wechat', title: 'cc2wechat', version: this.opts.clientVersion ?? '6.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      INITIALIZE_TIMEOUT_MS,
    );
    if (init.error) {
      await conn.shutdown(SHUTDOWN_GRACE_MS);
      throw new Error(`initialize 失败: ${init.error.message}`);
    }

    conn.codexHome = typeof init.result?.codexHome === 'string' ? init.result.codexHome : '';
    conn.notify('initialized', {});
    log(`[codex] app-server 就绪 pid=${child.pid ?? '?'} codexHome=${conn.codexHome || 'unknown'}`);
    return conn;
  }

  private handleExit(dead: AppServerConnection): void {
    if (this.conn === dead) this.conn = null;
    this.clearPidFile();
    if (this.shuttingDown) return;
    logError('codex app-server 掉了,下一条消息会重启并 thread/resume 续上会话');
  }

  // ---- PID 文件 / 孤儿清理 ------------------------------------------------

  private pidFilePath(): string {
    if (this.opts.pidFilePath) return this.opts.pidFilePath;
    const port = this.opts.port ?? Number(this.env.CC2WECHAT_PORT ?? 18081);
    return path.join(os.homedir(), '.cc2wechat', `appserver-${port}.pid`);
  }

  /**
   * daemon 被 SIGKILL(launchctl kickstart -k / kill -9)时来不及收尾,
   * 会留下一个还活着的 app-server 抓着 ~/.codex/thread-writer-locks/<threadId>.lock。
   * 新进程再 resume 同一条 thread 就会撞锁。所以起之前先按 pid 文件收尸。
   */
  private async killOrphan(): Promise<void> {
    const file = this.pidFilePath();
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) {
      this.clearPidFile();
      return;
    }
    if (!this.procOps.isAlive(pid)) {
      this.clearPidFile();
      return;
    }

    // pid 会被复用。不校验命令行就敢 kill,迟早误杀别人的进程。
    const cmd = this.procOps.cmdline(pid) ?? '';
    if (!cmd.includes('app-server')) {
      log(`[codex] pid ${pid} 不是 app-server(${cmd.slice(0, 60)}),不动它`);
      this.clearPidFile();
      return;
    }

    log(`[codex] 清理孤儿 app-server pid=${pid}`);
    this.procOps.kill(pid, 'SIGTERM');
    await this.sleep(ORPHAN_KILL_GRACE_MS);
    if (this.procOps.isAlive(pid)) this.procOps.kill(pid, 'SIGKILL');
    this.clearPidFile();
  }

  private writePidFile(pid: number | undefined): void {
    if (!pid) return;
    const file = this.pidFilePath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, String(pid), { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      logError(`写 app-server pid 文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private clearPidFile(): void {
    try {
      fs.rmSync(this.pidFilePath(), { force: true });
    } catch {
      /* 没有就算了 */
    }
  }
}
