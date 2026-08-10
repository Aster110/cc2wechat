/**
 * 假的微信 iLink 后端 —— e2e 用。
 *
 * 真后端的三条口径必须一比一复刻,否则测出来的绿是假的:
 * 1. **HTTP 永远 200**,失败藏在 body 的 ret/errcode 里(`injectSendError` 就是复现这个坑)
 * 2. `getupdates` 是**长轮询**:没新消息就挂住,不是立刻回空
 * 3. `getupdates` **永远不注错** —— poller 靠它的 errcode 做 -14 暂停与退避,
 *    在这条路上注错等于污染语义(见 src/v6/poller.ts)
 *
 * baseUrl 结尾必须带 `/`:apiFetch 用 `new URL(endpoint, baseUrl)`,
 * 少一个斜杠 `ilink/bot/getupdates` 会把最后一段路径吃掉。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SentMessage {
  toUser: string;
  text: string;
  contextToken: string;
  at: number;
}

export interface TypingRecord {
  userId: string;
  ticket: string;
  status: number;
  at: number;
}

export interface FakeILinkOptions {
  /** 没有新消息时长轮询挂起的上限,默认 500ms */
  holdMs?: number;
  /** 回给 daemon 的 longpolling_timeout_ms(下一次的客户端超时),默认 1500ms */
  longPollingTimeoutMs?: number;
  /** getconfig 返回的 typing ticket,默认 'tk-e2e' */
  typingTicket?: string;
  /** 监听端口。默认 0 = 内核随机分配(最安全,绝不会撞 19000 以下) */
  port?: number;
}

export interface PushOptions {
  userId?: string;
  messageId?: number;
  contextToken?: string;
}

export interface FakeILink {
  port: number;
  /** `http://127.0.0.1:<port>/` —— 结尾的斜杠是硬要求 */
  baseUrl: string;
  /** 投递一条用户文本消息(进待发队列,下一次 getupdates 取走) */
  push(text: string, opts?: PushOptions): void;
  /** sendmessage 抓到的全部回复 */
  sent: SentMessage[];
  typings: TypingRecord[];
  getUpdatesCount: number;
  /** 让下一次(或后续 N 次)sendmessage 返回 body 带 errcode 的"假成功" */
  injectSendError(errcode: number, times?: number): void;
  /** 等到 sent 里出现满足谓词的回复;超时抛错,错误里带上已收到的全部回复 */
  waitForReply(pred: (m: SentMessage) => boolean, timeoutMs?: number): Promise<SentMessage>;
  close(): Promise<void>;
}

interface QueuedMessage {
  seq: number;
  msg: Record<string, unknown>;
}

