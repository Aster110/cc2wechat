import fs from 'node:fs';
import path from 'node:path';

import { CcRegistry } from './cc-registry.js';

/**
 * transcript 回程 —— daemon 侧零 token 读回复。
 *
 * ## 完成判据(本文件最重要的一个决定)
 *
 * **主判据:`type==="assistant"` 且 `message.stop_reason === "end_turn"`。**
 *
 * 依据是真实 jsonl 的统计,不是猜的:
 * `~/.claude/projects/-Users-aster-AIproject-mylife/5fd29018-….jsonl`
 * 1275 条 assistant 记录里 stop_reason 只有两种 ——
 * `tool_use` 1207 条(全部带 tool_use / thinking / 中间叙述),`end_turn` 68 条(agent 循环收工)。
 * 也就是说 stop_reason 就是模型自己说的"我这轮说完了 vs 我还要调工具",
 * 比"末条是文本 + 静默"这种形状启发式强一个量级:工具跑三分钟的一轮不会被误判成结束,
 * 一秒答完的一轮也不用干等五秒。
 *
 * 两个必须配套的细节(也来自实测):
 * 1. **同一条 message 会被拆成多行落盘**,每行都带同一个 `message.id` 和同一个
 *    `stop_reason:end_turn`(第 818/819 行:先 thinking 后 text)。所以见到 end_turn 不能
 *    立刻收摊,要再等一个很短的 settle 窗口(默认 800ms)把同 id 的正文收齐。
 * 2. 一轮里 `type:"user"` 记录满地都是 —— 620 条是 `content:[tool_result]` 的工具回填。
 *    "见到 user 就当新一轮" = 灾难。只有**另一条 cc2wechat 信封**(带别的 job: 标记)
 *    才算边界。
 *
 * **兜底判据:静默 ≥5s(可配)且已经攒到文本** —— 万一哪天 app 不写 stop_reason 了,
 * 通道降级成"慢但还能用",而不是全哑。兜底触发时 doneBy=silence,运维一眼看得出在吃兜底。
 *
 * 另外备选过、被否掉的信号:`[result] done (success), N turns` 是 `list_events`(带内 API)的
 * 渲染产物,jsonl 里没有;`notify_when_idle` 是会话内订阅,引擎被 WarmLifecycle 放倒就一起死,
 * daemon 靠不住它。
 */

export interface ParseResult {
  records: Array<Record<string, unknown>>;
  /** 消费掉的**字节**数(offset 是字节,不是字符) */
  consumed: number;
}

/** jobId 兼作 transcript 锚点与去重键 */
export function jobMarker(jobId: string): string {
  return `job:${jobId}`;
}

/** 只吃完整行;结尾半行原样留着,下一轮补齐再解析 */
export function parseJsonl(text: string): ParseResult {
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { records: [], consumed: 0 };
  const complete = text.slice(0, lastNl + 1);
  const records: Array<Record<string, unknown>> = [];
  for (const line of complete.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === 'object') records.push(parsed as Record<string, unknown>);
    } catch {
      // 坏行跳过。一条写坏的记录不该让整条通道哑掉。
    }
  }
  return { records, consumed: Buffer.byteLength(complete) };
}

// ---------------------------------------------------------------------------
// 纯状态机
// ---------------------------------------------------------------------------

/** 终止性 stop_reason。max_tokens 不在内 —— 截断之后 agent 循环可能还会续。 */
const TERMINAL_STOP = new Set(['end_turn', 'stop_sequence', 'refusal']);

/** 我们自己的注入信封前缀,用来认出"另一条 job" */
const ENVELOPE_RE = /\[微信\|[^\]]*\|(job:[A-Za-z0-9_-]+)\|/;

interface Block {
  type?: string;
  text?: string;
  name?: string;
}

