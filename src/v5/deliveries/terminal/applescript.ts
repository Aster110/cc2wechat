import { execSync } from 'node:child_process';

/**
 * 原子操作：尝试注入消息到指定 session
 * 搜索策略：先在原窗口找（快路径），找不到再全局搜（tab 被拖走了）
 */
export function tryInject(sessionUUID: string, windowId: string, text: string): boolean {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
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
    '`, { encoding: 'utf-8', timeout: 5000 }).trim();
    return result === 'ok';
  } catch {
    return false;
  }
}

/**
 * 创建新 iTerm 窗口，先创建再 write text 写命令（不用 command 参数，避免退出即关窗口）
 * contextPath 传入时，会在命令前注入 CC2WECHAT_CONTEXT 环境变量
 */
export function createWindow(userId: string, cmd: string, contextPath?: string): { windowId: string; sessionId: string } {
  const fullCmd = contextPath ? `CC2WECHAT_CONTEXT=${contextPath} ${cmd}` : cmd;
  const escaped = fullCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const output = execSync(`osascript -e '
    tell application "iTerm2"
      set w to (create window with default profile)
      set s to current session of w
      tell s
        write text "${escaped}"
      end tell
      return (id of w) & "," & (unique id of s)
    end tell
  '`, { encoding: 'utf-8', timeout: 10000 }).trim();

  // iTerm 返回格式如 "1463, ,, D0EFA5D6-..." — 过滤空白取首尾
  const parts = output.split(',').map(s => s.trim()).filter(Boolean);
  const windowId = parts[0] ?? output;
  const sessionId = parts.length > 1 ? parts[parts.length - 1] : `session-${Date.now()}`;
  return { windowId, sessionId };
}
