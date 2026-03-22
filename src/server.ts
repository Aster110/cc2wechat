#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loginWithQRWeb } from './auth.js';
import { getActiveAccount, saveAccount, loadSyncBuf, saveSyncBuf } from './store.js';
import {
  getUpdates,
  sendMessage,
  sendTyping,
  getConfig,
} from './wechat-api.js';
import type { WeixinMessage } from './types.js';
import { MessageItemType } from './types.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pollingActive = false;
let pollingAbort: AbortController | null = null;

/** Cache: userId -> typing_ticket */
const typingTicketCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Message text extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Text chunking for WeChat 4000-char limit
// ---------------------------------------------------------------------------

const MAX_CHUNK_LENGTH = 3900;

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

// ---------------------------------------------------------------------------
// Strip markdown for WeChat plain text
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'wechat-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
  },
);

// -- Tools --

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply to a WeChat message. The content will be converted from markdown to plain text automatically.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: {
            type: 'string',
            description: 'The WeChat user ID to reply to (from_user_id from the incoming message)',
          },
          context_token: {
            type: 'string',
            description: 'The context_token from the incoming message (required for reply association)',
          },
          content: {
            type: 'string',
            description: 'The reply text content (markdown will be stripped)',
          },
        },
        required: ['user_id', 'context_token', 'content'],
      },
    },
    {
      name: 'login',
      description:
        'Login to WeChat by scanning a QR code. Run this first if not already logged in.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'login') {
    try {
      const result = await loginWithQRWeb();
      saveAccount({
        accountId: result.accountId,
        token: result.token,
        baseUrl: result.baseUrl,
        savedAt: new Date().toISOString(),
      });
      // Start polling after login
      startPolling();
      return {
        content: [
          {
            type: 'text' as const,
            text: `WeChat login successful! Account: ${result.accountId}. Polling started.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Login failed: ${String(err)}` },
        ],
        isError: true,
      };
    }
  }

  if (name === 'reply') {
    const userId = (args as Record<string, string>).user_id;
    const contextToken = (args as Record<string, string>).context_token;
    const content = (args as Record<string, string>).content;

    if (!userId || !contextToken || !content) {
      return {
        content: [
          { type: 'text' as const, text: 'Missing required fields: user_id, context_token, content' },
        ],
        isError: true,
      };
    }

    const account = getActiveAccount();
    if (!account) {
      return {
        content: [
          { type: 'text' as const, text: 'Not logged in. Use the login tool first.' },
        ],
        isError: true,
      };
    }

    try {
      // Send typing indicator
      const ticket = typingTicketCache.get(userId);
      if (ticket) {
        await sendTyping(account.token, userId, ticket, 1, account.baseUrl).catch(() => {});
      }

      // Strip markdown and chunk
      const plainText = stripMarkdown(content);
      const chunks = chunkText(plainText);

      for (const chunk of chunks) {
        await sendMessage(account.token, userId, chunk, contextToken, account.baseUrl);
      }

      // Cancel typing
      if (ticket) {
        await sendTyping(account.token, userId, ticket, 2, account.baseUrl).catch(() => {});
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Reply sent to ${userId} (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Failed to send reply: ${String(err)}` },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// Long-polling loop
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

async function pollLoop(account: { token: string; accountId: string; baseUrl?: string }): Promise<void> {
  let buf = loadSyncBuf(account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  process.stderr.write(`[wechat-channel] Polling started for account ${account.accountId}\n`);

  while (pollingActive && !pollingAbort?.signal.aborted) {
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
          process.stderr.write(
            `[wechat-channel] Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing ${Math.ceil(SESSION_PAUSE_MS / 60_000)} min\n`,
          );
          consecutiveFailures = 0;
          await sleep(SESSION_PAUSE_MS, pollingAbort?.signal);
          continue;
        }

        consecutiveFailures++;
        process.stderr.write(
          `[wechat-channel] getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})\n`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, pollingAbort?.signal);
        } else {
          await sleep(RETRY_DELAY_MS, pollingAbort?.signal);
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

        const text = extractText(msg);
        const fromUser = msg.from_user_id ?? 'unknown';
        const contextToken = msg.context_token ?? '';

        process.stderr.write(`[wechat-channel] Message from ${fromUser}: ${text.slice(0, 100)}\n`);

        // Cache typing ticket for this user
        try {
          const cfg = await getConfig(account.token, fromUser, contextToken, account.baseUrl);
          if (cfg.typing_ticket) {
            typingTicketCache.set(fromUser, cfg.typing_ticket);
          }
        } catch {
          // non-critical
        }

        // Send typing indicator
        const ticket = typingTicketCache.get(fromUser);
        if (ticket) {
          await sendTyping(account.token, fromUser, ticket, 1, account.baseUrl).catch(() => {});
        }

        // Push to Claude Code via channel notification
        server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: text,
            meta: {
              source: 'wechat',
              sender: fromUser,
              user_id: fromUser,
              context_token: contextToken,
              message_id: String(msg.message_id ?? ''),
              session_id: msg.session_id ?? '',
            },
          },
        });
      }
    } catch (err) {
      if (pollingAbort?.signal.aborted) return;
      consecutiveFailures++;
      process.stderr.write(
        `[wechat-channel] Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}\n`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, pollingAbort?.signal);
      } else {
        await sleep(RETRY_DELAY_MS, pollingAbort?.signal);
      }
    }
  }
}

function startPolling(): void {
  const account = getActiveAccount();
  if (!account) {
    process.stderr.write('[wechat-channel] No account found, skipping polling\n');
    return;
  }
  if (pollingActive) {
    process.stderr.write('[wechat-channel] Polling already active\n');
    return;
  }

  pollingActive = true;
  pollingAbort = new AbortController();

  // Run poll loop in background (don't await)
  pollLoop(account).catch((err) => {
    if (!pollingAbort?.signal.aborted) {
      process.stderr.write(`[wechat-channel] Poll loop crashed: ${String(err)}\n`);
    }
    pollingActive = false;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[wechat-channel] MCP server started\n');

  // Auto-start polling if we have saved credentials
  const account = getActiveAccount();
  if (account) {
    process.stderr.write(`[wechat-channel] Found saved account: ${account.accountId}\n`);
    startPolling();
  } else {
    process.stderr.write('[wechat-channel] No saved account. Use the login tool to connect.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[wechat-channel] Fatal: ${String(err)}\n`);
  process.exit(1);
});
