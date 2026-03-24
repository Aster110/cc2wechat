#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';

import { loginWithQRWeb } from '../auth.js';
import { getActiveAccount, saveAccount, loadSyncBuf, saveSyncBuf } from '../store.js';
import { getUpdates, sendTyping, getConfig, sendMessage, uploadAndSendMedia, downloadMedia } from '../wechat-api.js';
import { MessageItemType } from '../types.js';
import type { WeixinMessage } from '../types.js';
import type { AccountData } from '../store.js';
import { extractText, userIdToSessionUUID, log, logError } from '../utils.js';

import { loadConfig } from './core/config.js';
import { selectDelivery } from './core/bootstrap.js';
import { Router } from './core/router.js';
import { createDefaultGateway } from './core/command-gateway.js';
import { Replier } from './sender/replier.js';
import { ClaudeCodeBackend } from './backends/claude-code.js';
import { TerminalDelivery } from './deliveries/terminal/terminal-delivery.js';
import { SDKDelivery } from './deliveries/sdk/sdk-delivery.js';
import { PipeDelivery } from './deliveries/pipe/pipe-delivery.js';
import type { MessageSender, MessageContext, Delivery, AIBackend } from './interfaces/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTH_PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Media download helper (from daemon.ts)
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

    const media = item.image_item?.media ?? item.video_item?.media ?? item.file_item?.media;
    if (!media?.encrypt_query_param || !media?.aes_key) continue;

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
// WeChat Sender adapter (bridges wechat-api to MessageSender interface)
// ---------------------------------------------------------------------------

