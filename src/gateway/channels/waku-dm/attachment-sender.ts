/**
 * 出站附件发送（waku-dm 通道私有）：一条 `OutboundAttachment` → 平台上的一条真消息。
 *
 * 分成三段，每段都有自己的失败语义，混起来就没法判该不该重投：
 *
 *   探测（本机） → 上传（asset） → 发送（chat message）
 *
 * 1. **探测失败 ≠ 发送失败**。语音缺 `duration_ms` 会被平台 422 拒——与其发一条注定失败的请求、
 *    再让 outbox 重投八次，不如当场退化成一句人话（`skipped`），用户至少知道发生了什么。
 * 2. **上传成功要缓存**。上传成功、发送失败的重投是最常见的一种：没有缓存的话，
 *    一个 80 MB 的视频会被重新传一遍。缓存 key = 路径 + 大小 + mtime。
 * 3. **发送失败原样交回**。429 / 5xx → retryable，403/404/415 → permanent-failure，
 *    网络断 → unknown（可能已落库）。判定复用通道已有的那张表，这里不自造第二套。
 *
 * `client_msg_id` 由调用方给（`<messageId>:att<i>`），服务端 `UNIQUE(sender, client_msg_id)`
 * 保证重投不会在用户屏幕上留下第二张图。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { OutboundAttachment } from '../../core/attachments.js';
import { describeInternalError, type GatewayLogger } from '../../log.js';
import { isWakuApiError, type WakuChatClient } from './chat-client.js';
import { mimeForPath, type MediaProbe } from './media-probe.js';

/** 上传缓存：key → asset id。实现在 sqlite-store（`asset_uploads` 表）。 */
export interface AssetUploadCache {
  get(cacheKey: string): string | null;
  set(cacheKey: string, assetId: string): void;
}

export interface AttachmentSenderConfig {
  probe: MediaProbe;
  cache?: AssetUploadCache;
  /** 封面 / 转码产物的落脚点。 */
  tmpDir: string;
  /** `WAKU_DM_VIDEO_TRANSCODE=1` 才打开：转到 720p H.264 且截断到 maxVideoSeconds。 */
  transcodeVideo?: boolean;
  maxVideoSeconds?: number;
  /** 出站单文件上限，缺省 200 MiB。 */
  maxUploadBytes?: number;
}

export type AttachmentOutcome =
  /** 已经在平台上落了一条消息。 */
  | { status: 'sent'; messageId: string }
  /** 发不出去，但这不是"待重试"——回一句人话，然后翻篇。 */
  | { status: 'skipped'; notice: string }
  /** 交给 outbox：`retryable` 会重投，`permanent-failure` 不会。 */
  | {
      status: 'failed';
      kind: 'retryable' | 'permanent-failure' | 'unknown';
      code: string;
      retryAfterMs?: number;
      /** 本机内部错误的原始描述（已截断）。平台侧失败没有它 —— code 就说明了一切。 */
      detail?: string;
    };

export const DEFAULT_MAX_VIDEO_SECONDS = 60;
/**
 * 出站单文件上限。上传要把整个文件读进内存（multipart），没有这道闸的话
 * Agent 一句 `[[send-video: /path/to/4GB.mov]]` 就能把 daemon 撑爆——
 * 而平台那边本来也会拒。宁可当场回一句人话。
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 上传缓存的寿命：比出站 outbox 的 TTL 长一截就够，不必永久。 */
export const ASSET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function assetCacheKey(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${path.resolve(filePath)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** 回执 code 里的标签最长这么长：它会进日志和 outbox 记录，不该被一个畸形 code 撑爆。 */
const FAILURE_TAG_MAX = 48;

/**
 * 本机内部错误 → 回执 code。
 *
 * 标签优先用 `error.code`（sqlite 给的是 `ERR_SQLITE_ERROR`），没有才退回 `error.name`——
 * Node 里几乎所有东西的 name 都是 `Error`，只看 name 分不出任何东西。
 * 只保留安全字符：这个 code 会被原样写进日志和 outbox。
 */
export function internalFailureCode(error: unknown): string {
  let raw: string;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    raw = typeof code === 'string' && code.length > 0 ? code : error.name;
  } else {
    raw = typeof error;
  }
  const safe = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, FAILURE_TAG_MAX);
  return `attachment_internal:${safe.length === 0 ? 'unknown' : safe}`;
}

/** 内容不可分享（private / 已下线 / 不存在）——这是**内容状态**问题，重投一万次也一样。 */
export const CARD_NOT_SHAREABLE_TEXT =
  '内容不可分享（私有或不存在），请用 --visibility public 重新发布后再分享 🙏';

export interface AttachmentSender {
  send(input: {
    conversationId: string;
    clientMsgId: string;
    attachment: OutboundAttachment;
  }): Promise<AttachmentOutcome>;
}

