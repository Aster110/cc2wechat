/**
 * waku-dm 通道适配器（契约 §3.3 入站、§3.4 出站、§3.5 心跳与健康）。
 *
 * 本地 daemon 以马甲身份订阅马甲自己的 per-user 总线，把用户私信交给 Core，把 Core 的回复
 * 以马甲为 sender 发回同一条私聊。桥上没有新传输机制：入站 = SSE，出站 = REST，鉴权 = 平台 JWT。
 *
 * 与 V1 mailbox 适配器相比少掉的东西是刻意的：没有密码学（TLS + 平台鉴权已够）、没有分片重组
 * （平台消息本来就是整条）、没有轮询（总线是推的）。留下来的纪律一条不少：
 *
 * 1. **游标只在 sink 回了 ack（accepted / duplicate / rejected）之后才推进**；sink 抛错 = 这帧没消费，
 *    断开重连从游标重投。去重的事实源是 Core 的 `inbox_receipts`，不是游标。
 * 2. **首次启动无游标时不回放历史**：连接时不带 Last-Event-ID，`created_at` 早于「启动 − 60s」的
 *    chat.message 丢弃（否则冷启动会把整段历史灌给 Codex），但游标照记。
 * 3. **出站幂等靠 `client_msg_id`**：单片 = Core 的 messageId，多片 = `<messageId>:<index>`；
 *    服务端 `UNIQUE(sender, client_msg_id)`，重投不产生第二条。写请求的网络失败是 `unknown`，不是 `retryable`。
 * 4. **凭证与 JWT 不进日志 / health / 错误文案**；入站日志只记 `<sender8>: <text50>`。
 *
 * 慢回执（「收到，正在处理…」）与「暂时只支持文字」这类**一次性提示**直发 REST，不走 outbox：
 * 它们丢了没有代价，重投反而会在用户屏幕上堆出一排重复提示。
 */
import { createHash } from 'node:crypto';

import {
  CHANNEL_PROTOCOL_VERSION,
  type ChannelDescriptor,
  type DeliveryReceipt,
  type IngressAck,
} from '../../contracts/channel.js';
import type { OutboundEnvelope } from '../../core/delivery.js';
import type { DmInboundEnvelope, InboundEnvelope } from '../../core/ingress.js';
import type { GatewayLogger } from '../../log.js';
import type { GatewayStore } from '../../state/sqlite-store.js';
import { splitText, stripMarkdown } from '../../../v5/sender/replier.js';
import { isWakuApiError, type WakuChatClient } from './chat-client.js';
import type { BridgeTokenProvider } from './credential-provider.js';
import { createSseSubscription, type SseFrame, type SseSubscription } from './sse-client.js';

// ---------------------------------------------------------------------------
// 冻结常量
// ---------------------------------------------------------------------------

/** 游标落在 V1 的 `mailbox_cursors` 表里：`last_created_at` 列存 user_seq，`last_message_id` 存帧里的消息 id。 */
export const WAKU_DM_CURSOR_COLLECTION = 'waku_dm_user_events';
/** 按**字符**切（平台 body ≤ 4000 字符），留余量。 */
export const WAKU_DM_CHUNK_CHARS = 3900;
export const WAKU_DM_HEARTBEAT_INTERVAL_MS = 30_000;
export const WAKU_DM_SLOW_ACK_MS = 60_000;
export const WAKU_DM_COLD_START_GRACE_MS = 60_000;
export const WAKU_DM_UNSUPPORTED_KIND_NOTICE_MS = 60_000;
const CLIENT_MSG_ID_MAX = 128;
const SHUTDOWN_HEARTBEAT_TIMEOUT_MS = 2_000;

export const DM_SLOW_ACK_TEXT = '收到，正在处理…';
export const DM_UNSUPPORTED_KIND_TEXT = '暂时只支持文字消息，发文字给我吧 🙏';

// ---------------------------------------------------------------------------
// 注入接缝
// ---------------------------------------------------------------------------

