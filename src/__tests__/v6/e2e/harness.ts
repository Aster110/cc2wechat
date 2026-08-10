/**
 * e2e 夹具:临时 HOME + 假 iLink + 假 codex + 真的 `node dist/v6/main.js`。
 *
 * 关键接缝(daemon 一行没改):
 * - `HOME` 指到临时目录 → `os.homedir()` 跟着走 → 账号文件 / sync-buf / config 全在沙箱里
 * - `accounts-<port>.json` 里的 `baseUrl` 指到假 iLink → 长轮询打到我们的 http server
 * - `PATH` 前置 binDir → `spawn('codex', ...)` 打到假 codex
 *
 * **跑之前先 `npm run build`** —— 这里 spawn 的是 dist/v6/main.js,不是 src。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeILink, type FakeILink } from './fake-ilink.js';
import { installFakeCodex, type FakeCodex } from './fake-codex.js';

export interface DaemonHandle {
  port: number;
  home: string;
  proc: ChildProcess;
  /** 合并的 stdout + stderr(按到达顺序) */
  logs(): string;
  waitForLog(pattern: RegExp, timeoutMs?: number): Promise<void>;
  /** GET 127.0.0.1:<port>/health 的 JSON */
  health(): Promise<any>;
  /** 默认 SIGTERM,等进程真的退出(5s 后 SIGKILL) */
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface E2eEnv {
  home: string;
  workdir: string;
  codexHome: string;
  ilink: FakeILink;
  fakeCodex: FakeCodex;
  port: number;
  startDaemon(extraEnv?: Record<string, string>): Promise<DaemonHandle>;
  cleanup(): Promise<void>;
}

export interface SetupE2eOptions {
  /** CC2WECHAT_BACKEND,默认 'codex' */
  backend?: string;
  /** 假 codex 的兜底人格(argv 不是 exec/app-server 时用),默认 'exec' */
  persona?: 'exec' | 'app-server';
  /** 固定端口(不给就 pickPort()) */
  port?: number;
}

const HEALTH_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const MIN_PORT = 19100;
const MAX_PORT = 19899;

// ---------------------------------------------------------------------------
// 端口:必须 >= 19100,而且要真的 bind 过才算数(并发用例撞 port 会把 daemon
// 直接顶掉 —— main.js 见 lsof 有人在听就 exit 0)
// ---------------------------------------------------------------------------

function tryBind(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => {
      const actual = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(actual));
    });
  });
}

export async function pickPort(): Promise<number> {
  const ephemeral = await tryBind(0);
  if (ephemeral != null && ephemeral >= MIN_PORT) return ephemeral;
  for (let i = 0; i < 200; i++) {
    const cand = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1));
    const ok = await tryBind(cand);
    if (ok != null) return ok;
  }
  throw new Error(`pickPort: no free port in ${MIN_PORT}-${MAX_PORT}`);
}

// ---------------------------------------------------------------------------

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`findRepoRoot: no package.json above ${path.dirname(fileURLToPath(import.meta.url))}`);
}

function daemonEntry(): string {
  const entry = path.join(findRepoRoot(), 'dist', 'v6', 'main.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`daemon entry missing: ${entry} —— 先跑 npm run build`);
  }
  return entry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 收尸:daemon 被 SIGKILL 时来不及带走常驻的 `codex app-server` 子进程,
 * 那个假 codex 会一直挂着。root 是 mkdtemp 出来的唯一路径,
 * 命令行里带着它的进程**一定**是我们自己起的 —— 只杀这些,不碰别人。
 */
function killStrays(root: string): void {
  let out = '';
  try {
    out = execFileSync('pgrep', ['-f', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { encoding: 'utf-8' });
  } catch {
    return; // pgrep 没找到会 exit 1
  }
  for (const line of out.split('\n')) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

/** 父进程的 CC2WECHAT_* / FAKE_CODEX_* 一律不继承 —— 开发机上真跑着的 daemon 变量会污染 e2e */
function sanitizedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('CC2WECHAT_') || k.startsWith('FAKE_CODEX_')) continue;
    env[k] = v;
  }
  return env;
}

