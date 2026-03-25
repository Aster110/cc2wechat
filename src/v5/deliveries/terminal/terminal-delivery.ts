import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import type { Delivery, CompatResult, DeliveryConfig, ProcessResult, AIBackend, MessageContext } from '../../interfaces/index.js';
import { TerminalSessions } from './terminal-sessions.js';
import { tryInject, createWindow } from './applescript.js';
import { sleep, contextPathForUser } from '../../shared/utils.js';
import { log, logError } from '../../shared/logger.js';
import { userIdToSessionUUID } from '../../../utils.js';

const PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);

const DEFAULT_STALE_TIMEOUT_MS = 24 * 3600 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // run cleanup every 10 minutes

export class TerminalDelivery implements Delivery {
  readonly name = 'terminal';
  private sessions = new TerminalSessions(PORT);
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async checkCompatibility(): Promise<CompatResult> {
    if (process.platform !== 'darwin') {
      return { available: false, reason: 'Requires macOS, current platform: ' + process.platform };
    }
    if (!fs.existsSync('/Applications/iTerm.app')) {
      return { available: false, reason: 'iTerm not installed' };
    }
    return { available: true };
  }

  async initialize(config: DeliveryConfig): Promise<void> {
    const staleTimeout = (config as { session?: { staleTimeoutMs?: number } }).session?.staleTimeoutMs
      ?? DEFAULT_STALE_TIMEOUT_MS;
    // Run cleanup on a timer instead of blocking every deliver() call
    this.cleanupTimer = setInterval(() => {
      this.sessions.cleanupStale(staleTimeout).catch((err) => {
        logError(`Session cleanup failed: ${String(err)}`);
      });
    }, CLEANUP_INTERVAL_MS);
    // Also run once immediately
    await this.sessions.cleanupStale(staleTimeout);
  }

  async deliver(ctx: MessageContext, backend: AIBackend): Promise<ProcessResult> {
    const entry = await this.sessions.findSession(ctx.userId);

    if (entry) {
      const ok = tryInject(
        entry.platformData.sessionId as string,
        entry.platformData.windowId as string,
        `[微信] ${ctx.text}`,
      );
      if (ok) {
        log(`-> injected: user=${ctx.userId.slice(0, 8)}, session=${(entry.platformData.sessionId as string).slice(0, 8)}`);
        await this.sessions.touch(ctx.userId);
        return { text: '', selfReplied: true };
      }
      log(`-> session gone, recreating: user=${ctx.userId.slice(0, 8)}`);
      await this.sessions.destroySession(ctx.userId);
    }

    // 新建窗口
    await this._createWindow(ctx.userId, backend, ctx.cwd);

    // 新窗口第一条消息带回复指引
    const newEntry = await this.sessions.findSession(ctx.userId);
    if (newEntry) {
      const firstMsg = `[微信] ${ctx.text}\n\n(收到微信消息，处理完后用 cc2wechat --text "你的回复" 发回微信)`;
      tryInject(newEntry.platformData.sessionId as string, newEntry.platformData.windowId as string, firstMsg);
    }

    return { text: '', selfReplied: true };
  }

  async closeSession(userId: string): Promise<void> {
    const entry = await this.sessions.findSession(userId);
    if (entry?.platformData?.sessionId) {
      try {
        execSync(`osascript -e '
          tell application "iTerm2"
            repeat with w in windows
              repeat with t in tabs of w
                repeat with s in sessions of t
                  if unique id of s is "${entry.platformData.sessionId}" then
                    tell s to close
                    return
                  end if
                end repeat
              end repeat
            end repeat
          end tell
        '`, { timeout: 5000 });
      } catch (err) {
        logError(`Failed to close iTerm session for user ${userId.slice(0, 8)}: ${String(err)}`);
      }
      await this.sessions.destroySession(userId);
      log(`-> session closed: user=${userId.slice(0, 8)}`);
    }
  }

  async createSession(userId: string, backend: AIBackend, cwd: string, _contextPath?: string): Promise<void> {
    await this._createWindow(userId, backend, cwd);
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** 内部：创建 iTerm 窗口 + 注册 session */
  private async _createWindow(userId: string, backend: AIBackend, cwd: string): Promise<void> {
    const sessionId = userIdToSessionUUID(userId);
    const ctxPath = contextPathForUser(userId);
    const cmd = backend.buildLaunchCommand({ sessionId, cwd });

    log(`-> creating window: user=${userId.slice(0, 8)} (cc-session: ${sessionId.slice(0, 8)})`);
    const newEntry = createWindow(userId, cmd, ctxPath);
    log(`window created: user=${userId.slice(0, 8)} -> window=${newEntry.windowId}, session=${newEntry.sessionId.slice(0, 8)}`);

    await sleep(5000);
    await this.sessions.createSession(userId, {
      sessionId,
      cwd,
      platformData: { windowId: newEntry.windowId, sessionId: newEntry.sessionId },
    });
  }
}