export interface TimerSeam {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type DmInboundSink = (envelope: InboundEnvelope) => Promise<IngressAck>;

export interface WakuDmHeartbeatConfig {
  /** session 模式（真账号）没有 bridge 身份，心跳端点会 403：关掉。 */
  enabled: boolean;
  intervalMs: number;
  agentName: string;
  queues(): { running: number; queued: number };
}

export interface WakuDmAdapterOptions {
  instanceId: string;
  apiBase: string;
  tokens: BridgeTokenProvider;
  chat: WakuChatClient;
  store: Pick<GatewayStore, 'getCursor' | 'transaction'>;
  now: () => number;
  log: GatewayLogger;
  fetchImpl?: typeof fetch;
  timer?: TimerSeam;
  heartbeat: WakuDmHeartbeatConfig;
  sse?: { idleTimeoutMs?: number; backoff?: { baseMs: number; maxMs: number }; reconnectDelayMs?: number };
  /** 0 = 关闭慢回执。 */
  slowAckMs?: number;
  coldStartGraceMs?: number;
  unsupportedKindNoticeMs?: number;
}

export type WakuDmState = 'idle' | 'running' | 'degraded' | 'disabled' | 'stopped';

export interface WakuDmHealth {
  ok: boolean;
  state: WakuDmState;
  cursor: number | null;
  lastEventAt: number | null;
  lastHeartbeatAt: number | null;
  reconnects: number;
  tokenState: string;
  selfUserId: string | null;
  sseState: string;
}

export interface WakuDmAdapter {
  readonly descriptor: ChannelDescriptor;
  start(sink: DmInboundSink): Promise<void>;
  /** 只停入站（SSE + 心跳），出站继续可用：排水期间 Core 还要把最后的 final 发出去。 */
  stopIntake(): Promise<void>;
  send(envelope: OutboundEnvelope): Promise<DeliveryReceipt>;
  health(): Promise<WakuDmHealth>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 线上消息解析（这是 adapter 唯一碰 chat.message DTO 的地方）
// ---------------------------------------------------------------------------

export interface WireChatMessage {
  id: string;
  conversationId: string;
  conversationKind: string | null;
  convSeq: number | null;
  senderUserId: string;
  kind: string;
  body: string | null;
  createdAt: number | null;
  recalled: boolean;
  source: string | null;
}

/**
 * 平台 `json.dumps(..., default=str)` 会把 datetime 变成 `YYYY-MM-DD HH:MM:SS.ffffff+00:00`，
 * 不是 ISO 8601 的 `T` 形式；V8 的 Date.parse 对它不稳定，这里归一后再解析。数字按 epoch 秒/毫秒自适应。
 */
export function parseWireTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== 'string' || value.length === 0) return null;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (match === null) return null;
  const fraction = match[3] === undefined ? '' : `.${match[3].slice(0, 3).padEnd(3, '0')}`;
  const zone = match[4] === undefined ? 'Z' : match[4] === 'Z' ? 'Z' : match[4].includes(':') ? match[4] : `${match[4].slice(0, 3)}:${match[4].slice(3)}`;
  const normalized = Date.parse(`${match[1]}T${match[2]}${fraction}${zone}`);
  return Number.isNaN(normalized) ? null : normalized;
}

export function parseChatMessage(data: string): WireChatMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const str = (key: string): string | null => (typeof record[key] === 'string' && (record[key] as string).length > 0 ? (record[key] as string) : null);

  const id = str('id');
  const conversationId = str('conversation_id');
  const senderUserId = str('sender_user_id');
  const kind = str('kind');
  if (id === null || conversationId === null || senderUserId === null || kind === null) return null;

  const convSeq = record['conv_seq'];
  return {
    id,
    conversationId,
    conversationKind: str('conversation_kind'),
    convSeq: typeof convSeq === 'number' && Number.isFinite(convSeq) ? convSeq : null,
    senderUserId,
    kind,
    body: typeof record['body'] === 'string' ? (record['body'] as string) : null,
    createdAt: parseWireTimestamp(record['created_at']),
    recalled: record['recalled_at'] !== null && record['recalled_at'] !== undefined,
    source: str('source'),
  };
}

// ---------------------------------------------------------------------------
// 出站文案
// ---------------------------------------------------------------------------

