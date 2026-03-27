import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import type { Delivery, CompatResult, DeliveryConfig, ProcessResult, AIBackend, MessageContext } from '../../interfaces/index.js';
import { TmuxSessions } from './tmux-sessions.js';
import { hasTmux, sendToSession, createTmuxSession, killTmuxSession, isTmuxSessionAlive } from './tmux-cli.js';
import { sleep } from '../../shared/utils.js';
import { log } from '../../shared/logger.js';
import { userIdToSessionUUID } from '../../../utils.js';

const PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);

/** 根据 userId 生成隔离的 context 文件路径 */
function contextPathForUser(userId: string): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
  return `/tmp/cc2wechat-ctx-${hash}.json`;
}

/** 根据 userId 生成 tmux session 名 */
function tmuxSessionName(userId: string): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 12);
  return `cc2w-${hash}`;
}

export class TmuxDelivery implements Delivery {
  readonly name = 'tmux';
  private sessions = new TmuxSessions(PORT);
  /** 防止同一用户并发创建 session 的锁 */
  private creatingUsers = new Set<string>();

  async checkCompatibility(): Promise<CompatResult> {
    if (!hasTmux()) {
      return { available: false, reason: 'tmux not installed' };
    }
    return { available: true };
  }

  async initialize(_config: DeliveryConfig): Promise<void> {}

  async deliver(ctx: MessageContext, backend: AIBackend): Promise<ProcessResult> {
    await this._cleanupStaleWithKill(24 * 3600 * 1000);
    const entry = await this.sessions.findSession(ctx.userId);

    if (entry) {
      const sessionName = entry.platformData.sessionName as string;
      // 检查 tmux session 是否还活着
      if (isTmuxSessionAlive(sessionName)) {
        const ok = sendToSession(
          sessionName,
          `[微信${ctx.accountName ? `·${ctx.accountName}` : ''}] ${ctx.text}`,
        );
        if (ok) {
          log(`-> injected: user=${ctx.userId.slice(0, 8)}, tmux=${sessionName}`);
          await this.sessions.touch(ctx.userId);
          return { text: '', selfReplied: true };
        }
      }
      log(`-> tmux session gone, recreating: user=${ctx.userId.slice(0, 8)}`);
      await this.sessions.destroySession(ctx.userId);
    }

    // 防止同一用户并发创建 session（两条消息同时到达的竞态）
    if (this.creatingUsers.has(ctx.userId)) {
      log(`-> session creation in progress, queuing: user=${ctx.userId.slice(0, 8)}`);
      // 等创建完成后再注入
      await this._waitForCreation(ctx.userId);
      const pending = await this.sessions.findSession(ctx.userId);
      if (pending) {
        const sn = pending.platformData.sessionName as string;
        sendToSession(sn, `[微信${ctx.accountName ? `·${ctx.accountName}` : ''}] ${ctx.text}`);
        await this.sessions.touch(ctx.userId);
      }
      return { text: '', selfReplied: true };
    }

    // 新建 tmux session
    await this._createTmuxSession(ctx.userId, backend, ctx.cwd);

    // 新窗口第一条消息带回复指引
    const newEntry = await this.sessions.findSession(ctx.userId);
    if (newEntry) {
      const sessionName = newEntry.platformData.sessionName as string;
      const firstMsg = `[微信${ctx.accountName ? `·${ctx.accountName}` : ''}] ${ctx.text}\n\n(收到微信消息，处理完后用 cc2wechat --text "你的回复" 发回微信)`;
      const injected = sendToSession(sessionName, firstMsg);
      log(`-> first msg inject: ok=${injected}, tmux=${sessionName}`);
    }

    return { text: '', selfReplied: true };
  }

  /**
   * 重置会话：往 tmux session 注入 /clear，不杀 session。
   * 比 close+create 快 10 秒，且 ttyd 不断连。
   */
  async resetSession(userId: string): Promise<boolean> {
    const entry = await this.sessions.findSession(userId);
    if (!entry?.platformData?.sessionName) return false;

    const sessionName = entry.platformData.sessionName as string;
    if (!isTmuxSessionAlive(sessionName)) return false;

    const ok = sendToSession(sessionName, '/clear');
    if (ok) {
      log(`-> tmux session reset (injected /clear): user=${userId.slice(0, 8)}`);
    }
    return ok;
  }

