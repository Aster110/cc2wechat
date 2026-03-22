#!/usr/bin/env node

import fs from 'node:fs';

import { loginWithQRWeb } from './auth.js';
import { getActiveAccount, saveAccount, loadSyncBuf, saveSyncBuf } from './store.js';
import { getUpdates, sendTyping, getConfig } from './wechat-api.js';
import type { WeixinMessage } from './types.js';
import type { AccountData } from './store.js';
import { extractText } from './utils.js';
import { handleMessageTerminal } from './handlers/terminal.js';
import { handleMessagePipe } from './handlers/pipe.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IS_MACOS = process.platform === 'darwin';

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Core message handler — routes to platform-specific handler
// ---------------------------------------------------------------------------

async function handleMessage(msg: WeixinMessage, account: AccountData): Promise<void> {
  const text = extractText(msg);
  const userId = msg.from_user_id ?? '';
  const contextToken = msg.context_token ?? '';

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
    await handleMessageTerminal(msg, account);
  } else {
    await handleMessagePipe(msg, account);
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
