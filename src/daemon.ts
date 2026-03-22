#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const replyCli = path.join(__dirname, 'reply-cli.js');

import { loginWithQRWeb } from './auth.js';
import { getActiveAccount, saveAccount, loadSyncBuf, saveSyncBuf } from './store.js';
import { getUpdates, sendMessage, sendTyping, getConfig, uploadAndSendMedia } from './wechat-api.js';
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
const MAX_CHUNK_LENGTH = 3900;

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

function stripMarkdown(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Links: keep display text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  // Headings
  result = result.replace(/^#{1,6}\s+/gm, '');
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '');
  // Blockquotes
  result = result.replace(/^>\s?/gm, '');
  return result.trim();
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to break at newline
    let breakAt = remaining.lastIndexOf('\n', MAX_CHUNK_LENGTH);
    if (breakAt < MAX_CHUNK_LENGTH * 0.5) {
      // No good newline break, try space
      breakAt = remaining.lastIndexOf(' ', MAX_CHUNK_LENGTH);
    }
    if (breakAt < MAX_CHUNK_LENGTH * 0.3) {
      breakAt = MAX_CHUNK_LENGTH;
    }
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Core message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg: WeixinMessage, account: AccountData): Promise<void> {
  const text = extractText(msg);
  const userId = msg.from_user_id ?? '';
  const contextToken = msg.context_token ?? '';
  const sessionId = userIdToSessionUUID(userId);

  console.log(`[cc2wechat] <- ${userId.slice(0, 10)}...: ${text.slice(0, 50)}`);

  const systemPrompt = `You are responding to a WeChat message. Keep replies concise (under 500 chars when possible).

You have these WeChat commands available via Bash:
- Send image/file to user: node ${replyCli} --image /absolute/path/to/file
- Send text message mid-process: node ${replyCli} --text "processing..."

When user asks for screenshots, files, or images:
1. Create/save the file (e.g. screencapture -x /tmp/screenshot.png)
2. Send it: node ${replyCli} --image /tmp/screenshot.png
3. Confirm in your response

Your final text response will also be sent to WeChat automatically.

IMPORTANT: You are running in non-interactive mode. Do NOT use Agent Teams (TeamCreate/TaskCreate). Handle all tasks yourself sequentially.`;

  // Write context for cc2wechat-reply CLI
  const contextPath = '/tmp/cc2wechat-context.json';
  fs.writeFileSync(contextPath, JSON.stringify({
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

  // Call claude -p (try resume first, fallback to new session)
  let result: string;
  const prompt = JSON.stringify(text);
  try {
    // Try resuming existing session
    result = execSync(
      `claude -p ${prompt} --resume ${sessionId} --output-format text --permission-mode bypassPermissions --system-prompt ${JSON.stringify(systemPrompt)}`,
      { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd: process.cwd() },
    ).trim();
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = execErr.stderr ?? execErr.message ?? '';
    // If session not found, create new one
    if (stderr.includes('session') || stderr.includes('resume') || !execErr.stdout?.trim()) {
      try {
        result = execSync(
          `claude -p ${prompt} --session-id ${sessionId} --output-format text --permission-mode bypassPermissions --system-prompt ${JSON.stringify(systemPrompt)}`,
          { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd: process.cwd() },
        ).trim();
      } catch (err2: unknown) {
        const execErr2 = err2 as { stdout?: string; message?: string };
        result = execErr2.stdout?.trim() || `Error: ${execErr2.message ?? 'unknown'}`;
      }
    } else {
      result = execErr.stdout?.trim() || `Error: ${stderr}`;
    }
  }

  console.log(`[cc2wechat] -> ${result.slice(0, 100)}...`);

  // Strip markdown + chunk + send text
  const plainText = stripMarkdown(result);
  const chunks = chunkText(plainText);
  for (const chunk of chunks) {
    await sendMessage(account.token, userId, chunk, contextToken, account.baseUrl);
  }

  // Detect file paths in output, auto-send
  const fileMatch = result.match(/\/(tmp|Users|home)[\w/._-]+\.(png|jpg|jpeg|gif|mp4|pdf|zip)/gi);
  if (fileMatch) {
    for (const filePath of fileMatch) {
      if (fs.existsSync(filePath)) {
        console.log(`[cc2wechat] Sending file: ${filePath}`);
        try {
          await uploadAndSendMedia({
            token: account.token,
            toUser: userId,
            contextToken,
            filePath,
            baseUrl: account.baseUrl,
          });
        } catch (err: unknown) {
          const sendErr = err as { message?: string };
          console.error(`[cc2wechat] Failed to send file: ${sendErr.message ?? 'unknown'}`);
        }
      }
    }
  }

  // Cancel typing
  try {
    const cfg = await getConfig(account.token, userId, contextToken, account.baseUrl);
    if (cfg.typing_ticket) {
      await sendTyping(account.token, userId, cfg.typing_ticket, 2, account.baseUrl).catch(() => {});
    }
  } catch {
    // non-critical
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
  console.log('\n  cc2wechat v2 — Pipe Mode\n');

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
