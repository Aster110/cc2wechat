import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { Delivery, CompatResult, DeliveryConfig, ProcessResult, AIBackend, MessageContext } from '../../interfaces/index.js';
import { TerminalSessions } from './terminal-sessions.js';
import { tryInject, createWindow } from './applescript.js';
import { sleep } from '../../shared/utils.js';
import { log } from '../../shared/logger.js';
import { userIdToSessionUUID } from '../../../utils.js';

const PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);

/** 根据 userId 生成隔离的 context 文件路径 */
function contextPathForUser(userId: string): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
  return `/tmp/cc2wechat-ctx-${hash}.json`;
}

export class TerminalDelivery implements Delivery {
  readonly name = 'terminal';
  private sessions = new TerminalSessions(PORT);

  async checkCompatibility(): Promise<CompatResult> {
    if (process.platform !== 'darwin') {
      return { available: false, reason: 'Requires macOS, current platform: ' + process.platform };
    }
    if (!fs.existsSync('/Applications/iTerm.app')) {
      return { available: false, reason: 'iTerm not installed' };
    }
    return { available: true };
  }

  async initialize(_config: DeliveryConfig): Promise<void> {}

  async deliver(ctx: MessageContext, backend: AIBackend): Promise<ProcessResult> {
    await this.sessions.cleanupStale(24 * 3600 * 1000);
    const entry = await this.sessions.findSession(ctx.userId);

    if (entry) {
      const ok = tryInject(
        entry.platformData.sessionId as string,
        entry.platformData.windowId as string,
        `[微信${ctx.accountName ? `·${ctx.accountName}` : ''}] ${ctx.text}`,
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
      const firstMsg = `[微信${ctx.accountName ? `·${ctx.accountName}` : ''}] ${ctx.text}\n\n(收到微信消息，处理完后用 cc2wechat --text "你的回复" 发回微信)`;
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
      } catch { /* already closed */ }
      await this.sessions.destroySession(userId);
      log(`-> session closed: user=${userId.slice(0, 8)}`);
    }
  }

  async createSession(userId: string, backend: AIBackend, cwd: string, _contextPath?: string): Promise<void> {
    await this._createWindow(userId, backend, cwd);
  }

  async shutdown(): Promise<void> {}

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
