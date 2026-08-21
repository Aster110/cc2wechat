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
import { createAttachmentSender, type AttachmentSenderConfig } from './attachment-sender.js';
import { isWakuApiError, type WakuChatClient } from './chat-client.js';
import type { BridgeTokenProvider } from './credential-provider.js';
import type { MediaStore } from './media-store.js';
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
export const DM_UNSUPPORTED_KIND_TEXT = '这类消息我还看不了，发文字 / 图片 / 视频 / 语音 / playable 卡片给我吧 🙏';

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
  /** 入站媒体落盘。不给 = 不下载（只留无路径标记），单测里可以省掉它。 */
  media?: MediaStore;
  /** 出站附件上传与探测。不给 = 附件退化成一行文字说明。 */
  attachments?: AttachmentSenderConfig;
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

/** `chat.message` 帧里 `image` 字段的形状（waku-core `chat_service._resolve_image`）。 */
export interface WireImage {
  assetId: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
}

/** `payload` 字段（kind=video）。 */
export interface WireVideo {
  assetId: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  posterUrl: string | null;
}

/** `payload` 字段（kind=voice）。 */
export interface WireVoice {
  assetId: string | null;
  url: string | null;
  durationMs: number | null;
}

/** `card` 字段（kind=playable_card）。 */
export interface WireCard {
  contentId: string | null;
  title: string | null;
  coverUrl: string | null;
  authorName: string | null;
  projectId: string | null;
  shareUrl: string | null;
}

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
  /** kind=image 时非空。 */
  image: WireImage | null;
  /** kind=video 时非空。 */
  video: WireVideo | null;
  /** kind=voice 时非空。 */
  voice: WireVoice | null;
  /** kind=playable_card 时非空。 */
  card: WireCard | null;
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
  const image = kind === 'image' ? parseWireImage(record['image']) : null;
  const payload = kind === 'video' || kind === 'voice' ? asWireRecord(record['payload']) : null;
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
    image,
    video: kind === 'video' && payload !== null ? parseWireVideo(payload) : null,
    voice: kind === 'voice' && payload !== null ? parseWireVoice(payload) : null,
    card: kind === 'playable_card' ? parseWireCard(record['card']) : null,
  };
}

function asWireRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function wireString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function wireNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseWireImage(value: unknown): WireImage | null {
  const record = asWireRecord(value);
  if (record === null) return null;
  return {
    assetId: wireString(record, 'asset_id'),
    url: wireString(record, 'url'),
    width: wireNumber(record, 'width'),
    height: wireNumber(record, 'height'),
  };
}

export function parseWireVideo(record: Record<string, unknown>): WireVideo {
  return {
    assetId: wireString(record, 'asset_id'),
    url: wireString(record, 'url'),
    width: wireNumber(record, 'width'),
    height: wireNumber(record, 'height'),
    durationMs: wireNumber(record, 'duration_ms'),
    posterUrl: wireString(record, 'poster_url'),
  };
}

export function parseWireVoice(record: Record<string, unknown>): WireVoice {
  return {
    assetId: wireString(record, 'asset_id'),
    url: wireString(record, 'url'),
    durationMs: wireNumber(record, 'duration_ms'),
  };
}

export function parseWireCard(value: unknown): WireCard | null {
  const record = asWireRecord(value);
  if (record === null) return null;
  return {
    contentId: wireString(record, 'content_id'),
    title: wireString(record, 'title'),
    coverUrl: wireString(record, 'cover_url'),
    authorName: wireString(record, 'author_name'),
    projectId: wireString(record, 'project_id'),
    shareUrl: wireString(record, 'share_url'),
  };
}

/**
 * 卡片转成一行文本标记（不下载任何东西）。词汇与 `[Image: …]` 同源，Agent 认得出。
 * 只有 content_id 是必需的：标题/链接缺了就少一段，不影响 Agent 判断「用户分享了一个 playable」。
 */
