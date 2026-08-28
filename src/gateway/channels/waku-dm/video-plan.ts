/**
 * 「这段视频要不要先转一遍再发」——出站视频的**决策**，与 ffmpeg 怎么跑无关。
 *
 * 背景：客户端（iOS / Android）能稳定播的是 **≤60s、≤720p、H.264 + AAC、mp4 faststart**。
 * 平台后端**不转码**（决策 259 之后媒体只做存取，不做处理），所以这件事只能在 daemon 做——
 * 而 daemon 手里恰好有源文件和 ffmpeg。默认就该转：Agent 产出的视频五花八门
 * （screen recording 的 hevc / 4K、`testsrc` 的裸流、别人发来的 webm），
 * 「默认原样发」的结果是用户点开一个转圈圈，而这在用户那端**没有任何补救办法**。
 *
 * 但也不该无脑转：一个本来就合规的 mp4 再转一遍只会掉画质、烧 CPU、还让上传缓存失效。
 * 所以先 ffprobe 判一次「源已经合规吗」，合规就原样发。
 *
 * 本模块**零 I/O 零 ffmpeg**：只吃一份 `AvProbe` 和几个阈值，因此三条分支
 * （需要转 / 不需要转 / 被关掉）能被纯函数单测钉死。
 */
import path from 'node:path';

import type { AvProbe } from './media-probe.js';

export interface VideoRequirements {
  maxSeconds: number;
  maxWidth: number;
  maxHeight: number;
}

export const DEFAULT_VIDEO_REQUIREMENTS: VideoRequirements = {
  maxSeconds: 60,
  maxWidth: 1280,
  maxHeight: 720,
};

/** mp4 家族之外的容器一律转：`.mov` / `.webm` / `.mkv` 在三端上没有一致的可播保证。 */
const MP4_EXT = new Set(['.mp4', '.m4v']);

export type TranscodeReason =
  /** `WAKU_DM_VIDEO_TRANSCODE=0`：用户显式要求原样发。 */
  | 'disabled'
  /** 本机没有 ffmpeg：转不了，只能原样发（调用方要在日志里响一声）。 */
  | 'no-ffmpeg'
  /** 源已经合规。 */
  | 'already-ok'
  | 'container'
  | 'duration'
  | 'resolution'
  | 'video-codec'
  | 'audio-codec'
  /** ffprobe 探不出来：判不了就转——「判不了」和「合规」不是一回事。 */
  | 'unknown';

export interface VideoPlan {
  transcode: boolean;
  reason: TranscodeReason;
  /**
   * 源时长（ms）。**只有**在「要转码且会被截断」时非 null——调用方据此在正文里说一句，
   * 否则用户会以为我们把他的视频弄丢了一半。
   */
  truncateFromMs: number | null;
}

export function planVideoSend(input: {
  filePath: string;
  probe: AvProbe | null;
  hasFfmpeg: boolean;
  enabled: boolean;
  requirements?: VideoRequirements;
}): VideoPlan {
  const requirements = input.requirements ?? DEFAULT_VIDEO_REQUIREMENTS;
  const maxMs = requirements.maxSeconds * 1000;
  const overLength = input.probe?.durationMs != null && input.probe.durationMs > maxMs;
  const truncateFromMs = overLength ? (input.probe as AvProbe).durationMs : null;

  if (!input.hasFfmpeg) return { transcode: false, reason: 'no-ffmpeg', truncateFromMs: null };
  if (!input.enabled) return { transcode: false, reason: 'disabled', truncateFromMs: null };

  const reason = mismatchReason(input.filePath, input.probe, requirements, maxMs);
  if (reason === 'already-ok') return { transcode: false, reason, truncateFromMs: null };
  return { transcode: true, reason, truncateFromMs };
}

function mismatchReason(
  filePath: string,
  probe: AvProbe | null,
  requirements: VideoRequirements,
  maxMs: number,
): TranscodeReason {
  // 探不出来排在最前：后面每一条判据都建立在 probe 之上，没有 probe 就一条都不成立。
  if (probe === null) return 'unknown';
  if (!MP4_EXT.has(path.extname(filePath).toLowerCase())) return 'container';
  if (probe.durationMs === null) return 'unknown';
  if (probe.durationMs > maxMs) return 'duration';
  if (probe.width === null || probe.height === null) return 'unknown';
  if (probe.width > requirements.maxWidth || probe.height > requirements.maxHeight) return 'resolution';
  if (probe.videoCodec !== 'h264') return 'video-codec';
  // 无音轨是合法的（很多录屏 / 生成的片子没有声音）；有音轨就必须是 aac。
  if (probe.audioCodec !== null && probe.audioCodec !== 'aac') return 'audio-codec';
  return 'already-ok';
}

/**
 * 封面取帧时刻（秒）。
 *
 * 首帧常常是黑场 / 淡入的第一格，拿它当封面就等于没有封面。够长就取第 1 秒，
 * 太短（≤2s）才退回首帧——那种长度的片子第 1 秒可能已经越过结尾了。
 */
export function posterSeconds(probe: AvProbe | null): number {
  return probe?.durationMs != null && probe.durationMs > 2000 ? 1 : 0;
}

/** `90000 → 1:30`、`3200 → 3s`。给人看的时长。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds - minutes * 60).padStart(2, '0')}`;
}

/** 截断说明。附在视频消息正文里——**不说这一句，用户会以为视频丢了一半**。 */
export function truncationNotice(sourceMs: number, maxSeconds: number): string {
  return `⏱ 原视频 ${formatDuration(sourceMs)}，超过 ${maxSeconds}s 上限，这里只发了前 ${maxSeconds}s。`;
}
