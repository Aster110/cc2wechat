import { execSync } from 'node:child_process';
import fs from 'node:fs';

import type { WeixinMessage } from '../types.js';
import type { AccountData } from '../store.js';
import { extractText, userIdToSessionUUID, sleep, log } from '../utils.js';

// ---------------------------------------------------------------------------
// Tab Entry — represents one user's terminal session
// ---------------------------------------------------------------------------

export interface TabEntry {
  userId: string;        // 微信用户 ID
  windowId: string;      // iTerm window ID
  sessionId: string;     // iTerm session UUID（精确定位 tab）
  ccSessionId: string;   // Claude Code session UUID（--resume 用）
  registeredAt: number;  // epoch ms
}

// ---------------------------------------------------------------------------
// TabRegistry — 微信用户 → iTerm 窗口的路由表
// ---------------------------------------------------------------------------

export class TabRegistry {
  private entries = new Map<string, TabEntry>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  register(opts: {
    userId: string;
    windowId: string;
    sessionId: string;
    ccSessionId: string;
  }): TabEntry {
    const entry: TabEntry = {
      userId: opts.userId,
      windowId: opts.windowId,
      sessionId: opts.sessionId,
      ccSessionId: opts.ccSessionId,
      registeredAt: Date.now(),
    };
    this.entries.set(opts.userId, entry);
    this.save();
    return entry;
  }

  lookup(userId: string): TabEntry | null {
    return this.entries.get(userId) ?? null;
  }

  all(): TabEntry[] {
    return [...this.entries.values()];
  }

  remove(userId: string): void {
    this.entries.delete(userId);
    this.save();
  }

  touch(userId: string): void {
    const entry = this.entries.get(userId);
    if (entry) {
      entry.registeredAt = Date.now();
      this.save();
    }
  }

  cleanupStale(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, entry] of this.entries) {
      if (entry.registeredAt < cutoff) this.entries.delete(key);
    }
    this.save();
  }

  save(): void {
    const obj: Record<string, TabEntry> = {};
    for (const [key, entry] of this.entries) obj[key] = entry;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch { /* best-effort */ }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const [key, val] of Object.entries(data)) {
          const entry = val as TabEntry;
          if (entry?.windowId && entry?.sessionId) this.entries.set(key, entry);
        }
      }
    } catch { /* corrupt file — start fresh */ }
  }
}

// ---------------------------------------------------------------------------
// Module-level registry instance
// ---------------------------------------------------------------------------

const TAB_REGISTRY_PATH = '/tmp/cc2wechat-tabs.json';
const registry = new TabRegistry(TAB_REGISTRY_PATH);

/** Exposed for testing only */
export function _getRegistry(): TabRegistry {
  return registry;
}

// ---------------------------------------------------------------------------
// iTerm Atomic Operations
//
// 设计哲学：一次 AppleScript = 一次原子操作
// 不拆"查"和"写"两步，避免竞态和多余调用
// ---------------------------------------------------------------------------

/**
 * 原子操作：尝试注入消息到指定 session
 *
 * 一次 AppleScript 完成"查找 session + 写入消息"，返回是否成功。
 * 搜索策略：先在原窗口找（快路径），找不到再全局搜（tab 被拖走了）。
 *
 * @returns true = 注入成功, false = session 不存在
 */
function tryInject(sessionUUID: string, windowId: string, message: string): boolean {
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    const result = execSync(`osascript -e '
      tell application "iTerm2"
        -- 快路径：在原窗口找
        try
          set w to (first window whose id is ${windowId})
          repeat with t in tabs of w
            repeat with s in sessions of t
              if unique id of s is "${sessionUUID}" then
                tell s to write text "${escaped}"
                return "ok"
              end if
            end repeat
          end repeat
        end try
        -- 慢路径：全局搜（tab 被拖到别的窗口）
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if unique id of s is "${sessionUUID}" then
                tell s to write text "${escaped}"
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not_found"
      end tell
    '`, { encoding: 'utf-8' }).trim();
    return result === 'ok';
  } catch {
    return false;
  }
}

/**
 * 创建新 iTerm 窗口并启动 CC
 *
 * @returns TabEntry（包含 window ID 和 session UUID）
 */
function createWindow(userId: string, ccSessionId: string, cwd: string): TabEntry {
  const output = execSync(`osascript -e '
    tell application "iTerm2"
      set w to (create window with default profile)
      set s to current session of w
      tell s
        write text "cd ${cwd} && claude --resume ${ccSessionId} --dangerously-skip-permissions"
      end tell
      return (id of w) & "," & (unique id of s)
    end tell
  '`, { encoding: 'utf-8' }).trim();

  // iTerm 返回格式如 "1463, ,, D0EFA5D6-..." — 过滤空白取首尾
  const parts = output.split(',').map(s => s.trim()).filter(Boolean);
  const windowId = parts[0] ?? output;
  const sessionId = parts.length > 1 ? parts[parts.length - 1] : `session-${Date.now()}`;

  const entry = registry.register({ userId, windowId, sessionId, ccSessionId });

  log(`window created: user=${userId.slice(0, 8)} -> window=${windowId}, session=${sessionId.slice(0, 8)}`);
  return entry;
}

// ---------------------------------------------------------------------------
// Message Delivery — 编排层
//
// 保证消息一定送达：tryInject → 失败 → 清理 → 新建 → 再注入
// ---------------------------------------------------------------------------

/**
 * 投递消息到用户的 CC 终端
 *
 * 1. 快路径：已有 session → tryInject（一次 AppleScript）
 * 2. 兜底：session 没了 → 清理注册表 → 新建窗口 → 再注入
 */
async function deliverMessage(userId: string, ccSessionId: string, message: string, cwd: string): Promise<void> {
  const entry = registry.lookup(userId);

  // 快路径：已有 session，一次 AppleScript 搞定
  if (entry?.sessionId && !entry.sessionId.startsWith('session-')) {
    if (tryInject(entry.sessionId, entry.windowId, message)) {
      log(`-> injected: user=${userId.slice(0, 8)}, session=${entry.sessionId.slice(0, 8)}`);
      registry.touch(userId);
      return;
    }
    // session 没了，清理
    log(`-> session gone, recreating: user=${userId.slice(0, 8)}`);
    registry.remove(userId);
  } else if (entry) {
    // 旧数据没有有效 session id，清理
    registry.remove(userId);
  }

  // 兜底：新建窗口
  log(`-> creating window: user=${userId.slice(0, 8)} (cc-session: ${ccSessionId.slice(0, 8)})`);
  const newEntry = createWindow(userId, ccSessionId, cwd);
  await sleep(5000); // 等 CC 启动
  tryInject(newEntry.sessionId, newEntry.windowId, message);
}

// ---------------------------------------------------------------------------
// Terminal mode message handler (public API)
// ---------------------------------------------------------------------------

export async function handleMessageTerminal(msg: WeixinMessage, account: AccountData, preExtractedText?: string): Promise<void> {
  const text = preExtractedText ?? extractText(msg);
  const userId = msg.from_user_id ?? '';
  const sessionId = userIdToSessionUUID(userId);
  const cwd = process.cwd();

  // 清理 24 小时以上的过期条目
  registry.cleanupStale(24 * 60 * 60 * 1000);

  await deliverMessage(userId, sessionId, `[微信] ${text}`, cwd);
}
