/**
 * waku-dm · 入站媒体贯通：帧 → 下载 → 标记 → `mediaPaths` → Core。
 *
 * 这条链断在任何一节，症状都是"Codex 说它没看到图"，所以这里逐节钉：
 * 解析（`image`/`payload`/`card` 三个字段各自的形状）、下载（真 HTTP）、
 * 标记词汇（与 `extractText` 同源，Agent 已经认得）、路径贯通（`mediaPaths`）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cardMarker, createWakuDmAdapter, parseChatMessage, type WakuDmAdapter } from '../../gateway/channels/waku-dm/adapter.js';
import { createWakuChatClient } from '../../gateway/channels/waku-dm/chat-client.js';
import { createBridgeCredentialProvider, type BridgeTokenProvider } from '../../gateway/channels/waku-dm/credential-provider.js';
import { createMediaStore } from '../../gateway/channels/waku-dm/media-store.js';
import type { MediaProbe } from '../../gateway/channels/waku-dm/media-probe.js';
import type { IngressAck } from '../../gateway/contracts/channel.js';
import type { DmInboundEnvelope, InboundEnvelope } from '../../gateway/core/ingress.js';
import { openGatewayStore, type GatewayStore } from '../../gateway/state/sqlite-store.js';

import { FakeBridgeServer, RecordingLogger, waitFor } from './fake-bridge-server.js';

const PERSONA = 'usr_persona_000000000000000000001';
const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';
const CONV = 'conv_01J0000000000000000000001';
const CREDENTIAL = 'abc_XfQ1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E0';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(7)]);
const MP4 = Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(32, 3)]);
const M4A = Buffer.concat([Buffer.from('0000ftypM4A '), Buffer.alloc(32, 4)]);

let dir: string;
let server: FakeBridgeServer;
let store: GatewayStore;
let provider: BridgeTokenProvider;
let log: RecordingLogger;
let envelopes: DmInboundEnvelope[];
let adapters: WakuDmAdapter[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-inbound-'));
  server = new FakeBridgeServer({ personaUserId: PERSONA, ownerUserId: OWNER, credential: CREDENTIAL, keepaliveMs: 50 });
  await server.start();
  server.seedDm(CONV, OWNER);
  const credentialFile = path.join(dir, 'bridge.credential');
  fs.writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });
  store = openGatewayStore({ dbPath: path.join(dir, 'gateway.db'), masterKeyPath: path.join(dir, 'master.key') });
  provider = createBridgeCredentialProvider({ credentialFile, apiBase: server.apiBase });
  log = new RecordingLogger();
  envelopes = [];
  adapters = [];
});

afterEach(async () => {
  for (const adapter of adapters) await adapter.stop();
  await server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sink = async (envelope: InboundEnvelope): Promise<IngressAck> => {
  envelopes.push(envelope as DmInboundEnvelope);
  return { status: 'accepted' };
};

/**
 * 只为「入站视频抽帧」这一件事准备的 probe 替身：抽帧写一张真 jpg，其余方法都不该被走到。
 * `ffmpeg:false` 用来测降级（没装 ffmpeg 时跳过抽帧，视频路径照给）。
 */