interface PendingPoll {
  rawBuf: string;
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

interface ReplyWaiter {
  pred: (m: SentMessage) => boolean;
  resolve: (m: SentMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_HOLD_MS = 500;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 1500;
const DEFAULT_WAIT_REPLY_MS = 10_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseJson(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** buf 约定:已投递的最大 seq(十进制字符串)。空串 / 垃圾一律当 0。 */
function parseBuf(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function startFakeILink(opts: FakeILinkOptions = {}): Promise<FakeILink> {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
  const longPollingTimeoutMs = opts.longPollingTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const typingTicket = opts.typingTicket ?? 'tk-e2e';

  const queue: QueuedMessage[] = [];
  const pending = new Set<PendingPoll>();
  const replyWaiters = new Set<ReplyWaiter>();
  const sent: SentMessage[] = [];
  const typings: TypingRecord[] = [];

  let seqCounter = 0;
  let getUpdatesCount = 0;
  let injectErrcode = 0;
  let injectRemaining = 0;
  let closed = false;

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
    });
    res.end(payload);
  }

  function respondUpdates(res: http.ServerResponse, rawBuf: string): void {
    const buf = parseBuf(rawBuf);
    const ready = queue.filter((e) => e.seq > buf);
    const nextBuf = ready.length > 0 ? String(ready[ready.length - 1]!.seq) : rawBuf;
    json(res, 200, {
      ret: 0,
      msgs: ready.map((e) => e.msg),
      get_updates_buf: nextBuf,
      longpolling_timeout_ms: longPollingTimeoutMs,
    });
  }

  /** 有新消息了:把所有还挂着、且确实能取到东西的长轮询立刻放掉 */
  function releasePending(): void {
    for (const p of [...pending]) {
      const buf = parseBuf(p.rawBuf);
      if (!queue.some((e) => e.seq > buf)) continue;
      pending.delete(p);
      clearTimeout(p.timer);
      respondUpdates(p.res, p.rawBuf);
    }
  }

  function noteSent(m: SentMessage): void {
    sent.push(m);
    for (const w of [...replyWaiters]) {
      if (!w.pred(m)) continue;
      replyWaiters.delete(w);
      clearTimeout(w.timer);
      w.resolve(m);
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req).catch(() => '');
      const url = (req.url ?? '').split('?')[0] ?? '';
      const body = parseJson(raw);

      switch (url) {
        case '/ilink/bot/getupdates': {
          getUpdatesCount++;
          const rawBuf = typeof body.get_updates_buf === 'string' ? body.get_updates_buf : '';
          const buf = parseBuf(rawBuf);
          if (queue.some((e) => e.seq > buf) || holdMs <= 0 || closed) {
            respondUpdates(res, rawBuf);
            return;
          }
          // 长轮询:挂住,要么被 push 唤醒,要么 holdMs 到点回空
          const entry: PendingPoll = {
            rawBuf,
            res,
            timer: setTimeout(() => {
              pending.delete(entry);
              respondUpdates(res, rawBuf);
            }, holdMs),
          };
          pending.add(entry);
          res.on('close', () => {
            // 客户端先超时断开(AbortController):别再往死连接上写
            if (pending.delete(entry)) clearTimeout(entry.timer);
          });
          return;
        }

        case '/ilink/bot/sendmessage': {
          const msg = (body.msg ?? {}) as Record<string, any>;
          const item = Array.isArray(msg.item_list) ? msg.item_list[0] : undefined;
          noteSent({
            toUser: typeof msg.to_user_id === 'string' ? msg.to_user_id : '',
            text: item?.text_item?.text ?? '',
            contextToken: typeof msg.context_token === 'string' ? msg.context_token : '',
            at: Date.now(),
          });
          if (injectRemaining > 0) {
            injectRemaining--;
            // HTTP 仍然 200 —— 这就是要复现的坑
            json(res, 200, { ret: 0, errcode: injectErrcode, errmsg: 'injected' });
            return;
          }
          json(res, 200, { ret: 0 });
          return;
        }

        case '/ilink/bot/getconfig':
          json(res, 200, { ret: 0, typing_ticket: typingTicket });
          return;

        case '/ilink/bot/sendtyping':
          typings.push({
            userId: typeof body.ilink_user_id === 'string' ? body.ilink_user_id : '',
            ticket: typeof body.typing_ticket === 'string' ? body.typing_ticket : '',
            status: typeof body.status === 'number' ? body.status : 0,
            at: Date.now(),
          });
          json(res, 200, { ret: 0 });
          return;

        default:
          json(res, 404, { ret: -1 });
          return;
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  const fake: FakeILink = {
    port,
    baseUrl: `http://127.0.0.1:${port}/`,
    sent,
    typings,
    get getUpdatesCount(): number {
      return getUpdatesCount;
    },

    push(text, pushOpts = {}) {
      const seq = ++seqCounter;
      queue.push({
        seq,
        msg: {
          message_id: pushOpts.messageId ?? seq,
          from_user_id: pushOpts.userId ?? 'u-e2e',
          create_time_ms: Date.now(),
          message_type: 1,
          context_token: pushOpts.contextToken ?? 'ctx-e2e',
          item_list: [{ type: 1, text_item: { text } }],
        },
      });
      releasePending();
    },

    injectSendError(errcode, times = 1) {
      injectErrcode = errcode;
      injectRemaining = times;
    },

    waitForReply(pred, timeoutMs = DEFAULT_WAIT_REPLY_MS) {
      const hit = sent.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<SentMessage>((resolve, reject) => {
        const waiter: ReplyWaiter = {
          pred,
          resolve,
          reject,
          timer: setTimeout(() => {
            replyWaiters.delete(waiter);
            reject(
              new Error(
                `waitForReply timed out after ${timeoutMs}ms. ` +
                  `Replies so far (${sent.length}):\n` +
                  (sent.length === 0
                    ? '  <none>'
                    : sent.map((m, i) => `  [${i}] -> ${m.toUser}: ${JSON.stringify(m.text)}`).join('\n')),
              ),
            );
          }, timeoutMs),
        };
        replyWaiters.add(waiter);
      });
    },

    async close() {
      closed = true;
      // 先把挂起中的长轮询全部结掉,否则 server.close() 会一直等
      for (const p of [...pending]) {
        pending.delete(p);
        clearTimeout(p.timer);
        try {
          respondUpdates(p.res, p.rawBuf);
        } catch {
          /* 连接可能已经断了 */
        }
      }
      for (const w of [...replyWaiters]) {
        replyWaiters.delete(w);
        clearTimeout(w.timer);
        w.reject(new Error('fake iLink closed while waiting for a reply'));
      }
      await new Promise<void>((resolve) => {
        // undici 的 keep-alive 连接不主动断,close() 会挂住
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };

  return fake;
}