function createWeChatSender(account: AccountData): MessageSender {
  return {
    async sendText(to: string, text: string, contextToken: string): Promise<void> {
      await sendMessage(account.token, to, text, contextToken, account.baseUrl);
    },
    async sendMedia(to: string, filePath: string, contextToken: string): Promise<void> {
      await uploadAndSendMedia({
        token: account.token,
        toUser: to,
        contextToken,
        filePath,
        baseUrl: account.baseUrl,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Typing indicator + reply context helpers
// ---------------------------------------------------------------------------

async function sendTypingIndicator(account: AccountData, userId: string, contextToken: string): Promise<void> {
  try {
    const cfg = await getConfig(account.token, userId, contextToken, account.baseUrl);
    if (cfg.typing_ticket) {
      await sendTyping(account.token, userId, cfg.typing_ticket, 1, account.baseUrl).catch(() => {});
    }
  } catch {
    // non-critical
  }
}

function contextPathForUser(userId: string): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
  return `/tmp/cc2wechat-ctx-${hash}.json`;
}

function writeReplyContext(account: AccountData, userId: string, contextToken: string): string {
  const filePath = contextPathForUser(userId);
  fs.writeFileSync(filePath, JSON.stringify({
    token: account.token,
    baseUrl: account.baseUrl,
    userId,
    contextToken,
  }));
  return filePath;
}

// ---------------------------------------------------------------------------
// Port check (from daemon.ts)
// ---------------------------------------------------------------------------

async function isPortInUse(port: number): Promise<number | null> {
  try {
    const { execSync } = await import('node:child_process');
    const pid = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return pid ? parseInt(pid, 10) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Long-polling loop (from daemon.ts, now uses v5 Router)
// ---------------------------------------------------------------------------

// closeSession 和 createSession 现在由 Delivery 接口统一提供，不再在 main.ts 里写平台特定代码

const commandGateway = createDefaultGateway();

async function pollLoop(account: AccountData, router: Router, cwd: string, delivery: Delivery, backend: AIBackend): Promise<void> {
  let buf = loadSyncBuf(account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  log(`Polling started for account ${account.accountId}`);

  while (true) {
    try {
      const resp = await getUpdates(account.token, buf, account.baseUrl, nextTimeoutMs);

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          log(`Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing ${Math.ceil(SESSION_PAUSE_MS / 60_000)} min`);
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

      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        saveSyncBuf(account.accountId, resp.get_updates_buf);
        buf = resp.get_updates_buf;
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        if (msg.message_type !== 1) continue;

        // Download media + build MessageContext
        const mediaPaths = await downloadMediaItems(msg, account);
        const text = extractText(msg, mediaPaths);
        const userId = msg.from_user_id ?? '';
        const contextToken = msg.context_token ?? '';

        log(`<- ${userId.slice(0, 10)}...: ${text.slice(0, 50)}`);

        // 命令网关拦截（O(1) 查找，零开销）
        const handled = await commandGateway.tryHandle({
          userId, contextToken, text,
          delivery,
          reply: (t) => sendMessage(account.token, userId, t, contextToken, account.baseUrl),
          closeSession: (uid) => delivery.closeSession(uid),
          createNewSession: (uid) => delivery.createSession(uid, backend, cwd),
        });
        if (handled) continue;

        // Write reply context for reply-cli
        writeReplyContext(account, userId, contextToken);

        // Send typing indicator (不阻塞消息路由)
        sendTypingIndicator(account, userId, contextToken).catch(() => {});

        // Build MessageContext and route through v5 Router
        const ctx: MessageContext = {
          text,
          mediaFiles: [...mediaPaths.values()],
          userId,
          sessionId: userIdToSessionUUID(userId),
          contextToken,
          rawMessage: msg,
          account,
          cwd,
        };

        await router.handle(ctx);
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

async function main(): Promise<void> {
  console.log('\n  cc2wechat v5 — Delivery x Backend Architecture\n');

  // Prevent duplicate startup
  const existingPid = await isPortInUse(HEALTH_PORT);
  if (existingPid) {
    console.log(`  ⚠️  cc2wechat 已在运行 (PID ${existingPid}, port ${HEALTH_PORT})`);
    console.log(`  用 cc2wechat stop 停止，或 cc2wechat restart 重启`);
    console.log(`  多账号？用 CC2WECHAT_PORT=18082 cc2wechat start\n`);
    process.exit(0);
  }

  // Login
  let account = getActiveAccount(HEALTH_PORT);
  if (!account) {
    console.log('  No saved credentials. Starting login...');
    const result = await loginWithQRWeb();
    saveAccount({
      accountId: result.accountId.replace(/@/g, '-').replace(/\./g, '-'),
      token: result.token,
      baseUrl: result.baseUrl,
      savedAt: new Date().toISOString(),
      port: HEALTH_PORT,
    });
    account = getActiveAccount(HEALTH_PORT)!;
  }

  console.log(`  Account: ${account.accountId}`);

  // Load config
  const config = loadConfig();

  // Bootstrap: select backend + delivery
  const backend = new ClaudeCodeBackend();
  const candidates = [
    new TerminalDelivery(),
    new SDKDelivery(),
    new PipeDelivery(),
  ];
  const delivery = await selectDelivery(candidates, config.delivery);
  await delivery.initialize(config as unknown as Record<string, unknown>);
  log(`Delivery: ${delivery.name}, Backend: ${backend.name}`);

  // Build sender + replier + router
  const sender = createWeChatSender(account);
  const replier = new Replier(sender, {
    maxChunkSize: config.reply?.maxChunkSize ?? 3900,
    stripMarkdown: config.reply?.stripMarkdown ?? true,
  });
  const router = new Router(delivery, backend, replier);

  console.log(`  Health check: http://localhost:${HEALTH_PORT}/health`);
  console.log('  Listening for WeChat messages...\n');

  // Health check HTTP server
  const startedAt = new Date().toISOString();
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        version: 'v5',
        account: account!.accountId,
        delivery: delivery.name,
        backend: backend.name,
        startedAt,
        uptime: process.uptime(),
      }));
    } else if (req.url === '/close-session' && req.method === 'POST') {
      // CC 调 cc2wechat --end 时，通过 Delivery 接口关闭会话（零平台特定代码）
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { contextPath } = JSON.parse(body) as { contextPath?: string };
          if (contextPath && fs.existsSync(contextPath)) {
            const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf-8')) as { userId?: string };
            if (ctx.userId) {
              delivery.closeSession(ctx.userId).catch(() => {});
            }
          }
          res.writeHead(200);
          res.end('ok');
        } catch {
          res.writeHead(400);
          res.end('bad request');
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }).listen(HEALTH_PORT, () => {
    log(`Health server on :${HEALTH_PORT}`);
  });

  const cwd = config.cwd ?? process.cwd();
  console.log(`  Working directory: ${cwd}`);
  await pollLoop(account, router, cwd, delivery, backend);
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