function framingProbe(options: { ffmpeg?: boolean; fails?: boolean } = {}): MediaProbe & { calls: Array<{ input: string; at: number }> } {
  const ffmpeg = options.ffmpeg ?? true;
  const calls: Array<{ input: string; at: number }> = [];
  return {
    calls,
    hasFfmpeg: () => ffmpeg,
    imageDimensions: () => ({ width: null, height: null }),
    probeAv: async () => null,
    extractPoster: async (input, outPath, atSeconds = 0) => {
      calls.push({ input, at: atSeconds });
      if (!ffmpeg || options.fails === true) return null;
      fs.writeFileSync(outPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      return outPath;
    },
    transcode: async () => null,
  };
}

async function startAdapter(withMedia = true, probe?: MediaProbe): Promise<WakuDmAdapter> {
  const chat = createWakuChatClient({ apiBase: server.apiBase, tokens: provider });
  const adapter = createWakuDmAdapter({
    instanceId: 'waku-dm-test',
    apiBase: server.apiBase,
    tokens: provider,
    chat,
    store,
    now: Date.now,
    log,
    heartbeat: { enabled: false, intervalMs: 60_000, agentName: 'codex', queues: () => ({ running: 0, queued: 0 }) },
    sse: { idleTimeoutMs: 2_000, backoff: { baseMs: 40, maxMs: 160 }, reconnectDelayMs: 20 },
    slowAckMs: 0,
    ...(withMedia
      ? {
          media: createMediaStore({
            rootDir: path.join(dir, 'media'),
            log,
            limits: { imageMaxBytes: 1024, mediaMaxBytes: 4096, timeoutMs: 2_000, ttlMs: 60_000, sweepIntervalMs: 60_000 },
          }),
        }
      : {}),
    ...(probe === undefined ? {} : { attachments: { probe, tmpDir: path.join(dir, 'media', 'out') } }),
  });
  adapters.push(adapter);
  await adapter.start(sink);
  await waitFor(() => server.liveConnectionCount === 1, { label: 'sse connected' });
  return adapter;
}

describe('waku-dm · 入站媒体解析', () => {
  it('parseChatMessage 按 kind 取对字段：image→image、video/voice→payload、card→card', () => {
    const image = parseChatMessage(
      JSON.stringify({
        id: 'm1',
        conversation_id: CONV,
        sender_user_id: OWNER,
        kind: 'image',
        image: { asset_id: 'ast_1', url: 'https://x/i.png', width: 800, height: 600 },
      }),
    );
    expect(image?.image).toEqual({ assetId: 'ast_1', url: 'https://x/i.png', width: 800, height: 600 });

    const video = parseChatMessage(
      JSON.stringify({
        id: 'm2',
        conversation_id: CONV,
        sender_user_id: OWNER,
        kind: 'video',
        payload: { asset_id: 'ast_2', url: 'https://x/v.mp4', width: 1280, height: 720, duration_ms: 4200, poster_url: 'https://x/p.jpg' },
      }),
    );
    expect(video?.video).toEqual({ assetId: 'ast_2', url: 'https://x/v.mp4', width: 1280, height: 720, durationMs: 4200, posterUrl: 'https://x/p.jpg' });

    const voice = parseChatMessage(
      JSON.stringify({ id: 'm3', conversation_id: CONV, sender_user_id: OWNER, kind: 'voice', payload: { asset_id: 'ast_3', url: 'https://x/a.m4a', duration_ms: 3000 } }),
    );
    expect(voice?.voice).toEqual({ assetId: 'ast_3', url: 'https://x/a.m4a', durationMs: 3000 });

    const card = parseChatMessage(
      JSON.stringify({
        id: 'm4',
        conversation_id: CONV,
        sender_user_id: OWNER,
        kind: 'playable_card',
        card: { content_id: 'cnt_9', title: '弹球', cover_url: 'https://x/c.png', author_name: 'aster', project_id: 'prj_1', share_url: 'https://w/s/9' },
      }),
    );
    expect(card?.card).toMatchObject({ contentId: 'cnt_9', title: '弹球', shareUrl: 'https://w/s/9' });
    // 别的 kind 不去乱认字段（video 的 payload 不该被当成 voice）
    expect(video?.voice).toBeNull();
    expect(image?.card).toBeNull();
  });

  it('cardMarker：标题 + content_id + share_url 一行带齐，缺字段就少一段', () => {
    expect(cardMarker({ contentId: 'cnt_9', title: '弹球', coverUrl: null, authorName: 'aster', projectId: null, shareUrl: 'https://w/s/9' })).toBe(
      '[Card: 弹球 content_id=cnt_9 author=aster share_url=https://w/s/9]',
    );
    expect(cardMarker({ contentId: 'cnt_9', title: null, coverUrl: null, authorName: null, projectId: null, shareUrl: null })).toBe('[Card: content_id=cnt_9]');
  });
});

describe('waku-dm · 入站媒体贯通', () => {
  it('图片：下载落盘 → 正文 `[Image: <path>]` → mediaPaths 带上它', async () => {
    await startAdapter();
    const url = server.seedBlob('shot.png', PNG, { contentType: 'image/png' });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'image', body: '看这个暗号', image: { asset_id: 'ast_1', url, width: 800, height: 600 } });

    await waitFor(() => envelopes.length === 1, { label: 'image envelope' });
    const [envelope] = envelopes;
    expect(envelope.mediaPaths).toHaveLength(1);
    const file = (envelope.mediaPaths as string[])[0];
    expect(fs.readFileSync(file)).toEqual(PNG);
    // caption 在前，媒体标记在后——与 extractText 的 `[Image: path]` 同一套词汇
    expect(envelope.text).toBe(`看这个暗号\n[Image: ${file}]`);
    // 认识的 kind 不再回「暂时只支持文字」
    expect(server.messages).toHaveLength(0);
  });

  it('视频 / 语音：各自的标记词与扩展名', async () => {
    await startAdapter();
    const videoUrl = server.seedBlob('clip.mp4', MP4, { contentType: 'video/mp4' });
    const voiceUrl = server.seedBlob('note.m4a', M4A, { contentType: 'audio/mp4' });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'video', payload: { asset_id: 'a', url: videoUrl, duration_ms: 4200 } });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'voice', payload: { asset_id: 'b', url: voiceUrl, duration_ms: 3000 } });

    await waitFor(() => envelopes.length === 2, { label: 'video + voice' });
    expect(envelopes[0].text).toMatch(/^\[Video: .+\.mp4\]$/);
    expect(envelopes[1].text).toMatch(/^\[Voice: .+\.m4a\]$/);
    expect(envelopes[0].mediaPaths).toHaveLength(1);
    expect(envelopes[1].mediaPaths).toHaveLength(1);
  });

  it('视频额外抽一帧：`[VideoFrame: …]` 与视频路径一起进 mediaPaths（模型才真的看得见画面）', async () => {
    // 为什么需要它：codex 的 turn input 只有 localImage / localAudio 两种媒体块，
    // 一个 .mp4 只会退化成正文里的一行 `[附件] <path>` —— 模型看不看得见画面，
    // 取决于它想不想自己去 shell 里跑 ffmpeg，而它经常不想。
    const probe = framingProbe();
    await startAdapter(true, probe);
    const videoUrl = server.seedBlob('clip.mp4', MP4, { contentType: 'video/mp4' });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'video', payload: { asset_id: 'a', url: videoUrl, duration_ms: 4200 } });

    await waitFor(() => envelopes.length === 1, { label: 'video envelope' });
    const [envelope] = envelopes;
    const paths = envelope.mediaPaths as string[];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/\.mp4$/);
    expect(paths[1]).toMatch(/\.frame\.jpg$/);
    expect(fs.existsSync(paths[1])).toBe(true);
    expect(envelope.text).toBe(`[Video: ${paths[0]}]\n[VideoFrame: ${paths[1]}]`);

    // 首帧常是黑场 ⇒ 取第 1 秒（越过结尾时 extractPoster 内部会自己退回首帧）
    expect(probe.calls).toEqual([{ input: paths[0], at: 1 }]);
    // 帧就落在视频旁边 ⇒ MediaStore 的 TTL 清理顺手把它收了，不必再造一套寿命
    expect(path.dirname(paths[1])).toBe(path.dirname(paths[0]));
  });

  it('没有 ffmpeg / 抽帧失败 → 跳过这一帧，视频路径照给（少一帧不该拖垮整条消息）', async () => {
    await startAdapter(true, framingProbe({ ffmpeg: false }));
    const videoUrl = server.seedBlob('clip.mp4', MP4, { contentType: 'video/mp4' });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'video', payload: { asset_id: 'a', url: videoUrl } });

    await waitFor(() => envelopes.length === 1, { label: 'video envelope' });
    expect(envelopes[0].mediaPaths).toHaveLength(1);
    expect(envelopes[0].text).toMatch(/^\[Video: .+\.mp4\]$/);
    expect(envelopes[0].text).not.toContain('VideoFrame');
  });

  it('只有视频抽帧：图片 / 语音不多出一个 VideoFrame', async () => {
    const probe = framingProbe();
    await startAdapter(true, probe);
    const imageUrl = server.seedBlob('shot.png', PNG, { contentType: 'image/png' });
    const voiceUrl = server.seedBlob('note.m4a', M4A, { contentType: 'audio/mp4' });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'image', image: { asset_id: 'a', url: imageUrl, width: 8, height: 8 } });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'voice', payload: { asset_id: 'b', url: voiceUrl, duration_ms: 3000 } });

    await waitFor(() => envelopes.length === 2, { label: 'image + voice' });
    expect(probe.calls).toEqual([]);
    expect(envelopes[0].mediaPaths).toHaveLength(1);
    expect(envelopes[1].mediaPaths).toHaveLength(1);
  });

  it('卡片：不下载任何东西，转成一行文本标记进 Core', async () => {
    await startAdapter();
    server.emitMediaMessage({
      conversationId: CONV,
      senderUserId: OWNER,
      kind: 'playable_card',
      body: '玩玩这个',
      card: { content_id: 'cnt_9', title: '弹球', cover_url: 'https://x/c.png', author_name: 'aster', project_id: 'prj_1', share_url: 'https://w/s/9' },
    });

    await waitFor(() => envelopes.length === 1, { label: 'card envelope' });
    expect(envelopes[0].text).toBe('玩玩这个\n[Card: 弹球 content_id=cnt_9 author=aster share_url=https://w/s/9]');
    expect(envelopes[0].mediaPaths).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'media'))).toBe(false);
  });

  it('下载失败（超限）→ 降级成无路径 `[Image]`，消息照进 Core 不丢', async () => {
    await startAdapter();
    const url = server.seedBlob('huge.png', Buffer.alloc(4096, 1), { contentType: 'image/png' });
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'image', body: '这张很大', image: { asset_id: 'ast_x', url } });

    await waitFor(() => envelopes.length === 1, { label: 'degraded envelope' });
    expect(envelopes[0].text).toBe('这张很大\n[Image]');
    expect(envelopes[0].mediaPaths).toEqual([]);
    expect(log.find(/media too large/)).toHaveLength(1);
  });

  it('sticker 这类还看不了的 kind 仍然只回提示，不进 Core', async () => {
    await startAdapter();
    server.emitMediaMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'playable_card', card: null as never });
    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'sticker', body: null });

    await waitFor(() => server.messages.length >= 1, { label: 'notice' });
    expect(envelopes).toHaveLength(0);
  });
});
