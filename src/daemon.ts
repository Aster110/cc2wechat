#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';

import { loginWithQRWeb } from './auth.js';
import { getActiveAccount, saveAccount, loadSyncBuf, saveSyncBuf } from './store.js';
import { getUpdates, sendTyping, getConfig, downloadMedia } from './wechat-api.js';
import { MessageItemType } from './types.js';
import type { WeixinMessage } from './types.js';
import type { AccountData } from './store.js';
import { extractText, log, logError } from './utils.js';
import { handleMessageTerminal } from './handlers/terminal.js';
import { handleMessagePipe } from './handlers/pipe.js';
import { handleMessageSDK } from './handlers/sdk.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IS_MACOS = process.platform === 'darwin';
const HEALTH_PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);

function hasITerm(): boolean {
  try {
    return fs.existsSync('/Applications/iTerm.app');
  } catch {
    return false;
  }
}

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Media download helper
// ---------------------------------------------------------------------------

const MEDIA_TYPE_EXT: Record<number, string> = {
  [MessageItemType.IMAGE]: '.jpg',
  [MessageItemType.VIDEO]: '.mp4',
  [MessageItemType.FILE]: '',
};

async function downloadMediaItems(
  msg: WeixinMessage,
  account: AccountData,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const items = msg.item_list ?? [];
  const msgId = msg.message_id ?? Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== MessageItemType.IMAGE &&
        item.type !== MessageItemType.VIDEO &&
        item.type !== MessageItemType.FILE) continue;

    // Get the CDNMedia info from the appropriate item field
    const media = item.image_item?.media ?? item.video_item?.media ?? item.file_item?.media;
    if (!media?.encrypt_query_param || !media?.aes_key) continue;

    // Determine file extension
    let ext = MEDIA_TYPE_EXT[item.type] ?? '';
    if (item.type === MessageItemType.FILE && item.file_item?.file_name) {
      const dotIdx = item.file_item.file_name.lastIndexOf('.');
      ext = dotIdx >= 0 ? item.file_item.file_name.slice(dotIdx) : '';
    }

    const fileName = `${msgId}-${i}${ext}`;

    try {
      const filePath = await downloadMedia({
        token: account.token,
        encryptQueryParam: media.encrypt_query_param,
        aesKey: media.aes_key,
        outputFileName: fileName,
        baseUrl: account.baseUrl,
      });
      result.set(i, filePath);
      log(`downloaded media: ${filePath}`);
    } catch (err) {
      logError(`media download failed for item ${i}: ${String(err)}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Core message handler — routes to platform-specific handler
// ---------------------------------------------------------------------------

async function handleMessage(msg: WeixinMessage, account: AccountData): Promise<void> {
  // Download media items (images, files, videos) before extracting text
  const mediaPaths = await downloadMediaItems(msg, account);
  const text = extractText(msg, mediaPaths);
  const userId = msg.from_user_id ?? '';
  const contextToken = msg.context_token ?? '';

  log(`<- ${userId.slice(0, 10)}...: ${text.slice(0, 50)}`);

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

  if (IS_MACOS && hasITerm()) {
    await handleMessageTerminal(msg, account, text);  // macOS + iTerm: fast lane
  } else {
    await handleMessageSDK(msg, account, text);       // universal fallback
  }
}

// ---------------------------------------------------------------------------
// Long-polling loop
// ---------------------------------------------------------------------------

async function pollLoop(account: AccountData): Promise<void> {
  let buf = loadSyncBuf(account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  log(`Polling started for account ${account.accountId}`);

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
          log(
            `Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing ${Math.ceil(SESSION_PAUSE_MS / 60_000)} min`,
          );
          consecutiveFailures = 0;
          await sleep(SESSION_PAUSE_MS);
          continue;
        }

        consecutiveFailures++;
        logError(
          `getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
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
      const errMsg = err instanceof Error
        ? `${err.message}${err.cause ? ` | cause: ${String(err.cause)}` : ''}${err.stack ? `\n${err.stack.split('\n').slice(1, 3).join('\n')}` : ''}`
        : String(err);
      logError(
        `Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errMsg}`,
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

/** 检测端口是否被占用 */
async function isPortInUse(port: number): Promise<number | null> {
  try {
    const { execSync } = await import('node:child_process');
    const pid = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return pid ? parseInt(pid, 10) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log('\n  cc2wechat v4 — SDK + Terminal Mode\n');

  // 防重复启动：检测端口是否已被占用
  const existingPid = await isPortInUse(HEALTH_PORT);
  if (existingPid) {
    console.log(`  ⚠️  cc2wechat 已在运行 (PID ${existingPid}, port ${HEALTH_PORT})`);
    console.log(`  用 cc2wechat stop 停止，或 cc2wechat restart 重启`);
    console.log(`  多账号？用 CC2WECHAT_PORT=18082 cc2wechat start\n`);
    process.exit(0);
  }

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
  console.log(`  Health check: http://localhost:${HEALTH_PORT}/health`);
  console.log('  Listening for WeChat messages...\n');

  // Health check HTTP server
  const startedAt = new Date().toISOString();
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        account: account!.accountId,
        startedAt,
        uptime: process.uptime(),
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }).listen(HEALTH_PORT, () => {
    log(`Health server on :${HEALTH_PORT}`);
  });

  await pollLoop(account);
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
