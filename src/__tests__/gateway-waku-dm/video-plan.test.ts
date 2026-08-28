/**
 * waku-dm · 「这段视频要不要先转一遍」的纯决策（`video-plan.ts`）。
 *
 * 三条分支各有各的代价，所以要分开钉：
 *   转了（不该转的） = 白掉一次画质 + 一次 CPU + 一次缓存失效；
 *   没转（该转的）   = 用户点开一个转圈圈，而他那端没有任何补救办法；
 *   被关掉           = 用户显式说了原样发，我们就不许自作主张。
 */
import { describe, it, expect } from 'vitest';

import type { AvProbe } from '../../gateway/channels/waku-dm/media-probe.js';
import {
  DEFAULT_VIDEO_REQUIREMENTS,
  formatDuration,
  planVideoSend,
  posterSeconds,
  truncationNotice,
} from '../../gateway/channels/waku-dm/video-plan.js';

/** 一个「客户端能直接播」的源：mp4 / h264 / aac / 1280x720 / 4.2s。 */
function conforming(overrides: Partial<AvProbe> = {}): AvProbe {
  return { width: 1280, height: 720, durationMs: 4200, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, ...overrides };
}

function plan(probe: AvProbe | null, filePath = '/tmp/clip.mp4', overrides: { enabled?: boolean; hasFfmpeg?: boolean } = {}) {
  return planVideoSend({
    filePath,
    probe,
    hasFfmpeg: overrides.hasFfmpeg ?? true,
    enabled: overrides.enabled ?? true,
    requirements: DEFAULT_VIDEO_REQUIREMENTS,
  });
}

describe('waku-dm · 出站视频转码决策', () => {
  it('源已经合规 → 不转（再转一遍只会掉画质）', () => {
    expect(plan(conforming())).toEqual({ transcode: false, reason: 'already-ok', truncateFromMs: null });
  });

  it('无音轨的合规视频也算合规（录屏 / 生成的片子常常没有声音）', () => {
    expect(plan(conforming({ audioCodec: null, hasAudio: false })).transcode).toBe(false);
  });

  it.each([
    ['时长超 60s', conforming({ durationMs: 90_000 }), '/tmp/clip.mp4', 'duration'],
    ['分辨率超 720p', conforming({ width: 3840, height: 2160 }), '/tmp/clip.mp4', 'resolution'],
    ['只有宽超标也算超标', conforming({ width: 1920, height: 720 }), '/tmp/clip.mp4', 'resolution'],
    ['视频不是 h264', conforming({ videoCodec: 'hevc' }), '/tmp/clip.mp4', 'video-codec'],
    ['音频不是 aac', conforming({ audioCodec: 'opus' }), '/tmp/clip.mp4', 'audio-codec'],
    ['容器不是 mp4（.mov）', conforming(), '/tmp/clip.mov', 'container'],
    ['容器不是 mp4（.webm）', conforming(), '/tmp/clip.webm', 'container'],
  ])('%s → 转', (_label, probe, filePath, reason) => {
    expect(plan(probe, filePath)).toMatchObject({ transcode: true, reason });
  });

  it('ffprobe 探不出来 → 转。「判不了」和「合规」不是一回事', () => {
    expect(plan(null)).toMatchObject({ transcode: true, reason: 'unknown' });
    expect(plan(conforming({ durationMs: null }))).toMatchObject({ transcode: true, reason: 'unknown' });
    expect(plan(conforming({ width: null }))).toMatchObject({ transcode: true, reason: 'unknown' });
  });

  it('WAKU_DM_VIDEO_TRANSCODE=0（enabled=false）→ 一律不转，哪怕源完全不合规', () => {
    expect(plan(conforming({ videoCodec: 'hevc', durationMs: 600_000 }), '/tmp/x.mov', { enabled: false })).toEqual({
      transcode: false,
      reason: 'disabled',
      truncateFromMs: null,
    });
  });

  it('没有 ffmpeg → 转不了，原样发（这条排在 enabled 之前：能力缺失优先于配置）', () => {
    expect(plan(conforming({ videoCodec: 'hevc' }), '/tmp/x.mov', { hasFfmpeg: false })).toEqual({
      transcode: false,
      reason: 'no-ffmpeg',
      truncateFromMs: null,
    });
  });

  it('只有「要转且会被截断」时才给出源时长——调用方据此决定要不要在正文里说一句', () => {
    expect(plan(conforming({ durationMs: 90_000 })).truncateFromMs).toBe(90_000);
    // 因为别的原因转码、但时长本来就没超 → 不该说「只发了前 60 秒」
    expect(plan(conforming({ videoCodec: 'hevc' })).truncateFromMs).toBeNull();
    expect(plan(conforming({ durationMs: 90_000 }), '/tmp/x.mp4', { enabled: false }).truncateFromMs).toBeNull();
  });
});

describe('waku-dm · 封面取帧时刻与时长文案', () => {
  it('够长取第 1 秒（首帧常是黑场），太短退回首帧', () => {
    expect(posterSeconds(conforming({ durationMs: 4200 }))).toBe(1);
    expect(posterSeconds(conforming({ durationMs: 1500 }))).toBe(0);
    expect(posterSeconds(conforming({ durationMs: null }))).toBe(0);
    expect(posterSeconds(null)).toBe(0);
  });

  it('时长按人话写', () => {
    expect(formatDuration(3200)).toBe('3s');
    expect(formatDuration(59_400)).toBe('59s');
    expect(formatDuration(90_000)).toBe('1:30');
    expect(formatDuration(605_000)).toBe('10:05');
  });

  it('截断说明必须同时含「原时长」与「只发了多少」', () => {
    const notice = truncationNotice(90_000, 60);
    expect(notice).toContain('1:30');
    expect(notice).toContain('60s');
  });
});
