/**
 * 入站媒体落盘（waku-dm 通道私有）。
 *
 * 平台在 `chat.message` 帧里给的是一条**匿名可 GET 的公开 GCS URL**。Agent（codex）只吃本机路径
 * （`localImage` / `localAudio`），所以这一层负责把 URL 变成路径，并且只负责这件事。
 *
 * 三道闸，缺一不可——它们防的是同一件事：**别人发什么，我们就往自己盘上写什么**：
 *
 * 1. **体积**：图片 16 MiB、音视频 100 MiB（env 可调）。先看 `Content-Length`，没有就边读边数，
 *    超了立刻 abort 并删掉半截文件——不是读完再判（读完才发现 2 GB 已经晚了）。
 * 2. **时限**：单次下载 60s。挂住的连接会把整条 SSE 消费链堵死（handleFrame 是串行 await 的）。
 * 3. **寿命**：TTL 24h，启动时扫一次、之后每小时扫一次。聊天里的图看完就没用了，
 *    留在盘上只会变成一个没人记得的垃圾堆。
 *
 * 下载失败**不丢整条消息**：返回 null，调用方退化成无路径标记（`[Image]`），
 * 用户说的话照样进 Agent——比"整条消息静默消失"好得多。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GatewayLogger } from '../../log.js';

export type InboundMediaKind = 'image' | 'video' | 'voice';

export const WAKU_DM_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const WAKU_DM_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const WAKU_DM_DOWNLOAD_TIMEOUT_MS = 60_000;
export const WAKU_DM_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
export const WAKU_DM_MEDIA_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface MediaStoreLimits {
  imageMaxBytes: number;
  mediaMaxBytes: number;
  timeoutMs: number;
  ttlMs: number;
  sweepIntervalMs: number;
}

export interface MediaDownloadInput {
  conversationId: string;
  messageId: string;
  index: number;
  url: string;
  kind: InboundMediaKind;
}

export interface MediaStore {
  readonly rootDir: string;
  /** 下载并落盘；失败返回 null（已经记过日志）。 */
  download(input: MediaDownloadInput): Promise<string | null>;
  /** 删掉超过 TTL 的文件与空目录，返回删掉的文件数。 */
  sweep(): number;
  /** 启动时扫一次 + 起周期扫。 */
  start(): void;
  stop(): void;
}

export interface MediaStoreOptions {
  /** 缺省 `<stateDir>/media`。 */
  rootDir: string;
  log: GatewayLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  limits?: Partial<MediaStoreLimits>;
}

// ---------------------------------------------------------------------------
// 扩展名判定：Content-Type 优先，其次魔数，最后按 kind 兜底
// ---------------------------------------------------------------------------

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/amr': '.amr',
};

const FALLBACK_EXT: Record<InboundMediaKind, string> = {
  image: '.jpg',
  video: '.mp4',
  voice: '.m4a',
};

function startsWith(buffer: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function ascii(buffer: Uint8Array, offset: number, length: number): string {
  if (buffer.length < offset + length) return '';
  return Buffer.from(buffer.subarray(offset, offset + length)).toString('latin1');
}

/** 魔数嗅探。认不出返回 null（调用方按 kind 兜底）。 */
export function sniffExtension(head: Uint8Array, kind: InboundMediaKind): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return '.png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return '.jpg';
  if (ascii(head, 0, 4) === 'GIF8') return '.gif';
  if (ascii(head, 0, 4) === 'RIFF') {
    const form = ascii(head, 8, 4);
    if (form === 'WEBP') return '.webp';
    if (form === 'WAVE') return '.wav';
  }
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (brand.startsWith('M4A')) return '.m4a';
    if (brand === 'qt  ') return '.mov';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return '.heic';
    return kind === 'voice' ? '.m4a' : '.mp4';
  }
  if (ascii(head, 0, 4) === 'OggS') return '.ogg';
  if (ascii(head, 0, 3) === 'ID3' || startsWith(head, [0xff, 0xfb]) || startsWith(head, [0xff, 0xf3])) return '.mp3';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return kind === 'voice' ? '.webm' : '.webm';
  if (ascii(head, 0, 4) === '#!AM') return '.amr';
  return null;
}

/** 文件名里的 id 全是平台铸的（`conv_…` / `cmsg_…`），但别人给什么就写什么不是我们该做的事。 */
function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // `..` 在这里没有任何合法用途；留着只会让日志里的路径读起来像一次穿越尝试。
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_');
  return cleaned.length === 0 ? 'unknown' : cleaned.slice(0, 96);
}

// ---------------------------------------------------------------------------