export function cardMarker(card: WireCard): string {
  const parts: string[] = [];
  if (card.title !== null) parts.push(card.title);
  if (card.contentId !== null) parts.push(`content_id=${card.contentId}`);
  if (card.authorName !== null) parts.push(`author=${card.authorName}`);
  if (card.shareUrl !== null) parts.push(`share_url=${card.shareUrl}`);
  return `[Card: ${parts.join(' ')}]`;
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

/** 附件的幂等 id：`<messageId>:att<i>`，与文本分片的 `<messageId>:<i>` 不会撞。 */
export function attachmentClientMsgId(messageId: string, index: number): string {
  const raw = `${messageId}:att${index}`;
  if (raw.length <= CLIENT_MSG_ID_MAX) return raw;
  const digest = createHash('sha256').update(messageId).digest('hex').slice(0, 32);
  return `h_${digest}:att${index}`;
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
  const attachmentSender =
    options.attachments === undefined ? null : createAttachmentSender(chat, options.attachments, log);

  const descriptor: ChannelDescriptor = {
    type: 'waku-dm',
    instanceId: options.instanceId,
    protocolVersion: CHANNEL_PROTOCOL_VERSION,
    capabilities: {
      progress: false,
      presence: true,
      // 附件能力取决于有没有接上传/探测那套零件；没接上就别对外声称能发。
      attachments: options.attachments !== undefined,
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

    const composed = await composeInbound(message);
    if (composed === null) {
      // 这类消息我们连"标记"都造不出来（sticker / 未知 kind）：回一句限频提示就算处理过了。
      const last = noticeAt.get(message.conversationId) ?? 0;
      if (now() - last >= noticeMs) {
        noticeAt.set(message.conversationId, now());
        void sendNotice(message.conversationId, `notice:${message.id}`, DM_UNSUPPORTED_KIND_TEXT);
      }
      advanceCursor(frame, message.id);
      return;
    }

    const { text, mediaPaths } = composed;
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
      mediaPaths,
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

  /**
   * 一条线上消息 → 交给 Core 的正文与本机媒体路径。
   *
   * 三条：①正文（caption）永远在前，媒体标记跟在后面；②下载失败降级成无路径标记（`[Image]`）
   * 而不是丢整条消息；③卡片不下载任何东西，只转成一行文本标记——它本来就没有二进制。
   * 返回 null = 这个 kind 我们不认（sticker / 未知），交给调用方回提示。
   */
  async function composeInbound(message: WireChatMessage): Promise<{ text: string; mediaPaths: string[] } | null> {
    const caption = (message.body ?? '').trim();
    const parts: string[] = [];
    const mediaPaths: string[] = [];
    if (caption.length > 0) parts.push(caption);

    async function fetchMedia(kind: 'image' | 'video' | 'voice', url: string | null, label: string): Promise<void> {
      const path =
        url === null || options.media === undefined
          ? null
          : await options.media.download({
              conversationId: message.conversationId,
              messageId: message.id,
              index: 0,
              url,
              kind,
            });
      if (path === null) {
        parts.push(`[${label}]`);
        return;
      }
      parts.push(`[${label}: ${path}]`);
      mediaPaths.push(path);
    }

    switch (message.kind) {
      case 'text':
        break;
      case 'image':
        await fetchMedia('image', message.image?.url ?? null, 'Image');
        break;
      case 'video':
        await fetchMedia('video', message.video?.url ?? null, 'Video');
        break;
      case 'voice':
        await fetchMedia('voice', message.voice?.url ?? null, 'Voice');
        break;
      case 'playable_card': {
        if (message.card === null) return null;
        parts.push(cardMarker(message.card));
        break;
      }
      default:
        return null;
    }

    return { text: parts.join('\n'), mediaPaths };
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

    const conversationId = envelope.routeId;
    const context = `conv=${conversationId.slice(0, 12)} msg=${envelope.messageId.slice(0, 8)}`;
    let firstId: string | undefined;

    // 附件先走：用户先看到图/视频/卡片，再看到围绕它的那段话，读起来才顺。
    const attachments = payload.type === 'final' && payload.attachments !== undefined ? payload.attachments : [];
    const notices: string[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachmentSender === null) {
        notices.push(`（附件没发出去：这台 daemon 没启用附件通道）${attachment.path ?? attachment.contentId ?? ''}`);
        continue;
      }
      const outcome = await attachmentSender.send({
        conversationId,
        // 重投用同一个 id：服务端 UNIQUE(sender, client_msg_id) ⇒ 屏幕上不会出现第二张图。
        clientMsgId: attachmentClientMsgId(envelope.messageId, index),
        attachment,
      });
      if (outcome.status === 'sent') {
        if (firstId === undefined && outcome.messageId.length > 0) firstId = outcome.messageId;
        continue;
      }
      if (outcome.status === 'skipped') {
        notices.push(outcome.notice);
        continue;
      }
      log.error(`send failed ${context} attachment=${index + 1}/${attachments.length} (${attachment.kind}): ${outcome.code}`);
      if (outcome.kind === 'unknown') return { status: 'unknown', code: outcome.code };
      if (outcome.kind === 'permanent-failure') return { status: 'permanent-failure', code: outcome.code };
      return outcome.retryAfterMs === undefined
        ? { status: 'retryable', code: outcome.code }
        : { status: 'retryable', code: outcome.code, retryAfterMs: outcome.retryAfterMs };
    }

    const body = notices.length === 0 ? text : [text, ...notices].filter((part) => part.trim().length > 0).join('\n');
    const chunks = splitText(stripMarkdown(body), WAKU_DM_CHUNK_CHARS).filter((chunk) => chunk.trim().length > 0);
    if (chunks.length === 0) {
      if (payload.type === 'final') void markReadQuietly(conversationId);
      return firstId === undefined ? { status: 'sent' } : { status: 'sent', externalDeliveryId: firstId };
    }

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