  async closeSession(userId: string): Promise<void> {
    const entry = await this.sessions.findSession(userId);
    if (entry?.platformData?.sessionName) {
      killTmuxSession(entry.platformData.sessionName as string);
      this._killTtyd(userId);
      await this.sessions.destroySession(userId);
      log(`-> tmux session closed: user=${userId.slice(0, 8)}`);
    }
  }

  async createSession(userId: string, backend: AIBackend, cwd: string, _contextPath?: string): Promise<void> {
    await this._createTmuxSession(userId, backend, cwd);
  }

  async shutdown(): Promise<void> {
    const all = this.sessions.allSessions();
    for (const entry of all) {
      if (entry.platformData?.sessionName) {
        killTmuxSession(entry.platformData.sessionName as string);
      }
      this._killTtyd(entry.userId);
    }
    // 清理 session store + 磁盘文件，避免重启后加载过期记录
    for (const entry of all) {
      await this.sessions.destroySession(entry.userId);
    }
    log(`-> tmux shutdown: cleaned ${all.length} session(s)`);
  }

  /** cleanupStale 的增强版：先 kill 过期 session 的 tmux 进程，再清理记录 */
  private async _cleanupStaleWithKill(maxAgeMs: number): Promise<void> {
    const now = Date.now();
    const all = this.sessions.allSessions();
    for (const entry of all) {
      if (now - entry.lastActiveAt > maxAgeMs) {
        if (entry.platformData?.sessionName) {
          killTmuxSession(entry.platformData.sessionName as string);
          log(`-> killed stale tmux session: ${entry.platformData.sessionName}`);
        }
      }
    }
    await this.sessions.cleanupStale(maxAgeMs);
  }

  /** 等待某用户的 session 创建完成（轮询 creatingUsers 集合） */
  private async _waitForCreation(userId: string): Promise<void> {
    const maxWait = 15000;
    const interval = 500;
    let waited = 0;
    while (this.creatingUsers.has(userId) && waited < maxWait) {
      await sleep(interval);
      waited += interval;
    }
  }

  /** 内部：创建 tmux session + 注册 */
  private async _createTmuxSession(userId: string, backend: AIBackend, cwd: string): Promise<void> {
    this.creatingUsers.add(userId);
    try {
      const sessionId = userIdToSessionUUID(userId);
      const sessionName = tmuxSessionName(userId);
      const ctxPath = contextPathForUser(userId);
      // 不用 backend.buildLaunchCommand（含 cd 和 ; exit，是给 iTerm 设计的）
      // tmux -c 已经设了 cwd，直接跑 claude 即可
      const fullCmd = `CC2WECHAT_CONTEXT=${ctxPath} claude --dangerously-skip-permissions`;

      log(`-> creating tmux session: user=${userId.slice(0, 8)} (tmux=${sessionName})`);
      createTmuxSession(sessionName, cwd, fullCmd);

      await sleep(10000);

      // 自动启动 ttyd Web 终端（只读模式），让用户在浏览器看 Claude Code
      const ttydPort = this._startTtyd(sessionName, userId);

      await this.sessions.createSession(userId, {
        sessionId,
        cwd,
        platformData: { sessionName, ttydPort },
      });
    } finally {
      this.creatingUsers.delete(userId);
    }
  }

  /** ttyd 进程管理 */
  private ttydProcesses = new Map<string, { port: number; kill: () => void }>();

  /** 为 tmux session 启动 ttyd Web 终端 */
  private _startTtyd(sessionName: string, userId: string): number | null {
    try {
      execSync('which ttyd', { encoding: 'utf-8', timeout: 3000 });
    } catch {
      return null; // ttyd 没安装，跳过
    }

    // 基于 userId hash 分配端口（7681 起步）
    const hash = createHash('md5').update(userId).digest('hex');
    const port = 7681 + (parseInt(hash.slice(0, 4), 16) % 1000);

    // 杀掉旧的 ttyd（如果有）
    this._killTtyd(userId);

    try {
      const child = spawn('ttyd', ['-W', '-p', String(port), 'tmux', 'attach', '-t', sessionName], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      this.ttydProcesses.set(userId, {
        port,
        kill: () => { try { child.kill(); } catch { /* ok */ } },
      });

      log(`-> ttyd started: http://localhost:${port} (user=${userId.slice(0, 8)})`);
      return port;
    } catch (err) {
      log(`-> ttyd failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 关闭用户的 ttyd */
  private _killTtyd(userId: string): void {
    const entry = this.ttydProcesses.get(userId);
    if (entry) {
      entry.kill();
      this.ttydProcesses.delete(userId);
    }
  }
}