export function createMediaStore(options: MediaStoreOptions): MediaStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log;
  const limits: MediaStoreLimits = {
    imageMaxBytes: options.limits?.imageMaxBytes ?? WAKU_DM_IMAGE_MAX_BYTES,
    mediaMaxBytes: options.limits?.mediaMaxBytes ?? WAKU_DM_MEDIA_MAX_BYTES,
    timeoutMs: options.limits?.timeoutMs ?? WAKU_DM_DOWNLOAD_TIMEOUT_MS,
    ttlMs: options.limits?.ttlMs ?? WAKU_DM_MEDIA_TTL_MS,
    sweepIntervalMs: options.limits?.sweepIntervalMs ?? WAKU_DM_MEDIA_SWEEP_INTERVAL_MS,
  };
  const rootDir = options.rootDir;
  let sweepTimer: NodeJS.Timeout | null = null;

  function maxBytesFor(kind: InboundMediaKind): number {
    return kind === 'image' ? limits.imageMaxBytes : limits.mediaMaxBytes;
  }

  async function download(input: MediaDownloadInput): Promise<string | null> {
    const label = `${input.messageId.slice(0, 16)}#${input.index}`;
    const maxBytes = maxBytesFor(input.kind);

    let response: Response;
    try {
      response = await fetchImpl(input.url, {
        method: 'GET',
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
    } catch (error) {
      log.error(`media download failed ${label}: request failed (${error instanceof Error ? error.name : 'error'})`);
      return null;
    }
    if (!response.ok) {
      log.error(`media download failed ${label}: HTTP ${response.status}`);
      return null;
    }

    // 先信 Content-Length：能在读第一个字节之前就拒掉的，就别读。
    const declared = Number(response.headers.get('Content-Length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      log.error(`media too large ${label}: ${declared}B > ${maxBytes}B (${input.kind}); skipped`);
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const body = response.body;
    if (body === null) {
      log.error(`media download failed ${label}: empty body`);
      return null;
    }

    const dir = path.join(rootDir, safeSegment(input.conversationId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${safeSegment(input.messageId)}-${input.index}.part`);

    let handle: fs.promises.FileHandle | null = null;
    let received = 0;
    let head = Buffer.alloc(0);
    try {
      handle = await fs.promises.open(tmp, 'w', 0o600);
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new MediaTooLarge(received, maxBytes);
        }
        if (head.length < 16) head = Buffer.concat([head, Buffer.from(value.subarray(0, 16))]).subarray(0, 16);
        await handle.write(value);
      }
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      fs.rmSync(tmp, { force: true });
      if (error instanceof MediaTooLarge) {
        log.error(`media too large ${label}: >${error.limit}B (${input.kind}); skipped`);
      } else {
        log.error(`media download failed ${label}: ${error instanceof Error ? error.name : 'error'}`);
      }
      return null;
    }

    const mime = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_MIME[mime] ?? sniffExtension(head, input.kind) ?? FALLBACK_EXT[input.kind];
    const dest = path.join(dir, `${safeSegment(input.messageId)}-${input.index}${ext}`);
    try {
      fs.renameSync(tmp, dest);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      log.error(`media download failed ${label}: could not store the file (${error instanceof Error ? error.name : 'error'})`);
      return null;
    }
    log.info(`   media ${input.kind} ${received}B -> ${dest}`);
    return dest;
  }

  function sweep(): number {
    let removed = 0;
    const cutoff = now() - limits.ttlMs;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return 0;
    }
    for (const name of dirs) {
      const dir = path.join(rootDir, name);
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(dir, entry);
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
          fs.rmSync(file, { force: true });
          removed += 1;
        } catch {
          /* 别人删了 / 权限问题：清理不是关键路径，跳过 */
        }
      }
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        /* 目录非空或已消失 */
      }
    }
    if (removed > 0) log.info(`media sweep removed ${removed} file(s) older than ${Math.round(limits.ttlMs / 3600_000)}h`);
    return removed;
  }

  return {
    rootDir,
    download,
    sweep,

    start(): void {
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      sweep();
      if (sweepTimer !== null) return;
      sweepTimer = setInterval(() => {
        try {
          sweep();
        } catch {
          /* 清理失败不该把 daemon 弄挂 */
        }
      }, limits.sweepIntervalMs);
      if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    },

    stop(): void {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
  };
}

class MediaTooLarge extends Error {
  constructor(
    readonly received: number,
    readonly limit: number,
  ) {
    super('media exceeds the size limit');
    this.name = 'MediaTooLarge';
  }
}