/** Core 的 error payload → 用户能看懂的一句话（容量/生命周期类要有回音，架构 §10）。 */
function errorText(payload: Extract<OutboundEnvelope['payload'], { type: 'error' }>): string {
  switch (payload.code) {
    case 'queue_full':
      return '⏳ 前面还有消息在排队，这条先不处理了，稍后再发';
    case 'draining':
      return '⏸ 我正在重启，这条没处理到，请稍后再发一次';
    case 'endpoint_disabled':
      return '⛔ 这个入口暂时被关闭了';
    case 'agent_no_result':
      return '⚠️ 这轮没有任何输出';
    default:
      return `⚠️ ${payload.message !== undefined && payload.message.length > 0 ? payload.message : payload.code}`;
  }
}

function clientMsgIdFor(messageId: string, index: number, total: number): string {
  const raw = total === 1 ? messageId : `${messageId}:${index}`;
  if (raw.length <= CLIENT_MSG_ID_MAX) return raw;
  // messageId 是 Core 铸的 UUIDv7，正常到不了这里；兜底用稳定摘要，仍然幂等。
  const digest = createHash('sha256').update(messageId).digest('hex').slice(0, 32);
  return total === 1 ? `h_${digest}` : `h_${digest}:${index}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const realTimer: TimerSeam = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export function createWakuDmAdapter(options: WakuDmAdapterOptions): WakuDmAdapter {
  const { tokens, chat, store, now, log } = options;
  const timer = options.timer ?? realTimer;
  const slowAckMs = options.slowAckMs ?? WAKU_DM_SLOW_ACK_MS;
  const coldStartGraceMs = options.coldStartGraceMs ?? WAKU_DM_COLD_START_GRACE_MS;
  const noticeMs = options.unsupportedKindNoticeMs ?? WAKU_DM_UNSUPPORTED_KIND_NOTICE_MS;
  const apiBase = options.apiBase.replace(/\/+$/, '');

  const descriptor: ChannelDescriptor = {
    type: 'waku-dm',
    instanceId: options.instanceId,
    protocolVersion: CHANNEL_PROTOCOL_VERSION,
    capabilities: {
      progress: false,
      presence: true,
      attachments: false,
      maxMessageBytes: 4000 * 4,
    },
  };

  let lifecycle: 'idle' | 'running' | 'stopped' = 'idle';
  let intakeStopped = false;
  let disabled = false;
  let sink: DmInboundSink | null = null;
  let selfUserId: string | null = null;
  let cursor: number | null = null;
  let hadCursorAtStart = false;
  let startedAt = 0;
  let lastEventAt: number | null = null;
  let lastHeartbeatAt: number | null = null;
  let subscription: SseSubscription | null = null;
  let heartbeatHandle: unknown = null;
  let heartbeatInflight: Promise<void> | null = null;
  /** 首拍等 SSE 真的打开再发：否则第一拍永远报 degraded（连接还在建）。 */
  let firstBeatDone = false;

  /** 每会话最后一条入站的 conv_seq：final 发出后用它 POST read。 */
  const lastInboundSeq = new Map<string, number>();
  /** 慢回执计时：inbound messageId → 计时器。 */
  const slowAcks = new Map<string, { handle: unknown; conversationId: string }>();
  /** 「暂时只支持文字」每会话限频。 */
  const noticeAt = new Map<string, number>();

  // ── 游标 ────────────────────────────────────────────────────────

  function loadCursor(): number | null {
    const row = store.getCursor(WAKU_DM_CURSOR_COLLECTION);
    return row === null ? null : row.lastCreatedAt;
  }

  function advanceCursor(frame: SseFrame, messageId: string | null): void {
    if (frame.id === null) return;
    const seq = Number.parseInt(frame.id, 10);
    if (!Number.isFinite(seq)) return;
    if (cursor !== null && seq <= cursor) return;
    // 先落盘再更新内存：落盘失败时内存不许领先磁盘（否则重启后凭空跳过消息）。
    store.transaction((tx) =>
      tx.commitCursor(WAKU_DM_CURSOR_COLLECTION, { lastCreatedAt: seq, lastMessageId: messageId ?? frame.id ?? String(seq) }),
    );
    cursor = seq;
  }

  // ── 一次性提示（直发，不走 outbox） ───────────────────────────────

  async function sendNotice(conversationId: string, clientMsgId: string, body: string): Promise<void> {
    try {
      await chat.sendMessage(conversationId, { clientMsgId: clientMsgId.slice(0, CLIENT_MSG_ID_MAX), body });
    } catch (error) {
      log.error(`notice send failed conv=${conversationId.slice(0, 12)}: ${describeError(error)}`);
    }
  }

  function armSlowAck(messageId: string, conversationId: string): void {
    if (slowAckMs <= 0 || slowAcks.has(messageId)) return;
    const handle = timer.setTimeout(() => {
      slowAcks.delete(messageId);
      if (lifecycle !== 'running') return;
      void sendNotice(conversationId, `ack:${messageId}`, DM_SLOW_ACK_TEXT);
    }, slowAckMs);
    slowAcks.set(messageId, { handle, conversationId });
  }

  function cancelSlowAck(messageId: string | undefined): void {
    if (messageId === undefined) return;
    const pending = slowAcks.get(messageId);
    if (pending === undefined) return;
    timer.clearTimeout(pending.handle);
    slowAcks.delete(messageId);
  }

  function clearSlowAcks(): void {
    for (const pending of slowAcks.values()) timer.clearTimeout(pending.handle);
    slowAcks.clear();
  }

  // ── 入站 ────────────────────────────────────────────────────────

  async function handleFrame(frame: SseFrame): Promise<void> {
    lastEventAt = now();
    if (frame.event !== 'chat.message') {
      advanceCursor(frame, null);
      return;
    }

    const message = parseChatMessage(frame.data);
    if (message === null) {
      log.error(`malformed chat.message frame (seq=${frame.id ?? '-'}): could not parse payload; skipping`);
      advanceCursor(frame, null);
      return;
    }

    const drop = dropReason(message);
    if (drop !== null) {
      advanceCursor(frame, message.id);
      return;
    }

    if (message.kind !== 'text') {
      const last = noticeAt.get(message.conversationId) ?? 0;
      if (now() - last >= noticeMs) {
        noticeAt.set(message.conversationId, now());
        void sendNotice(message.conversationId, `notice:${message.id}`, DM_UNSUPPORTED_KIND_TEXT);
      }
      advanceCursor(frame, message.id);
      return;
    }

    const text = message.body ?? '';
    if (text.trim().length === 0) {
      advanceCursor(frame, message.id);
      return;
    }

    const envelope: DmInboundEnvelope = {
      channel: 'waku-dm',
      routeId: message.conversationId,
      messageId: message.id,
      principalRef: message.senderUserId,
      text,
      createdAt: message.createdAt ?? now(),
      receivedAt: now(),
    };

    log.info(`<- ${message.senderUserId.slice(0, 8)}: ${oneLine(text).slice(0, 50)}`);

    // sink 抛错就让它往上冒：sse-client 会断开重连、从游标重投这一帧。
    const ack = await sink!(envelope);

    if (message.convSeq !== null) lastInboundSeq.set(message.conversationId, message.convSeq);
    if (ack.status === 'accepted') {
      armSlowAck(message.id, message.conversationId);
    } else if (ack.status === 'rejected') {
      log.info(`   dropped ${message.id.slice(0, 16)} from ${message.senderUserId.slice(0, 8)}: ${ack.code}`);
    }
    advanceCursor(frame, message.id);
  }

  function dropReason(message: WireChatMessage): string | null {
    if (selfUserId !== null && message.senderUserId === selfUserId) return 'self';
    if (message.conversationKind !== 'dm') return message.conversationKind === null ? 'no_kind' : 'not_dm';
    if (message.recalled) return 'recalled';
    if (message.source === 'agent_bridge') return 'bot';
    if (!hadCursorAtStart && message.createdAt !== null && message.createdAt < startedAt - coldStartGraceMs) return 'stale';
    return null;
  }

  // ── 心跳 ────────────────────────────────────────────────────────

  function agentState(): 'online' | 'busy' | 'degraded' {
    const queues = options.heartbeat.queues();
    if (queues.running > 0) return 'busy';
    const token = tokens.health();
    const sse = subscription?.stats().state ?? 'idle';
    return token.ok && sse === 'open' ? 'online' : 'degraded';
  }

  async function beat(): Promise<void> {
    if (lifecycle !== 'running' || intakeStopped || disabled) return;
    firstBeatDone = true;
    const queues = options.heartbeat.queues();
    try {
      const result = await chat.heartbeat({
        agentState: agentState(),
        queued: queues.queued,
        running: queues.running,
        capabilities: { channel: 'waku-dm', agent: options.heartbeat.agentName },
      });
      lastHeartbeatAt = now();
      if (result.bridgeStatus === 'disabled') {
        await onDisabled();
      }
    } catch (error) {
      log.error(`heartbeat failed: ${describeError(error)}`);
    }
  }

  function scheduleHeartbeat(delayMs: number): void {
    if (!options.heartbeat.enabled || lifecycle !== 'running' || intakeStopped || disabled) return;
    heartbeatHandle = timer.setTimeout(() => {
      heartbeatHandle = null;
      heartbeatInflight = beat().finally(() => {
        heartbeatInflight = null;
        scheduleHeartbeat(options.heartbeat.intervalMs);
      });
    }, delayMs);
  }

  function clearHeartbeat(): void {
    if (heartbeatHandle !== null) {
      timer.clearTimeout(heartbeatHandle);
      heartbeatHandle = null;
    }
  }

  async function onDisabled(): Promise<void> {
    if (disabled) return;
    disabled = true;
    log.error('bridge disabled by the platform (heartbeat says status=disabled): stopping consumption; re-enable it with waku agent-friend set --status active');
    clearHeartbeat();
    await subscription?.stop();
  }

  // ── 出站 ────────────────────────────────────────────────────────

  function receiptFor(error: unknown, context: string): DeliveryReceipt {
    if (!isWakuApiError(error)) {
      log.error(`send failed ${context}: ${describeError(error)}`);
      return { status: 'unknown', code: 'send_failed' };
    }
    log.error(`send failed ${context}: ${error.code}${error.status === null ? '' : ` (HTTP ${error.status})`}`);
    if (error.kind === 'network') return { status: 'unknown', code: error.code };
    if (error.kind === 'auth') return { status: 'retryable', code: error.code };
    const status = error.status ?? 0;
    if (status === 429) {
      return error.retryAfterMs === null
        ? { status: 'retryable', code: error.code }
        : { status: 'retryable', code: error.code, retryAfterMs: error.retryAfterMs };
    }
    if (status === 408 || status === 425 || status >= 500) return { status: 'retryable', code: error.code };
    return { status: 'permanent-failure', code: error.code };
  }

  async function markReadQuietly(conversationId: string): Promise<void> {
    const seq = lastInboundSeq.get(conversationId);
    if (seq === undefined) return;
    try {
      await chat.markRead(conversationId, seq);
    } catch {
      /* 已读回执是锦上添花，失败不值得一条日志 */
    }
  }

  async function send(envelope: OutboundEnvelope): Promise<DeliveryReceipt> {
    if (lifecycle === 'stopped') {
      return { status: 'permanent-failure', code: 'waku_dm_stopped' };
    }
    const payload = envelope.payload;
    let text: string;
    if (payload.type === 'final') {
      text = payload.text;
    } else if (payload.type === 'error') {
      text = errorText(payload);
    } else {
      // progress / ack / status 是给 Playable 渲染的；私聊里没有对应物，确认即可。
      return { status: 'sent' };
    }
    if ('replyTo' in payload) cancelSlowAck(payload.replyTo);

    const chunks = splitText(stripMarkdown(text), WAKU_DM_CHUNK_CHARS).filter((chunk) => chunk.trim().length > 0);
    if (chunks.length === 0) return { status: 'sent' };

    const conversationId = envelope.routeId;
    const context = `conv=${conversationId.slice(0, 12)} msg=${envelope.messageId.slice(0, 8)}`;
    let firstId: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      try {
        const result = await chat.sendMessage(conversationId, {
          clientMsgId: clientMsgIdFor(envelope.messageId, index, chunks.length),
          body: chunks[index],
        });
        if (firstId === undefined && result.messageId.length > 0) firstId = result.messageId;
      } catch (error) {
        return receiptFor(error, `${context} chunk=${index + 1}/${chunks.length}`);
      }
    }

    if (payload.type === 'final') void markReadQuietly(conversationId);
    return firstId === undefined ? { status: 'sent' } : { status: 'sent', externalDeliveryId: firstId };
  }

  // ── 对外 API ────────────────────────────────────────────────────

  return {
    descriptor,

    async start(nextSink: DmInboundSink): Promise<void> {
      if (lifecycle === 'running') throw new Error('waku-dm adapter is already started');
      if (lifecycle === 'stopped') throw new Error('waku-dm adapter has been stopped');
      sink = nextSink;
      startedAt = now();
      cursor = loadCursor();
      hadCursorAtStart = cursor !== null;
      // 自回显过滤需要知道"我是谁"；凭证坏了在这里就炸出来，不留一个每轮 401 的僵尸。
      selfUserId = (await tokens.identity()).userId;
      lifecycle = 'running';

      subscription = createSseSubscription({
        url: `${apiBase}/users/me/events`,
        headers: async () => ({ Authorization: `Bearer ${await tokens.current()}` }),
        lastEventId: () => (cursor === null ? null : String(cursor)),
        onFrame: handleFrame,
        onAuthRejected: () => tokens.invalidate(),
        onStateChange: (state) => {
          if (state === 'open' && !firstBeatDone && heartbeatInflight === null) {
            // 连接一打开就拍第一拍（在此之前 online 是假的）
            clearHeartbeat();
            scheduleHeartbeat(0);
          }
        },
        log,
        label: 'sse',
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        now,
        ...(options.sse?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.sse.idleTimeoutMs }),
        ...(options.sse?.backoff === undefined ? {} : { backoff: options.sse.backoff }),
        ...(options.sse?.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: options.sse.reconnectDelayMs }),
      });
      subscription.start();
      // 兜底：SSE 一直打不开也要按周期报 degraded，让平台知道我们还活着但不健康。
      scheduleHeartbeat(options.heartbeat.intervalMs);
    },

    async stopIntake(): Promise<void> {
      if (intakeStopped) return;
      intakeStopped = true;
      clearHeartbeat();
      clearSlowAcks();
      await subscription?.stop();
      await heartbeatInflight;
    },

    send,

    async health(): Promise<WakuDmHealth> {
      const token = tokens.health();
      const sse = subscription?.stats();
      let state: WakuDmState;
      if (lifecycle === 'stopped') state = 'stopped';
      else if (disabled) state = 'disabled';
      else if (lifecycle === 'idle') state = 'idle';
      else if (intakeStopped) state = 'degraded';
      else state = token.ok && sse?.state === 'open' ? 'running' : 'degraded';
      return {
        ok: state === 'running',
        state,
        cursor,
        lastEventAt,
        lastHeartbeatAt,
        reconnects: sse?.reconnects ?? 0,
        tokenState: token.state,
        selfUserId,
        sseState: sse?.state ?? 'idle',
      };
    },

    async stop(): Promise<void> {
      if (lifecycle === 'stopped') return;
      const wasRunning = lifecycle === 'running';
      await this.stopIntake();
      lifecycle = 'stopped';
      if (wasRunning && options.heartbeat.enabled && !disabled) {
        // 下线心跳是礼貌，不是义务：限时 2s，失败不阻塞退出。
        const queues = options.heartbeat.queues();
        await Promise.race([
          chat
            .heartbeat({ agentState: 'offline', queued: queues.queued, running: queues.running, capabilities: { channel: 'waku-dm', agent: options.heartbeat.agentName } })
            .catch(() => undefined),
          new Promise<void>((resolve) => {
            const handle = setTimeout(resolve, SHUTDOWN_HEARTBEAT_TIMEOUT_MS);
            if (typeof handle.unref === 'function') handle.unref();
          }),
        ]);
      }
      sink = null;
    },
  };
}

function describeError(error: unknown): string {
  if (isWakuApiError(error)) return `${error.code}${error.status === null ? '' : ` (HTTP ${error.status})`}`;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' ? code : error.message;
  }
  return String(error);
}
