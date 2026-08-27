import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 活引擎注册表读取器 —— `~/.claude/sessions/<pid>.json`。
 *
 * 这是 app 形态里唯一一处能把「收件箱 cwd」翻成「CLI sessionId(= transcript 文件名)」的地方。
 *
 * 两条实测纪律(预研 10 §4):
 * 1. **只登记活引擎**。WarmLifecycle 空闲 900s 会把引擎放倒,那时这里就没有条目了 ——
 *    "查不到" 是常态,不是故障。
 * 2. **CLI id 会不定期轮换**(同一个 app 会话历史上见过 5 个)。所以每次唤醒都要重解析,
 *    绝不缓存跨唤醒的映射。这个类因此不做任何缓存,每次都读盘。
 *
 * 所有外部世界(目录、pid 探活)都从构造参数进来,测试不碰真实 ~/.claude。
 */

export interface CcEngine {
  pid: number;
  /** CLI sessionId —— transcript 文件名就是它 */
  sessionId: string;
  cwd: string;
  name: string;
  startedAt: number;
  version: string;
  kind: string;
  entrypoint: string;
  messagingSocketPath: string;
}

export interface CcRegistryOptions {
  /** 缺省 ~/.claude/sessions */
  sessionsDir?: string;
  /** 缺省 ~/.claude/projects */
  projectsDir?: string;
  /** 缺省 ~/Library/Application Support/Claude/claude-code(app 内置引擎的版本目录) */
  appVersionsDir?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForEngineOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** 只认这个时刻之后起来的引擎(冷唤醒时用来跳过刚被放倒的旧登记) */
  startedAfter?: number;
}

/**
 * transcript 目录名规则(实测反推,非官方承诺):
 * cwd 里每个非字母数字字符换成 `-`。
 * `/Users/aster/AIproject/polyverse_samantha/.claude/worktrees/x`
 *   → `-Users-aster-AIproject-polyverse-samantha--claude-worktrees-x`
 */
export function slugOf(cwd: string): string {
  const normalized = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptPath(projectsDir: string, cwd: string, sessionId: string): string {
  return path.join(projectsDir, slugOf(cwd), `${sessionId}.jsonl`);
}

function samePath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return a === b;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class CcRegistry {
  readonly sessionsDir: string;
  readonly projectsDir: string;
  readonly appVersionsDir: string;

  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: CcRegistryOptions = {}) {
    const home = os.homedir();
    this.sessionsDir = opts.sessionsDir ?? path.join(home, '.claude', 'sessions');
    this.projectsDir = opts.projectsDir ?? path.join(home, '.claude', 'projects');
    this.appVersionsDir =
      opts.appVersionsDir ?? path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 目录里所有能解析、且进程还活着的引擎 */
  listEngines(): CcEngine[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.sessionsDir);
    } catch {
      return [];
    }

    const out: CcEngine[] = [];
    for (const f of files) {
      // 同目录还有 <pid>.<hash>.key(鉴权密钥),别去 JSON.parse 它
      if (!f.endsWith('.json')) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf-8'));
      } catch {
        continue;
      }
      const d = raw as Partial<CcEngine> | null;
      if (!d || typeof d !== 'object') continue;
      if (typeof d.pid !== 'number' || typeof d.sessionId !== 'string' || typeof d.cwd !== 'string') continue;
      if (!this.isAlive(d.pid)) continue;
      out.push({
        pid: d.pid,
        sessionId: d.sessionId,
        cwd: d.cwd,
        name: typeof d.name === 'string' ? d.name : '',
        startedAt: typeof d.startedAt === 'number' ? d.startedAt : 0,
        version: typeof d.version === 'string' ? d.version : '',
        kind: typeof d.kind === 'string' ? d.kind : '',
        entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : '',
        messagingSocketPath: typeof d.messagingSocketPath === 'string' ? d.messagingSocketPath : '',
      });
    }
    return out;
  }

  /** 同 cwd 的活引擎;多个时取最新起来的那个 */
  liveEngineByCwd(cwd: string, startedAfter = 0): CcEngine | null {
    const hits = this.listEngines()
      .filter((e) => samePath(e.cwd, cwd) && e.startedAt >= startedAfter)
      .sort((a, b) => b.startedAt - a.startedAt);
    return hits[0] ?? null;
  }

  projectDir(cwd: string): string {
    return path.join(this.projectsDir, slugOf(cwd));
  }

  /** 活引擎的 transcript 路径;引擎不在就没有(不许拿旧 CLI id 顶) */
  transcriptFor(cwd: string): string | null {
    const engine = this.liveEngineByCwd(cwd);
    if (!engine) return null;
    return transcriptPath(this.projectsDir, cwd, engine.sessionId);
  }

  /**
   * 冷唤醒用:投递之后引擎才会被拉起来(实测 ~2s),这里轮询等它注册进来。
   * 超时/abort 都返回 null —— 调用方自己决定是报错还是继续等 transcript。
   */
  async waitForEngine(cwd: string, opts: WaitForEngineOptions = {}): Promise<CcEngine | null> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 300;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (opts.signal?.aborted) return null;
      const hit = this.liveEngineByCwd(cwd, opts.startedAfter ?? 0);
      if (hit) return hit;
      if (this.now() >= deadline) return null;
      await this.sleep(pollMs);
    }
  }

  /** app 内置引擎的版本目录清单(探针拿它对已验证清单,漂移就 warn) */
  appVersions(): string[] {
    try {
      return fs
        .readdirSync(this.appVersionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }
}
