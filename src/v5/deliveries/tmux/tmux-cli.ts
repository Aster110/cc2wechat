import { execSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * 检查 tmux 是否安装
 */
export function hasTmux(): boolean {
  try {
    execSync('which tmux', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查 tmux session 是否存活
 */
export function isTmuxSessionAlive(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${escapeSessionName(sessionName)} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建新 tmux session（detached 模式），在其中执行命令
 */
export function createTmuxSession(name: string, cwd: string, cmd: string): void {
  const safeName = escapeSessionName(name);
  // 先确保没有同名 session 残留
  if (isTmuxSessionAlive(name)) {
    killTmuxSession(name);
  }
  // tmux new-session 的 shell-command 参数直接被 shell 执行
  // 用单引号包裹整个命令，防止外层 shell 解释变量
  execSync(
    `tmux new-session -d -s ${safeName} -c ${escapeShellArg(cwd)} ${escapeShellArg(cmd)}`,
    { encoding: 'utf-8', timeout: 10000 },
  );
}

/**
 * 注入文本到已有 tmux session
 *
 * 使用 tmux send-keys 的字面文本模式（-l），避免特殊键解释。
 * 文本先写入临时文件再 load-buffer + paste-buffer，彻底避免 shell 转义问题。
 */
export function sendToSession(sessionName: string, text: string): boolean {
  const safeName = escapeSessionName(sessionName);
  try {
    // 写入临时文件，用 buffer 方式注入（最安全的方式，无转义问题）
    const tmpFile = `/tmp/cc2wechat-tmux-buf-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, text);
    try {
      // load-buffer 读入 tmux 缓冲区，paste-buffer 粘贴到 session
      execSync(
        `tmux load-buffer ${escapeShellArg(tmpFile)} \\; paste-buffer -t ${safeName} -d`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      // 发送 Enter 键执行
      execSync(
        `tmux send-keys -t ${safeName} Enter`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      return true;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tmux-cli] sendToSession FAILED: session=${sessionName} err=${msg}`);
    return false;
  }
}

/**
 * 关闭 tmux session
 */
export function killTmuxSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${escapeSessionName(name)}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch { /* already dead */ }
}

/**
 * 转义 session 名，只允许安全字符
 */
function escapeSessionName(name: string): string {
  // tmux session 名只允许字母、数字、下划线、短横线、点号
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

/**
 * 安全转义 shell 参数（单引号包裹法）
 */
function escapeShellArg(arg: string): string {
  // 单引号包裹，内部单引号用 '\'' 转义
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