export function createAttachmentSender(
  chat: WakuChatClient,
  config: AttachmentSenderConfig,
  log: GatewayLogger,
): AttachmentSender {
  const maxVideoSeconds = config.maxVideoSeconds ?? DEFAULT_MAX_VIDEO_SECONDS;
  const maxUploadBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  /**
   * 失败原样交回上游，**但内部错误不许被吞掉**。
   *
   * 非 `WakuApiError` = 平台还没参与，是我们自己炸了（DB / fs / 解码）。以前这里一律回
   * `send_failed` 且一行日志都不写：`no such table: asset_uploads` 落到运维眼里只剩
   * "attachment=1/1 (image): send_failed"，每 30s 重投一次、永远失败，也看不出为什么。
   * 现在原始 message 记一行、code 带上错误标签——一眼分得出"平台拒了"和"我们自己炸了"。
   *
   * kind 仍是 `unknown`：内部错误发生在发送之前还是之后，这里判断不了，重试语义不动。
   */
  function failureFrom(error: unknown): Extract<AttachmentOutcome, { status: 'failed' }> {
    if (!isWakuApiError(error)) {
      const detail = describeInternalError(error);
      log.error(`   attachment internal error: ${detail}`);
      return { status: 'failed', kind: 'unknown', code: internalFailureCode(error), detail };
    }
    if (error.kind === 'network') return { status: 'failed', kind: 'unknown', code: error.code };
    if (error.kind === 'auth') return { status: 'failed', kind: 'retryable', code: error.code };
    const status = error.status ?? 0;
    if (status === 429) {
      return error.retryAfterMs === null
        ? { status: 'failed', kind: 'retryable', code: error.code }
        : { status: 'failed', kind: 'retryable', code: error.code, retryAfterMs: error.retryAfterMs };
    }
    if (status === 408 || status === 425 || status >= 500) {
      return { status: 'failed', kind: 'retryable', code: error.code };
    }
    return { status: 'failed', kind: 'permanent-failure', code: error.code };
  }

  /** 上传一个本机文件，命中缓存就不走网络。 */
  async function uploadCached(filePath: string): Promise<string> {
    const key = assetCacheKey(filePath);
    if (key !== null) {
      const cached = config.cache?.get(key) ?? null;
      if (cached !== null) {
        log.info(`   asset cache hit ${path.basename(filePath)} -> ${cached.slice(0, 16)}`);
        return cached;
      }
    }
    const uploaded = await chat.uploadAsset(filePath, mimeForPath(filePath));
    if (key !== null) config.cache?.set(key, uploaded.assetId);
    return uploaded.assetId;
  }

  function readableFile(filePath: string): { ok: true; size: number } | { ok: false; notice: string } {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { ok: false, notice: `附件不存在或读不到：${filePath}` };
    }
    if (!stat.isFile()) return { ok: false, notice: `附件不是一个文件：${path.basename(filePath)}` };
    if (stat.size === 0) return { ok: false, notice: `附件是空文件：${path.basename(filePath)}` };
    if (stat.size > maxUploadBytes) {
      const mib = (n: number): string => `${Math.round(n / (1024 * 1024))} MiB`;
      log.error(`   attachment too large: ${path.basename(filePath)} ${stat.size}B > ${maxUploadBytes}B; not uploaded`);
      return { ok: false, notice: `这个文件太大发不了（${mib(stat.size)} > ${mib(maxUploadBytes)}），先留在本机：${filePath}` };
    }
    return { ok: true, size: stat.size };
  }

  async function sendImage(conversationId: string, clientMsgId: string, attachment: OutboundAttachment): Promise<AttachmentOutcome> {
    const filePath = attachment.path as string;
    const dims = config.probe.imageDimensions(filePath);
    let assetId: string;
    try {
      assetId = await uploadCached(filePath);
    } catch (error) {
      return failureFrom(error);
    }
    try {
      const result = await chat.sendMessage(conversationId, {
        clientMsgId,
        kind: 'image',
        imageAssetId: assetId,
        ...(dims.width === null ? {} : { imageWidth: dims.width }),
        ...(dims.height === null ? {} : { imageHeight: dims.height }),
        ...(attachment.caption === undefined ? {} : { body: attachment.caption }),
      });
      return { status: 'sent', messageId: result.messageId };
    } catch (error) {
      return failureFrom(error);
    }
  }

  async function sendVideo(conversationId: string, clientMsgId: string, attachment: OutboundAttachment): Promise<AttachmentOutcome> {
    let filePath = attachment.path as string;
    const hasFfmpeg = config.probe.hasFfmpeg();
    if (!hasFfmpeg) {
      log.error(`   video without ffmpeg: sending ${path.basename(filePath)} with no poster and no duration`);
    }

    let probe = hasFfmpeg ? await config.probe.probeAv(filePath) : null;

    if (config.transcodeVideo === true && hasFfmpeg) {
      const out = path.join(config.tmpDir, `transcode-${path.basename(filePath)}.mp4`);
      fs.mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
      const transcoded = await config.probe.transcode(filePath, out, maxVideoSeconds);
      if (transcoded !== null) {
        filePath = transcoded;
        probe = await config.probe.probeAv(filePath);
      } else {
        log.error('   video transcode failed; sending the original file');
      }
    }

    let posterAssetId: string | null = null;
    if (hasFfmpeg) {
      const posterPath = path.join(config.tmpDir, `poster-${path.basename(filePath)}.jpg`);
      fs.mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
      const poster = await config.probe.extractPoster(filePath, posterPath);
      if (poster !== null) {
        try {
          posterAssetId = await uploadCached(poster);
        } catch {
          // 封面传不上去不该拖累视频本身：少张封面而已。
          log.error('   poster upload failed; sending the video without a poster');
        }
      }
    }

    let assetId: string;
    try {
      assetId = await uploadCached(filePath);
    } catch (error) {
      return failureFrom(error);
    }

    const payload: Record<string, unknown> = { asset_id: assetId };
    if (posterAssetId !== null) payload['poster_asset_id'] = posterAssetId;
    if (probe?.width != null) payload['width'] = probe.width;
    if (probe?.height != null) payload['height'] = probe.height;
    if (probe?.durationMs != null) payload['duration_ms'] = probe.durationMs;

    try {
      const result = await chat.sendMessage(conversationId, {
        clientMsgId,
        kind: 'video',
        payload,
        ...(attachment.caption === undefined ? {} : { body: attachment.caption }),
      });
      return { status: 'sent', messageId: result.messageId };
    } catch (error) {
      return failureFrom(error);
    }
  }

  async function sendVoice(conversationId: string, clientMsgId: string, attachment: OutboundAttachment): Promise<AttachmentOutcome> {
    const filePath = attachment.path as string;
    const probe = config.probe.hasFfmpeg() ? await config.probe.probeAv(filePath) : null;
    if (probe?.durationMs == null) {
      // 平台要求 voice 必带 duration_ms。取不到就明说，不发一条注定 422 的请求。
      log.error(`   voice without a duration (ffprobe missing or failed): ${path.basename(filePath)} not sent`);
      return {
        status: 'skipped',
        notice: `语音发不出去：本机没有 ffprobe，量不出时长（文件在 ${filePath}）。装个 ffmpeg 就能发了 🙏`,
      };
    }

    let assetId: string;
    try {
      assetId = await uploadCached(filePath);
    } catch (error) {
      return failureFrom(error);
    }
    try {
      const result = await chat.sendMessage(conversationId, {
        clientMsgId,
        kind: 'voice',
        payload: { asset_id: assetId, duration_ms: probe.durationMs },
      });
      return { status: 'sent', messageId: result.messageId };
    } catch (error) {
      return failureFrom(error);
    }
  }

  async function sendCard(conversationId: string, clientMsgId: string, attachment: OutboundAttachment): Promise<AttachmentOutcome> {
    try {
      const result = await chat.sendMessage(conversationId, {
        clientMsgId,
        kind: 'playable_card',
        contentId: attachment.contentId as string,
        ...(attachment.launchCtx === undefined ? {} : { launchCtx: attachment.launchCtx }),
      });
      return { status: 'sent', messageId: result.messageId };
    } catch (error) {
      if (isWakuApiError(error) && (error.status === 404 || error.code === 'content_not_found')) {
        log.error(`   card ${String(attachment.contentId).slice(0, 20)} is not shareable (${error.code})`);
        return { status: 'skipped', notice: CARD_NOT_SHAREABLE_TEXT };
      }
      return failureFrom(error);
    }
  }

  return {
    async send({ conversationId, clientMsgId, attachment }): Promise<AttachmentOutcome> {
      if (attachment.kind === 'card') {
        if (attachment.contentId === undefined || attachment.contentId.length === 0) {
          return { status: 'skipped', notice: '卡片缺少 content_id，没发出去' };
        }
        return sendCard(conversationId, clientMsgId, attachment);
      }

      if (attachment.path === undefined || attachment.path.length === 0) {
        return { status: 'skipped', notice: '附件缺少路径，没发出去' };
      }
      if (attachment.kind === 'file') {
        // Waku 私聊没有 file kind。不硬塞成图片，也不静默丢：告诉用户文件在哪。
        return {
          status: 'skipped',
          notice: `Waku 私聊还不支持发文件，这个先留在本机：${attachment.path}`,
        };
      }

      const readable = readableFile(attachment.path);
      if (!readable.ok) return { status: 'skipped', notice: readable.notice };

      if (attachment.kind === 'image') return sendImage(conversationId, clientMsgId, attachment);
      if (attachment.kind === 'video') return sendVideo(conversationId, clientMsgId, attachment);
      return sendVoice(conversationId, clientMsgId, attachment);
    },
  };
}
