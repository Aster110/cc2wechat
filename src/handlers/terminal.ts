import { execSync } from 'node:child_process';
import fs from 'node:fs';

import type { WeixinMessage } from '../types.js';
import type { AccountData } from '../store.js';
import { getConfig, sendTyping } from '../wechat-api.js';
import { extractText, userIdToSessionUUID, sleep } from '../utils.js';

// ---------------------------------------------------------------------------
// iTerm Tab Management
// ---------------------------------------------------------------------------

// Maintain tab state per WeChat user
const userTabs = new Map<string, string>(); // userId -> tabName

// Track tab IDs - persisted to file so it survives daemon restart
const TAB_REGISTRY_PATH = '/tmp/cc2wechat-tabs.json';
const tabSessionIds = new Map<string, string>(); // tabName -> iTerm window id

// Load persisted tab registry on startup
try {
  if (fs.existsSync(TAB_REGISTRY_PATH)) {
    const data = JSON.parse(fs.readFileSync(TAB_REGISTRY_PATH, 'utf-8'));
    for (const [k, v] of Object.entries(data)) {
      tabSessionIds.set(k, v as string);
    }
  }
} catch {}

function saveTabRegistry(): void {
  fs.writeFileSync(TAB_REGISTRY_PATH, JSON.stringify(Object.fromEntries(tabSessionIds)));
}

function tabExists(tabName: string): boolean {
  const windowId = tabSessionIds.get(tabName);
  if (!windowId) return false;
  try {
    const result = execSync(`osascript -e '
      tell application "iTerm2"
        try
          set w to (first window whose id is ${windowId})
          return "found"
        on error
          return "not_found"
        end try
      end tell
    '`, { encoding: 'utf-8' }).trim();
    return result === 'found';
  } catch {
    return false;
  }
}

function createTabAndStartCC(tabName: string, ccSessionId: string, cwd: string): void {
  // Create NEW WINDOW and capture window ID (same approach as cc-mesh)
  const windowId = execSync(`osascript -e '
    tell application "iTerm2"
      set w to (create window with default profile)
      tell current session of w
        write text "cd ${cwd} && claude --resume ${ccSessionId} --dangerously-skip-permissions"
      end tell
      return id of w
    end tell
  '`, { encoding: 'utf-8' }).trim();
  tabSessionIds.set(tabName, windowId);
  saveTabRegistry();
  console.log(`[cc2wechat] window created: ${tabName} -> window id: ${windowId}`);
}

function injectMessage(tabName: string, message: string): void {
  const windowId = tabSessionIds.get(tabName);
  if (!windowId) return;
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  execSync(`osascript -e '
    tell application "iTerm2"
      tell current session of (first window whose id is ${windowId})
        write text "${escaped}"
      end tell
    end tell
  '`);
}

// ---------------------------------------------------------------------------
// Terminal mode message handler
// ---------------------------------------------------------------------------

export async function handleMessageTerminal(msg: WeixinMessage, account: AccountData): Promise<void> {
  const text = extractText(msg);
  const userId = msg.from_user_id ?? '';
  const sessionId = userIdToSessionUUID(userId);
  const tabName = `wechat-${userId.slice(0, 8)}`;
  const cwd = process.cwd();

  if (tabExists(tabName)) {
    console.log(`[cc2wechat] -> inject to existing window: ${tabName}`);
    injectMessage(tabName, `[微信] ${text}`);
  } else {
    console.log(`[cc2wechat] -> creating window: ${tabName} (session: ${sessionId})`);
    createTabAndStartCC(tabName, sessionId, cwd);
    await sleep(5000);
    injectMessage(tabName, `[微信] ${text}`);
  }
  userTabs.set(userId, tabName);
}