export async function setupE2e(opts: SetupE2eOptions = {}): Promise<E2eEnv> {
  // realpath:macOS 的 /var 是 /private/var 的软链,不解开的话
  // `health().cwd`(daemon 的 process.cwd())永远对不上 env.workdir
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc2wechat-e2e-')));
  const home = path.join(root, 'home');
  const workdir = path.join(root, 'work');
  const codexHome = path.join(root, 'codex-home');
  const binDir = path.join(root, 'bin');
  for (const d of [home, workdir, codexHome, binDir]) fs.mkdirSync(d, { recursive: true });

  const port = opts.port ?? (await pickPort());
  const backend = opts.backend ?? 'codex';

  const ilink = await startFakeILink();
  const fakeCodex = installFakeCodex(binDir, { defaultPersona: opts.persona ?? 'exec' });

  fs.mkdirSync(path.join(home, '.cc2wechat'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.cc2wechat', `accounts-${port}.json`),
    JSON.stringify(
      [
        {
          accountId: 'e2e-acct',
          token: 'e2e-token',
          baseUrl: ilink.baseUrl,
          savedAt: new Date().toISOString(),
          port,
        },
      ],
      null,
      2,
    ),
    'utf-8',
  );

  const entry = daemonEntry();
  const handles: DaemonHandle[] = [];

  async function startDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonHandle> {
    const env: Record<string, string> = {
      ...sanitizedParentEnv(),
      HOME: home,
      CC2WECHAT_PORT: String(port),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      CODEX_HOME: codexHome,
      FAKE_CODEX_LOG: fakeCodex.logPath,
      FAKE_CODEX_STATE: fakeCodex.statePath,
      CC2WECHAT_ACK_MS: '0',
      CC2WECHAT_ENGINE: 'v6',
      CC2WECHAT_BACKEND: backend,
      ...extraEnv,
    };

    const proc = spawn(process.execPath, [entry], {
      cwd: workdir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    const state: { exit: { code: number | null; signal: NodeJS.Signals | null } | null } = { exit: null };
    const logWaiters = new Set<{ pattern: RegExp; resolve: () => void; timer: NodeJS.Timeout }>();

    const onChunk = (d: Buffer): void => {
      buffer += d.toString();
      for (const w of [...logWaiters]) {
        if (!w.pattern.test(buffer)) continue;
        logWaiters.delete(w);
        clearTimeout(w.timer);
        w.resolve();
      }
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('exit', (code, signal) => {
      state.exit = { code, signal };
    });

    const healthUrl = `http://127.0.0.1:${port}/health`;

    async function health(): Promise<any> {
      const res = await fetch(healthUrl);
      if (!res.ok) throw new Error(`/health ${res.status}`);
      return (await res.json()) as unknown;
    }

    const handle: DaemonHandle = {
      port,
      home,
      proc,
      logs: () => buffer,
      health,
      waitForLog(pattern, timeoutMs = HEALTH_TIMEOUT_MS) {
        if (pattern.test(buffer)) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const waiter = {
            pattern,
            resolve,
            timer: setTimeout(() => {
              logWaiters.delete(waiter);
              reject(new Error(`waitForLog(${pattern}) timed out after ${timeoutMs}ms. Logs so far:\n${buffer}`));
            }, timeoutMs),
          };
          logWaiters.add(waiter);
        });
      },
      async stop(signal: NodeJS.Signals = 'SIGTERM') {
        if (proc.exitCode != null || proc.signalCode != null) return;
        const done = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
        try {
          proc.kill(signal);
        } catch {
          return;
        }
        const killed = await Promise.race([done.then(() => true), sleep(STOP_GRACE_MS).then(() => false)]);
        if (killed) return;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 已经没了 */
        }
        await Promise.race([done, sleep(2_000)]);
      },
    };
    handles.push(handle);

    // 等到 /health 真的能通才算起来了
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      if (proc.exitCode != null || proc.signalCode != null) {
        throw new Error(
          `daemon exited before /health came up ` +
            `(code=${state.exit?.code ?? proc.exitCode} signal=${state.exit?.signal ?? proc.signalCode}). Logs:\n${buffer}`,
        );
      }
      try {
        await health();
        return handle;
      } catch {
        /* 还没起来 */
      }
      if (Date.now() > deadline) {
        await handle.stop();
        throw new Error(`daemon /health not up within ${HEALTH_TIMEOUT_MS}ms on port ${port}. Logs:\n${buffer}`);
      }
      await sleep(100);
    }
  }

  async function cleanup(): Promise<void> {
    for (const h of handles) await h.stop().catch(() => {});
    killStrays(root);
    await ilink.close().catch(() => {});
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  return { home, workdir, codexHome, ilink, fakeCodex, port, startDaemon, cleanup };
}
