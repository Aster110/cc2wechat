/**
 * 出站媒体探测（waku-dm 通道私有）。
 *
 * 平台的发送契约要的是**元数据**，不是文件：图片要 `width/height`，视频要 `duration_ms` /
 * 封面 asset，语音**必须**有 `duration_ms`。这些只能在本机算出来。
 *
 * 两类手段，分得很清：
 *
 * - **图片尺寸**：自己读文件头（PNG / JPEG / GIF / WEBP）。纯函数、无依赖、可单测，
 *   因为图片是最常见的一类，不能让它依赖一个可能没装的外部二进制。
 * - **音视频**：`ffprobe` / `ffmpeg`。装了就用（拿时长、宽高、抽封面），没装就降级：
 *   视频原样发（少个封面），语音**不发**（缺 duration_ms 会被平台 422 拒，与其发一条必失败的
 *   请求，不如回一句人话）。降级路径要在日志里响一声，不许静默。
 *
 * 不做的事：不转码（除非显式开 `WAKU_DM_VIDEO_TRANSCODE=1`）、不压缩、不改画质。
 * 用户要发的是他手里那个文件，我们不替他做画质决定。
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { GatewayLogger } from '../../log.js';

export interface ImageDimensions {
  width: number | null;
  height: number | null;
}

export interface AvProbe {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface MediaProbe {
  /** 图片头解析；认不出返回两个 null（平台的 width/height 是可选的）。 */
  imageDimensions(filePath: string): ImageDimensions;
  /** 本机有没有 ffmpeg/ffprobe。 */
  hasFfmpeg(): boolean;
  /** ffprobe 一次拿宽高与时长；没有 ffprobe 或探测失败返回 null。 */
  probeAv(filePath: string): Promise<AvProbe | null>;
  /** 抽第一帧当封面，成功返回文件路径。 */
  extractPoster(filePath: string, outPath: string): Promise<string | null>;
  /** 转码到 720p H.264（可选路径，默认关）。 */
  transcode(filePath: string, outPath: string, maxSeconds: number): Promise<string | null>;
}

export interface MediaProbeOptions {
  log: GatewayLogger;
  /** 测试可以换掉这两个二进制名（或指成一个不存在的名字来测降级）。 */
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

export const FFMPEG_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// 图片头（纯函数，单测直接打这里）
// ---------------------------------------------------------------------------

function ascii(buffer: Buffer, offset: number, length: number): string {
  if (buffer.length < offset + length) return '';
  return buffer.subarray(offset, offset + length).toString('latin1');
}

/**
 * PNG / JPEG / GIF / WEBP(VP8|VP8L|VP8X) 的宽高。认不出一律 `{null,null}` —— 平台侧
 * width/height 是可选字段，猜一个错的比不给更糟（客户端会按错误比例占位）。
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions {
  const none: ImageDimensions = { width: null, height: null };

  // PNG: 8B 签名 + IHDR(len,type,width,height)
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: 'GIF87a'/'GIF89a' + LE width/height
  if (ascii(buffer, 0, 3) === 'GIF' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // WEBP: RIFF....WEBP
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP' && buffer.length >= 30) {
    const chunk = ascii(buffer, 12, 4);
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { width, height };
    }
    return none;
  }

  // JPEG: 逐段跳到 SOFn
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0..SOF15，排除 DHT(c4)/JPG(c8)/DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return none;
      offset += 2 + length;
    }
  }

  return none;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.amr': 'audio/amr',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
};

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: error === null, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

export function createMediaProbe(options: MediaProbeOptions): MediaProbe {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  const log = options.log;
  let available: boolean | null = null;

  function hasFfmpeg(): boolean {
    if (available !== null) return available;
    try {
      // -version 是最便宜的存在性探测；不存在会抛 ENOENT。
      execFileSync(ffprobe, ['-version'], { stdio: 'ignore', timeout: 5_000 });
      execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 5_000 });
      available = true;
    } catch {
      available = false;
      log.error('ffmpeg/ffprobe not found: videos go out without a poster and voice notes cannot be sent (install ffmpeg to fix)');
    }
    return available;
  }

  return {
    hasFfmpeg,

    imageDimensions(filePath: string): ImageDimensions {
      let head: Buffer;
      try {
        const handle = fs.openSync(filePath, 'r');
        try {
          head = Buffer.alloc(64 * 1024);
          const read = fs.readSync(handle, head, 0, head.length, 0);
          head = head.subarray(0, read);
        } finally {
          fs.closeSync(handle);
        }
      } catch {
        return { width: null, height: null };
      }
      return readImageDimensions(head);
    },

    async probeAv(filePath: string): Promise<AvProbe | null> {
      if (!hasFfmpeg()) return null;
      const result = await run(
        ffprobe,
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        timeoutMs,
      );
      if (!result.ok) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as { format?: { duration?: unknown }; streams?: Array<Record<string, unknown>> };

      let durationMs: number | null = null;
      const formatDuration = Number(record.format?.duration);
      if (Number.isFinite(formatDuration) && formatDuration > 0) durationMs = Math.round(formatDuration * 1000);

      let width: number | null = null;
      let height: number | null = null;
      for (const stream of record.streams ?? []) {
        if (stream['codec_type'] !== 'video') continue;
        const w = Number(stream['width']);
        const h = Number(stream['height']);
        if (Number.isFinite(w) && w > 0) width = Math.round(w);
        if (Number.isFinite(h) && h > 0) height = Math.round(h);
        break;
      }
      if (durationMs === null) {
        for (const stream of record.streams ?? []) {
          const d = Number(stream['duration']);
          if (Number.isFinite(d) && d > 0) {
            durationMs = Math.round(d * 1000);
            break;
          }
        }
      }
      return { width, height, durationMs };
    },

    async extractPoster(filePath: string, outPath: string): Promise<string | null> {
      if (!hasFfmpeg()) return null;
      const result = await run(
        ffmpeg,
        ['-y', '-loglevel', 'error', '-ss', '0', '-i', filePath, '-frames:v', '1', '-f', 'image2', outPath],
        timeoutMs,
      );
      if (!result.ok || !fs.existsSync(outPath)) return null;
      return outPath;
    },

    async transcode(filePath: string, outPath: string, maxSeconds: number): Promise<string | null> {
      if (!hasFfmpeg()) return null;
      const result = await run(
        ffmpeg,
        [
          '-y',
          '-loglevel',
          'error',
          '-i',
          filePath,
          '-t',
          String(maxSeconds),
          '-vf',
          "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '26',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          outPath,
        ],
        timeoutMs,
      );
      if (!result.ok || !fs.existsSync(outPath)) return null;
      return outPath;
    },
  };
}