function contentBlocks(rec: Record<string, unknown>): Block[] {
  const msg = rec.message as { content?: unknown } | undefined;
  const c = msg?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

function contentText(rec: Record<string, unknown>): string {
  const msg = rec.message as { content?: unknown } | undefined;
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return (c as Block[])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

/**
 * 一次注入 → 一次回复的状态机。喂记录,问状态。不碰 fs、不碰时钟。
 */
export class TurnScanner {
  /** 见到含本 job 标记的 user 记录 */
  anchored = false;
  /** 只见到 queue-operation:消息到了,但收件箱还在忙别的 */
  queued = false;
  /** 见到别的 job 的信封:我们这轮被越过了 */
  nextJobStarted = false;
  /** 见到终止性 stop_reason */
  terminal = false;
  /** 最后一条被接受的记录的时刻(墙钟,由调用方给) */
  lastActivityAt = 0;

  private finalMessageId = '';
  /** message.id → 该条消息累积的文本 */
  private texts = new Map<string, string[]>();
  /** 出现顺序,用于"end_turn 没正文时退回上一段文本" */
  private order: string[] = [];
  private progress: string[] = [];
  private anonSeq = 0;

  constructor(private readonly marker: string) {}

  push(rec: Record<string, unknown>, atMs: number): void {
    if (this.nextJobStarted) return; // 冻结:后面的内容不属于我们

    const type = rec.type;

    if (type === 'queue-operation') {
      if (typeof rec.content === 'string' && rec.content.includes(this.marker)) {
        this.queued = true;
        this.lastActivityAt = atMs;
      }
      return;
    }

    if (type === 'user') {
      const text = contentText(rec);
      if (!this.anchored) {
        if (text.includes(this.marker)) {
          this.anchored = true;
          this.lastActivityAt = atMs;
        }
        return;
      }
      // 已经锚定:只有"另一条 cc2wechat 信封"才是边界。
      // tool_result(数组 content)、人手敲的一句、图片附件都不是。
      const m = ENVELOPE_RE.exec(text);
      if (m && m[1] !== this.marker) {
        this.nextJobStarted = true;
        this.lastActivityAt = atMs;
      }
      return;
    }

    if (type !== 'assistant' || !this.anchored) return;

    this.lastActivityAt = atMs;
    const msg = rec.message as { id?: unknown; stop_reason?: unknown } | undefined;
    const id = typeof msg?.id === 'string' && msg.id ? msg.id : `anon-${this.anonSeq++}`;
    const stop = typeof msg?.stop_reason === 'string' ? msg.stop_reason : '';

    const blocks = contentBlocks(rec);
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
      .map((b) => b.text as string)
      .join('\n');

    for (const b of blocks) {
      if (b?.type === 'tool_use' && typeof b.name === 'string') this.progress.push(`工具 ${b.name}`);
    }

    if (text) {
      if (!this.texts.has(id)) {
        this.texts.set(id, []);
        this.order.push(id);
      }
      this.texts.get(id)!.push(text);
    }

    if (TERMINAL_STOP.has(stop)) {
      this.terminal = true;
      this.finalMessageId = id;
    }
  }

  /**
   * 最终答案:优先终止那条 message 的正文(拆成几行就拼几行);
   * 它只有 thinking 没正文时,退回锚点之后最后一段有内容的文本。
   */
  answer(): string {
    if (this.finalMessageId) {
      const hit = this.texts.get(this.finalMessageId);
      if (hit && hit.length > 0) return hit.join('\n');
    }
    for (let i = this.order.length - 1; i >= 0; i--) {
      const hit = this.texts.get(this.order[i]);
      if (hit && hit.length > 0) return hit.join('\n');
    }
    return '';
  }

  /** 取一次就清空 —— 调用方负责转成 AgentEvent.progress */
  takeProgress(): string[] {
    const out = this.progress;
    this.progress = [];
    return out;
  }
}

// ---------------------------------------------------------------------------
// 轮询循环
// ---------------------------------------------------------------------------

/** 文件路径 → 注入前的字节数 */
export type TranscriptBaseline = Record<string, number>;

export interface WatchOptions {
  cwd: string;
  marker: string;
  baseline?: TranscriptBaseline;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  /** 轮询间隔,默认 300ms */
  pollMs?: number;
  /** 见到 end_turn 之后再收多久的拆行正文,默认 800ms */
  settleMs?: number;
  /** 没有 end_turn 时的静默兜底,默认 5s */
  silenceMs?: number;
  /** 硬超时,默认 180s */
  timeoutMs?: number;
  /** 冷唤醒最多等多久让引擎注册进来,默认 30s */
  engineWaitMs?: number;
}

export type WatchResult =
  | { ok: true; text: string; doneBy: 'end_turn' | 'silence'; transcript: string }
  | { ok: false; code: string; error: string };

const DEFAULTS = {
  pollMs: 300,
  settleMs: 800,
  silenceMs: 5_000,
  timeoutMs: 180_000,
  engineWaitMs: 30_000,
};

export interface TranscriptWatcherOptions {
  registry: CcRegistry;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface FileState {
  offset: number;
  tail: Buffer;
  scanner: TurnScanner;
}

export class TranscriptWatcher {
  private readonly registry: CcRegistry;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TranscriptWatcherOptions) {
    this.registry = opts.registry;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * 注入**之前**调:记下现有 transcript 的字节数。
   * 没有它就得把整份历史重扫一遍 —— 几十 MB 的 jsonl 每轮扫一次不像话,
   * 而且历史里可能躺着同一个 marker(重放/复制粘贴)。
   */
  baseline(cwd: string): TranscriptBaseline {
    const dir = this.registry.projectDir(cwd);
    const out: TranscriptBaseline = {};
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      try {
        out[p] = fs.statSync(p).size;
      } catch {
        /* 刚被删掉,当没有 */
      }
    }
    return out;
  }

  async watch(opts: WatchOptions): Promise<WatchResult> {
    const pollMs = opts.pollMs ?? DEFAULTS.pollMs;
    const settleMs = opts.settleMs ?? DEFAULTS.settleMs;
    const silenceMs = opts.silenceMs ?? DEFAULTS.silenceMs;
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
    const engineWaitMs = opts.engineWaitMs ?? DEFAULTS.engineWaitMs;
    const baseline = opts.baseline ?? {};

    const dir = this.registry.projectDir(opts.cwd);
    const started = this.now();
    const deadline = started + timeoutMs;

    const files = new Map<string, FileState>();
    let locked: { path: string; state: FileState } | null = null;
    let sawEngine = false;

    for (;;) {
      if (opts.signal?.aborted) {
        return { ok: false, code: 'claude-app-aborted', error: '这轮被取消了' };
      }

      if (!sawEngine && this.registry.liveEngineByCwd(opts.cwd)) sawEngine = true;

      // ---- 收新内容 ----------------------------------------------------
      for (const p of this.candidates(dir)) {
        let state = files.get(p);
        if (!state) {
          state = { offset: baseline[p] ?? 0, tail: Buffer.alloc(0), scanner: new TurnScanner(opts.marker) };
          files.set(p, state);
        }
        if (locked && locked.path !== p) continue; // 已经锁定文件,别的不看了

        const chunk = this.readFrom(p, state);
        if (chunk.length === 0) continue;

        state.tail = state.tail.length === 0 ? chunk : Buffer.concat([state.tail, chunk]);
        const nl = state.tail.lastIndexOf(0x0a);
        if (nl < 0) continue; // 整块都是半行,等下一轮
        const complete = state.tail.subarray(0, nl + 1).toString('utf-8');
        state.tail = Buffer.from(state.tail.subarray(nl + 1));

        const at = this.now();
        for (const rec of parseJsonl(complete).records) state.scanner.push(rec, at);

        if (!locked && state.scanner.anchored) locked = { path: p, state };
      }

      // ---- 判完成 ------------------------------------------------------
      if (locked) {
        const s = locked.state.scanner;
        if (opts.onProgress) for (const t of s.takeProgress()) opts.onProgress(t);

        const idle = this.now() - s.lastActivityAt;

        if (s.terminal && idle >= settleMs) {
          const text = s.answer();
          if (text) return { ok: true, text, doneBy: 'end_turn', transcript: locked.path };
          return {
            ok: false,
            code: 'claude-app-empty-answer',
            error: '这轮结束了但没有任何正文(收件箱可能只做了工具调用)',
          };
        }

        if (s.nextJobStarted && !s.terminal) {
          return {
            ok: false,
            code: 'claude-app-turn-skipped',
            error: '收件箱已经在处理下一条消息了,这轮没有产出回复',
          };
        }

        if (!s.terminal && idle >= silenceMs) {
          const text = s.answer();
          // 静默兜底只在真攒到正文时才交货;一个字都没有就继续等硬超时
          if (text) return { ok: true, text, doneBy: 'silence', transcript: locked.path };
        }
      }

      // ---- 收摊条件 ----------------------------------------------------
      const elapsed = this.now() - started;
      if (!locked && !sawEngine && elapsed >= engineWaitMs) {
        return {
          ok: false,
          code: 'claude-app-no-engine',
          error: `注入后 ${engineWaitMs}ms 没有引擎在 ${opts.cwd} 注册 —— 收件箱可能没播种,或者 app 没开`,
        };
      }

      if (this.now() >= deadline) {
        const s = locked?.state.scanner;
        const hint = s?.anchored
          ? '收件箱收到了但一直没答完'
          : this.anyQueued(files)
            ? '消息已排队,但收件箱一直没轮到它(可能在忙上一轮)'
            : '没有在 transcript 里看到这条消息落地';
        return { ok: false, code: 'claude-app-turn-timeout', error: `等回复超时(${timeoutMs}ms):${hint}` };
      }

      await this.sleep(pollMs);
    }
  }

  // ---- 内部 -------------------------------------------------------------

  private anyQueued(files: Map<string, FileState>): boolean {
    for (const [, s] of files) if (s.scanner.queued) return true;
    return false;
  }

  /** 目录里所有 jsonl。冷唤醒可能换 CLI id → 新文件,所以每轮都重列。 */
  private candidates(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  private readFrom(p: string, state: FileState): Buffer {
    let size: number;
    try {
      size = fs.statSync(p).size;
    } catch {
      return Buffer.alloc(0);
    }
    // 文件被截断/换掉:从头再来,marker 唯一,重扫无害
    if (size < state.offset) {
      state.offset = 0;
      state.tail = Buffer.alloc(0);
    }
    if (size === state.offset) return Buffer.alloc(0);

    const len = size - state.offset;
    const buf = Buffer.allocUnsafe(len);
    let fd: number | null = null;
    try {
      fd = fs.openSync(p, 'r');
      const read = fs.readSync(fd, buf, 0, len, state.offset);
      state.offset += read;
      return read === len ? buf : Buffer.from(buf.subarray(0, read));
    } catch {
      return Buffer.alloc(0);
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
