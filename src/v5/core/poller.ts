import type { WeixinMessage } from '../../types.js';
import type { AccountData } from '../../store.js';
import { getUpdates, sendMessage, sendTyping } from '../../wechat-api.js';
import { loadSyncBuf, saveSyncBuf } from '../../store.js';
import { extractText, userIdToSessionUUID, log, logError } from '../../utils.js';

import { downloadMediaItems } from '../receiver/media.js';
import { writeReplyContext } from '../sender/wechat-sender.js';
import type { Router } from './router.js';
import type { CommandGateway } from './command-gateway.js';
import type { Delivery, AIBackend, MessageContext } from '../interfaces/index.js';

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProcessMessageDeps {
  account: AccountData;
  router: Router;
  delivery: Delivery;
  backend: AIBackend;
  gateway: CommandGateway;
  cwd: string;
  accountName?: string;
}

export async function processMessage(msg: WeixinMessage, deps: ProcessMessageDeps): Promise<void> {
  if (msg.message_type !== 1) return;

  const { account, router, delivery, backend, gateway, cwd, accountName } = deps;

  const mediaPaths = await downloadMediaItems(msg, account);
  const text = extractText(msg, mediaPaths);
  const userId = msg.from_user_id ?? '';
  const contextToken = msg.context_token ?? '';

  log(`<- ${userId.slice(0, 10)}...: ${text.slice(0, 50)}`);

  const handled = await gateway.tryHandle({
    userId, contextToken, text,
    delivery,
    reply: (t) => sendMessage(account.token, userId, t, contextToken, account.baseUrl),
    closeSession: (uid) => delivery.closeSession(uid),
    createNewSession: (uid) => delivery.createSession(uid, backend, cwd),
  });
  if (handled) return;

  writeReplyContext(account, userId, contextToken);

  sendTyping(account.token, userId, '', 1, account.baseUrl).catch(() => {});

  const ctx: MessageContext & { mediaPaths: Map<number, string> } = {
    text,
    mediaFiles: [...mediaPaths.values()],
    mediaPaths,
    userId,
    sessionId: userIdToSessionUUID(userId),
    contextToken,
    rawMessage: msg,
    account,
    cwd,
    accountName: accountName ?? undefined,
  };

  await router.handle(ctx);
}

export async function pollLoop(
  account: AccountData,
  router: Router,
  cwd: string,
  delivery: Delivery,
  backend: AIBackend,
  gateway: CommandGateway,
  accountName?: string,
): Promise<void> {
  let buf = loadSyncBuf(account.accountId);
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  log(`Polling started for account ${account.accountId}`);

  const deps: ProcessMessageDeps = { account, router, delivery, backend, gateway, cwd, accountName };

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
        await processMessage(msg, deps);
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
