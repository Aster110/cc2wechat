/**
 * 出站附件发送（waku-dm 通道私有）：一条 `OutboundAttachment` → 平台上的一条真消息。
 *
 * 分成三段，每段都有自己的失败语义，混起来就没法判该不该重投：
 *
 *   探测（本机） → 上传（asset） → 发送（chat message）
 *
 * 1. **探测失败 ≠ 发送失败**。语音缺 `duration_ms` 会被平台 422 拒；文件的类型不在平台上传门的
 *    白名单里会被 415 拒——与其发一条注定失败的请求、再让 outbox 重投八次，不如当场退化成一句
 *    人话（`skipped`），用户至少知道发生了什么。
 * 2. **上传成功要缓存**。上传成功、发送失败的重投是最常见的一种：没有缓存的话，
 *    一个 80 MB 的视频会被重新传一遍。缓存 key = 源文件的 `路径 + 大小 + mtime`（+ 派生产物的
 *    variant 后缀）——按派生产物自己的 stat 算的话，转码每跑一次 mtime 就变，缓存等于没有。
 * 3. **发送失败原样交回**。429 / 5xx → retryable，403/404/415 → permanent-failure，
 *    网络断 → unknown（可能已落库）。判定复用通道已有的那张表，这里不自造第二套。
 *
 * 每种 kind 落到平台上的形态：
 *
 * | kind | 平台消息 | 关键约束 |
 * |---|---|---|
 * | image | `kind=image` | 宽高读文件头 |
 * | video | `kind=video` | **默认先转成 ≤60s / ≤720p / h264+aac / faststart**（源已合规则跳过）+ 封面 |
 * | audio | `kind=voice` | 必带 `duration_ms`，量不出就不发 |
 * | card  | `kind=playable_card` | 内容必须可分享 |
 * | file  | `kind=text`（一条公开链接） | 私聊**没有** file kind，也不为此新增——见 `sendFile` |
 *
 * `client_msg_id` 由调用方给（`<messageId>:att<i>`），服务端 `UNIQUE(sender, client_msg_id)`
 * 保证重投不会在用户屏幕上留下第二张图。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { OutboundAttachment } from '../../core/attachments.js';
import { describeInternalError, type GatewayLogger } from '../../log.js';
import { isWakuApiError, type WakuChatClient } from './chat-client.js';
import {
  DOCUMENT_HEAD_BYTES,
  documentBytesMatch,
  documentMimeForPath,
  fileLinkText,
  fileNotSendableNotice,
  formatBytes,
} from './file-kinds.js';
import { mimeForPath, type AvProbe, type MediaProbe } from './media-probe.js';
import { DEFAULT_VIDEO_REQUIREMENTS, planVideoSend, posterSeconds, truncationNotice } from './video-plan.js';

/** 上传缓存：key → 上传结果。实现在 sqlite-store（`asset_uploads` 表）。 */
export interface CachedAsset {
  assetId: string;
  /** 文件类要靠它拼链接；v4 之前的老行读出来是 null（只能重传一次）。 */
  publicUrl: string | null;
}

export interface AssetUploadCache {
  get(cacheKey: string): CachedAsset | null;
  set(cacheKey: string, value: CachedAsset): void;
}

export interface AttachmentSenderConfig {
  probe: MediaProbe;
  cache?: AssetUploadCache;
  /** 封面 / 转码产物的落脚点。 */
  tmpDir: string;
  /**
   * 出站视频转码。**默认开**（`WAKU_DM_VIDEO_TRANSCODE=0` 才关）。
   *
   * 为什么默认开：客户端能稳定播的是 ≤60s / ≤720p / H.264 + AAC / faststart 的 mp4，而平台后端
   * **不转码**。Agent 产出的视频五花八门（录屏的 hevc、4K、webm、裸流），默认原样发的结果是
   * 用户点开一个转圈圈——而那在用户那端**没有任何补救办法**。源已经合规时会跳过转码
   * （`video-plan.ts` 判 container / codec / 宽高 / 时长），不白掉一次画质。
   */
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

/**
 * 缓存 key。**永远按「源文件」算，派生产物只加一个 variant 后缀。**
 *
 * 为什么不能按派生产物自己的 stat 算：转码 / 抽帧每跑一次都会写出一个新 mtime，于是
 * 「上传成功、发送失败」的那次重投必然缓存未命中、把刚转好的视频再传一遍——这恰恰是缓存
 * 存在的唯一理由。源没动过，派生产物就该复用同一枚 asset。
 */
export function assetCacheKey(filePath: string, variant?: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const base = `${path.resolve(filePath)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    return variant === undefined ? base : `${base}#${variant}`;
  } catch {
    return null;
  }
}

