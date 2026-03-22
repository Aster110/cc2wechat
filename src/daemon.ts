#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const replyCli = path.join(__dirname, 'reply-cli.js');
const IS_MACOS = process.platform === 'darwin';

import { loginWithQRWeb } from './auth.js';
import { getActiveAccount, saveAccount, loadSyncBuf, saveSyncBuf } from './store.js';
import { getUpdates, sendTyping, getConfig } from './wechat-api.js';
import type { WeixinMessage } from './types.js';
import { MessageItemType } from './types.js';
import type { AccountData } from './store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userIdToSessionUUID(userId: string): string {
  const hash = createHash('md5').update(`cc2wechat:${userId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function extractText(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MessageItemType.IMAGE) {
      parts.push('[Image]');
    } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(`[Voice] ${item.voice_item.text}`);
    } else if (item.type === MessageItemType.FILE && item.file_item?.file_name) {
      parts.push(`[File: ${item.file_item.file_name}]`);
    } else if (item.type === MessageItemType.VIDEO) {
      parts.push('[Video]');
    }
  }
  return parts.join('\n') || '[Empty message]';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// iTerm Tab Management
// ---------------------------------------------------------------------------

// Maintain tab state per WeChat user
const userTabs = new Map<string, string>(); // userId -> tabName

// Track tab IDs - persisted to file so it survives daemon restart
const TAB_REGISTRY_PATH = '/tmp/cc2wechat-tabs.json';
const tabSessionIds = new Map<string, string>(); // tabName -> iTerm session id

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
// Core message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg: WeixinMessage, account: AccountData): Promise<void> {
  const text = extractText(msg);
  const userId = msg.from_user_id ?? '';
  const contextToken = msg.context_token ?? '';
  const sessionId = userIdToSessionUUID(userId);
  const tabName = `wechat-${userId.slice(0, 8)}`;
  const cwd = process.cwd();

  console.log(`[cc2wechat] <- ${userId.slice(0, 10)}...: ${text.slice(0, 50)}`);

  // Write context for reply-cli
  fs.writeFileSync('/tmp/cc2wechat-context.json', JSON.stringify({
    token: account.token,
    baseUrl: account.baseUrl,
    userId,
    contextToken,
  }));

  // Send typing indicator
  try {
    const cfg = await getConfig(account.token, userId, contextToken, account.baseUrl);
    if (cfg.typing_ticket) {
      await sendTyping(account.token, userId, cfg.typing_ticket, 1, account.baseUrl).catch(() => {});
    }
  } catch {
    // non-critical
  }

  if (IS_MACOS) {
    // v3: Interactive Terminal Mode (macOS + iTerm2)
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
  } else {
    // v2: Pipe Mode fallback (Windows/Linux)
    console.log(`[cc2wechat] -> pipe mode: ${text.slice(0, 30)}...`);
    const prompt = JSON.stringify(text);
    const systemPrompt = JSON.stringify(`You are responding to a WeChat message. Keep replies concise. Use this to reply: node ${replyCli} --text "reply" or node ${replyCli} --image /path/to/file`);
    let result: string;
    try {
      result = execSync(
        `claude -p ${prompt} --resume ${sessionId} --output-format text --permission-mode bypassPermissions --system-prompt ${systemPrompt}`,
        { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd },
      ).trim();
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      if (!execErr.stdout?.trim()) {
        try {
          result = execSync(
            `claude -p ${prompt} --session-id ${sessionId} --output-format text --permission-mode bypassPermissions --system-prompt ${systemPrompt}`,
            { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd },
          ).trim();
        } catch (err2: unknown) {
          const execErr2 = err2 as { stdout?: string; message?: string };
          result = execErr2.stdout?.trim() || `Error: ${execErr2.message ?? 'unknown'}`;
        }
      } else {
        result = execErr.stdout.trim();
      }
    }
    // Auto-send text reply
    const { sendMessage: sendMsg } = await import('./wechat-api.js');
    const plain = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, c: string) => c.trim())
      .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').trim();
    const chunks = plain.length <= 3900 ? [plain] : [plain.slice(0, 3900), plain.slice(3900)];
    for (const chunk of chunks) {
      await sendMsg(account.token, userId, chunk, contextToken, account.baseUrl);
    }
    console.log(`[cc2wechat] -> replied (${chunks.length} chunk)`);
  }
}

// ---------------------------------------------------------------------------
// Long-polling loop
// ---------------------------------------------------------------------------

async function pollLoop(account: AccountData): Promise<void> {
  let buf = loadSyncBuf(account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  console.log(`[cc2wechat] Polling started for account ${account.accountId}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const resp = await getUpdates(account.token, buf, account.baseUrl, nextTimeoutMs);

      // Update timeout if server suggests one
      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      // Check for API errors
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          console.log(
            `[cc2wechat] Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing ${Math.ceil(SESSION_PAUSE_MS / 60_000)} min`,
          );
          consecutiveFailures = 0;
          await sleep(SESSION_PAUSE_MS);
          continue;
        }

        consecutiveFailures++;
        console.error(
          `[cc2wechat] getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
        continue;
      }

      consecutiveFailures = 0;

      // Save sync buf
      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        saveSyncBuf(account.accountId, resp.get_updates_buf);
        buf = resp.get_updates_buf;
      }

      // Process messages
      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        // Only process user messages (message_type === 1)
        if (msg.message_type !== 1) continue;

        // Handle each message (sequential to avoid race conditions)
        await handleMessage(msg, account);
      }
    } catch (err) {
      consecutiveFailures++;
      console.error(
        `[cc2wechat] Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS);
      } else {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n  cc2wechat v3 — Interactive Terminal Mode\n');

  let account = getActiveAccount();
  if (!account) {
    console.log('  No saved credentials. Starting login...');
    const result = await loginWithQRWeb();
    saveAccount({
      accountId: result.accountId.replace(/@/g, '-').replace(/\./g, '-'),
      token: result.token,
      baseUrl: result.baseUrl,
      savedAt: new Date().toISOString(),
    });
    account = getActiveAccount()!;
  }

  console.log(`  Account: ${account.accountId}`);
  console.log('  Listening for WeChat messages...\n');

  await pollLoop(account);
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