/**
 * 派生产物（转码视频 / 封面）的落盘文件名。
 *
 * 名字里必须带源路径的哈希：只用 basename 的话 `/a/clip.mp4` 与 `/b/clip.mp4` 会写到同一个
 * 文件上——两轮并发就会把彼此的转码结果覆盖掉，而症状是「用户收到了别人的视频」。
 */
export function derivedArtifactName(sourcePath: string, prefix: string, ext: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(sourcePath)).digest('hex').slice(0, 10);
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  return `${prefix}-${hash}-${base}${ext}`;
}

/** 头部若干字节 + 「是不是被截断了」。文件不可读返回 null。 */
export function readHead(filePath: string, maxBytes: number): { bytes: Buffer; truncated: boolean } | null {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(handle, buffer, 0, maxBytes, 0);
    const size = fs.fstatSync(handle).size;
    return { bytes: buffer.subarray(0, read), truncated: size > read };
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* 关不上不影响判定 */
      }
    }
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

  /**
   * 上传一个本机文件，命中缓存就不走网络。
   *
   * `cacheSource` / `variant`：派生产物（转码视频、封面）按**源文件**的 stat 算 key，见
   * `assetCacheKey` 的注释。`requireUrl=true` 时，缓存里没有 URL 的老行按未命中处理——
   * 文件类的正文就是那条 URL，拿不到宁可重传一次。
   */
  async function uploadCached(
    filePath: string,
    options: { cacheSource?: string; variant?: string; requireUrl?: boolean } = {},
  ): Promise<CachedAsset> {
    const key = assetCacheKey(options.cacheSource ?? filePath, options.variant);
    if (key !== null) {
      const cached = config.cache?.get(key) ?? null;
      if (cached !== null && (options.requireUrl !== true || cached.publicUrl !== null)) {
        log.info(`   asset cache hit ${path.basename(filePath)} -> ${cached.assetId.slice(0, 16)}`);
        return cached;
      }
    }
    const uploaded = await chat.uploadAsset(filePath, mimeForPath(filePath));
    const value: CachedAsset = { assetId: uploaded.assetId, publicUrl: uploaded.publicUrl };
    if (key !== null) config.cache?.set(key, value);
    return value;
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
      log.error(`   attachment too large: ${path.basename(filePath)} ${stat.size}B > ${maxUploadBytes}B; not uploaded`);
      return {
        ok: false,
        notice: `这个文件太大发不了（${formatBytes(stat.size)} > ${formatBytes(maxUploadBytes)}），先留在本机：${filePath}`,
      };
    }
    return { ok: true, size: stat.size };
  }

  async function sendImage(conversationId: string, clientMsgId: string, attachment: OutboundAttachment): Promise<AttachmentOutcome> {
    const filePath = attachment.path as string;
    const dims = config.probe.imageDimensions(filePath);
    let assetId: string;
    try {
      assetId = (await uploadCached(filePath)).assetId;
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
    const source = attachment.path as string;
    const hasFfmpeg = config.probe.hasFfmpeg();
    if (!hasFfmpeg) {
      log.error(`   video without ffmpeg: sending ${path.basename(source)} as-is (no poster, no duration, may not play)`);
    }

    let probe: AvProbe | null = hasFfmpeg ? await config.probe.probeAv(source) : null;
    const plan = planVideoSend({
      filePath: source,
      probe,
      hasFfmpeg,
      enabled: config.transcodeVideo !== false,
      requirements: { ...DEFAULT_VIDEO_REQUIREMENTS, maxSeconds: maxVideoSeconds },
    });

    let uploadPath = source;
    let variant: string | undefined;
    let truncatedFromMs: number | null = null;
    if (plan.transcode) {
      fs.mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
      const out = path.join(config.tmpDir, derivedArtifactName(source, 'transcode', '.mp4'));
      log.info(`   transcoding video (${plan.reason}) ${path.basename(source)} -> 720p h264/aac ≤${maxVideoSeconds}s`);
      const transcoded = await config.probe.transcode(source, out, maxVideoSeconds);
      if (transcoded === null) {
        // 转码失败不该把整条消息拖死：原样发总比不发强，只是可能播不了——所以日志要响。
        log.error('   video transcode failed; sending the original file (it may not play on the client)');
      } else {
        uploadPath = transcoded;
        variant = `v720@${maxVideoSeconds}s`;
        truncatedFromMs = plan.truncateFromMs;
        // 元数据必须重新量：payload 描述的是**发出去的那个文件**，不是源文件。
        probe = await config.probe.probeAv(uploadPath);
      }
    }

    let posterAssetId: string | null = null;
    if (hasFfmpeg) {
      fs.mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
      const posterPath = path.join(config.tmpDir, derivedArtifactName(source, 'poster', '.jpg'));
      const poster = await config.probe.extractPoster(uploadPath, posterPath, posterSeconds(probe));
      if (poster !== null) {
        try {
          posterAssetId = (await uploadCached(poster, { cacheSource: source, variant: 'poster' })).assetId;
        } catch {
          // 封面传不上去不该拖累视频本身：少张封面而已。
          log.error('   poster upload failed; sending the video without a poster');
        }
      } else {
        log.error(`   poster extraction failed for ${path.basename(uploadPath)}; sending without a poster`);
      }
    }

    let assetId: string;
    try {
      assetId = (await uploadCached(uploadPath, { cacheSource: source, ...(variant === undefined ? {} : { variant }) })).assetId;
    } catch (error) {
      return failureFrom(error);
    }

    const payload: Record<string, unknown> = { asset_id: assetId };
    if (posterAssetId !== null) payload['poster_asset_id'] = posterAssetId;
    if (probe?.width != null) payload['width'] = probe.width;
    if (probe?.height != null) payload['height'] = probe.height;
    if (probe?.durationMs != null) payload['duration_ms'] = probe.durationMs;

    // 截断了就必须说：不说的话用户只会以为「视频发过来少了一半」，而他无从判断是不是坏了。
    const body = [attachment.caption, truncatedFromMs === null ? undefined : truncationNotice(truncatedFromMs, maxVideoSeconds)]
      .filter((part): part is string => part !== undefined && part.trim().length > 0)
      .join('\n');

    try {
      const result = await chat.sendMessage(conversationId, {
        clientMsgId,
        kind: 'video',
        payload,
        ...(body.length === 0 ? {} : { body }),
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
      assetId = (await uploadCached(filePath)).assetId;
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

  /**
   * 文件：**没有 file kind，所以走一条公开链接**。
   *
   *   上传到 bridge 上传门 → 拿 public_url → 发一条 `kind=text`：`📎 <名字>（<大小>）\n<url>`
   *
   * 为什么不是「硬塞成 image」也不是「新增一个 kind」：前者会在用户屏幕上炸出一张裂图，
   * 后者要动 iOS / Android / Web 三端渲染 + 通知摘要 + 会话预览，代价远大于一条链接。
   *
   * **本机先判一次能不能传**（扩展名 → mime，再对一次头部字节）：平台的 415 是
   * `permanent-failure`，用户屏幕上什么都不会出现，而且每一发都要烧一次每日配额和整个文件的
   * 上行带宽。本机判错了也不会卡死——415 在这里被降级成同一句人话，而不是 `permanent-failure`。
   */
  async function sendFile(conversationId: string, clientMsgId: string, attachment: OutboundAttachment): Promise<AttachmentOutcome> {
    const filePath = attachment.path as string;
    const mime = documentMimeForPath(filePath);
    if (mime === null) {
      log.info(`   file ${path.basename(filePath)}: extension not in the platform allowlist; not uploaded`);
      return { status: 'skipped', notice: fileNotSendableNotice(filePath) };
    }
    const head = readHead(filePath, DOCUMENT_HEAD_BYTES);
    if (head === null || !documentBytesMatch(head.bytes, mime, { truncated: head.truncated })) {
      log.error(`   file ${path.basename(filePath)}: content does not match ${mime}; not uploaded`);
      return { status: 'skipped', notice: fileNotSendableNotice(filePath) };
    }

    let uploaded: CachedAsset;
    try {
      uploaded = await uploadCached(filePath, { requireUrl: true });
    } catch (error) {
      // 平台收窄了白名单（或本机这张表比平台宽）：降级成人话，不当永久失败静默掉。
      if (isWakuApiError(error) && error.status === 415) {
        log.error(`   file upload rejected by the platform (415 ${error.code}): ${path.basename(filePath)}`);
        return { status: 'skipped', notice: fileNotSendableNotice(filePath) };
      }
      return failureFrom(error);
    }
    if (uploaded.publicUrl === null || uploaded.publicUrl.length === 0) {
      log.error(`   file uploaded but the platform returned no public_url: ${path.basename(filePath)}`);
      return { status: 'skipped', notice: fileNotSendableNotice(filePath) };
    }

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(filePath).size;
    } catch {
      /* 刚读过头部，这里读不到 stat 也只是少一个体积数字 */
    }
    try {
      const result = await chat.sendMessage(conversationId, {
        clientMsgId,
        kind: 'text',
        body: fileLinkText({
          filename: path.basename(filePath),
          sizeBytes,
          url: uploaded.publicUrl,
          ...(attachment.caption === undefined ? {} : { caption: attachment.caption }),
        }),
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
      const readable = readableFile(attachment.path);
      if (!readable.ok) return { status: 'skipped', notice: readable.notice };

      if (attachment.kind === 'image') return sendImage(conversationId, clientMsgId, attachment);
      if (attachment.kind === 'video') return sendVideo(conversationId, clientMsgId, attachment);
      if (attachment.kind === 'file') return sendFile(conversationId, clientMsgId, attachment);
      return sendVoice(conversationId, clientMsgId, attachment);
    },
  };
}
