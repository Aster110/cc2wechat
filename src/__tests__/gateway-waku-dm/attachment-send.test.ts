/**
 * waku-dm · 出站附件：上传 → 发送 → 幂等 / 缓存 / 降级。
 *
 * 探测（ffprobe）用注入的替身，因为这里要钉的是**决策**（没有 duration 就不发语音、
 * 没有 ffmpeg 就不带封面），不是 ffmpeg 本身能不能跑。上传与发送走真 HTTP（FakeBridgeServer），
 * 因为要钉的正是"路由对不对、字段对不对、重投会不会传第二遍"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { attachmentClientMsgId, createWakuDmAdapter, type WakuDmAdapter } from '../../gateway/channels/waku-dm/adapter.js';
import { createWakuChatClient } from '../../gateway/channels/waku-dm/chat-client.js';
import {
  createBridgeCredentialProvider,
  createSessionCredentialProvider,
  type BridgeTokenProvider,
} from '../../gateway/channels/waku-dm/credential-provider.js';
import {
  ASSET_CACHE_TTL_MS,
  DEFAULT_MAX_VIDEO_SECONDS,
  internalFailureCode,
  type AssetUploadCache,
} from '../../gateway/channels/waku-dm/attachment-sender.js';
import { describeInternalError } from '../../gateway/log.js';
import { readImageDimensions, type AvProbe, type MediaProbe } from '../../gateway/channels/waku-dm/media-probe.js';
import type { OutboundEnvelope } from '../../gateway/core/delivery.js';
import type { OutboundAttachment } from '../../gateway/core/attachments.js';
import { openGatewayStore, type GatewayStore } from '../../gateway/state/sqlite-store.js';

import { FakeBridgeServer, RecordingLogger } from './fake-bridge-server.js';

const PERSONA = 'usr_persona_000000000000000000001';
const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';
const CONV = 'conv_01J0000000000000000000001';
const CREDENTIAL = 'abc_XfQ1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E0';
const MSG = '0198f4c1-1111-7000-8000-000000000001';

/** 一张真的 2x3 PNG（IHDR 里写死宽高），用来验"宽高是读出来的、不是猜的"。 */
function pngOf(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([header, ihdr, Buffer.alloc(16, 9)]);
}

/** 一个「客户端能直接播」的探测结果：mp4 / h264 / aac / 1280x720 / 4.2s。 */
function conformingAv(overrides: Partial<AvProbe> = {}): AvProbe {
  return { width: 1280, height: 720, durationMs: 4200, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, ...overrides };
}

interface ProbeStub extends MediaProbe {
  posterCalls: number;
  /** 每次抽帧被要求的时刻（秒）——「首帧常是黑场」那条规则只能从这里验。 */
  posterSeconds: number[];
  transcodeCalls: number;
  transcodeSeconds: number[];
}

function stubProbe(
  options: { ffmpeg?: boolean; av?: AvProbe | null; transcodedAv?: AvProbe; transcodeFails?: boolean } = {},
): ProbeStub {
  const ffmpeg = options.ffmpeg ?? true;
  const av = options.av === undefined ? conformingAv() : options.av;
  const stub: ProbeStub = {
    posterCalls: 0,
    posterSeconds: [],
    transcodeCalls: 0,
    transcodeSeconds: [],
    hasFfmpeg: () => ffmpeg,
    imageDimensions: (filePath) => readImageDimensions(fs.readFileSync(filePath)),
    // 转码产物要重新量一遍（payload 描述的是发出去的那个文件），所以它有自己的一份探测结果。
    probeAv: async (filePath) => {
      if (!ffmpeg) return null;
      if (path.basename(filePath).startsWith('transcode-')) return options.transcodedAv ?? av;
      return av;
    },
    extractPoster: async (_input, outPath, atSeconds = 0) => {
      stub.posterCalls += 1;
      stub.posterSeconds.push(atSeconds);
      if (!ffmpeg) return null;
      fs.writeFileSync(outPath, pngOf(64, 36));
      return outPath;
    },
    transcode: async (_input, outPath, maxSeconds) => {
      stub.transcodeCalls += 1;
      stub.transcodeSeconds.push(maxSeconds);
      if (!ffmpeg || options.transcodeFails === true) return null;
      fs.writeFileSync(outPath, Buffer.alloc(64, 5));
      return outPath;
    },
  };
  return stub;
}

let dir: string;
let server: FakeBridgeServer;
let store: GatewayStore;
let provider: BridgeTokenProvider;
let log: RecordingLogger;
let adapters: WakuDmAdapter[];
let probe: ProbeStub;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-attach-'));
  server = new FakeBridgeServer({ personaUserId: PERSONA, ownerUserId: OWNER, credential: CREDENTIAL, keepaliveMs: 50 });
  await server.start();
  server.seedDm(CONV, OWNER);
  const credentialFile = path.join(dir, 'bridge.credential');
  fs.writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });
  store = openGatewayStore({ dbPath: path.join(dir, 'gateway.db'), masterKeyPath: path.join(dir, 'master.key') });
  provider = createBridgeCredentialProvider({ credentialFile, apiBase: server.apiBase });
  log = new RecordingLogger();
  adapters = [];
  probe = stubProbe();
});

afterEach(async () => {
  for (const adapter of adapters) await adapter.stop();
  await server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(
  overrides: {
    tokens?: BridgeTokenProvider;
    transcodeVideo?: boolean;
    maxUploadBytes?: number;
    cache?: AssetUploadCache;
  } = {},
): WakuDmAdapter {
  const tokens = overrides.tokens ?? provider;
  const chat = createWakuChatClient({ apiBase: server.apiBase, tokens });
  const adapter = createWakuDmAdapter({
    instanceId: 'waku-dm-test',
    apiBase: server.apiBase,
    tokens,
    chat,
    store,
    now: Date.now,
    log,
    heartbeat: { enabled: false, intervalMs: 60_000, agentName: 'codex', queues: () => ({ running: 0, queued: 0 }) },
    slowAckMs: 0,
    attachments: {
      probe,
      cache: overrides.cache ?? {
        get: (key) => store.getAssetUpload(key, Date.now(), ASSET_CACHE_TTL_MS),
        set: (key, value) => store.transaction((tx) => tx.saveAssetUpload(key, value, Date.now())),
      },
      tmpDir: path.join(dir, 'outbound'),
      ...(overrides.transcodeVideo === undefined ? {} : { transcodeVideo: overrides.transcodeVideo }),
      ...(overrides.maxUploadBytes === undefined ? {} : { maxUploadBytes: overrides.maxUploadBytes }),
    },
  });
  adapters.push(adapter);
  return adapter;
}

function finalWith(attachments: OutboundAttachment[], text = '给你', messageId = MSG): OutboundEnvelope {
  return {
    routeId: CONV,
    messageId,
    kind: 'final',
    keyVersion: 1,
    expiresAt: Date.now() + 300_000,
    payload: { type: 'final', conversationId: CONV, replyTo: 'cmsg_in_1', text, attachments },
  };
}

function writeFile(name: string, bytes: Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

describe('waku-dm · 出站附件', () => {
  it('图片：上传走 bridge 路由 → kind=image + 从文件头读出的宽高；附件先发、文本后发', async () => {
    const adapter = makeAdapter();
    const file = writeFile('a.png', pngOf(800, 600));

    const receipt = await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));

    expect(receipt.status).toBe('sent');
    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0]).toMatchObject({ route: '/agent-bridges/me/assets', filename: 'a.png', mime: 'image/png', by: PERSONA });
    expect(server.richMessages).toHaveLength(1);
    expect(server.richMessages[0].body).toMatchObject({
      kind: 'image',
      image_asset_id: server.uploads[0].assetId,
      image_width: 800,
      image_height: 600,
      client_msg_id: attachmentClientMsgId(MSG, 0),
    });
    // 顺序：附件那条先落库，文本紧随其后
    expect(server.messages.map((m) => m.clientMsgId)).toEqual([attachmentClientMsgId(MSG, 0), MSG]);
    expect(server.messages[1].body).toBe('看这个');
  });

  it('视频：源已合规 → 不转码，抽封面 + 带宽高时长；封面自己也是一次上传', async () => {
    const adapter = makeAdapter();
    const file = writeFile('clip.mp4', Buffer.alloc(128, 3));

    expect((await adapter.send(finalWith([{ kind: 'video', path: file }], ''))).status).toBe('sent');

    expect(probe.transcodeCalls).toBe(0); // mp4 / h264 / aac / 720p / 4.2s：再转一遍只会掉画质
    expect(probe.posterCalls).toBe(1);
    expect(probe.posterSeconds).toEqual([1]); // 首帧常是黑场，取第 1 秒
    expect(server.uploads).toHaveLength(2); // 封面 + 视频
    const sent = server.richMessages[0].body as Record<string, Record<string, unknown>>;
    expect(sent['payload']).toMatchObject({ width: 1280, height: 720, duration_ms: 4200 });
    expect(typeof sent['payload']['poster_asset_id']).toBe('string');
    expect(sent['body']).toBeUndefined(); // 没截断就不该多出一句话
  });

  it('没有 ffmpeg：视频照发（无封面无时长）并在日志里响一声；语音**不发**，改回一句人话', async () => {
    probe = stubProbe({ ffmpeg: false });
    const adapter = makeAdapter();
    const video = writeFile('clip.mp4', Buffer.alloc(128, 3));
    const voice = writeFile('note.m4a', Buffer.alloc(128, 4));

    expect((await adapter.send(finalWith([{ kind: 'video', path: video }], ''))).status).toBe('sent');
    const videoPayload = (server.richMessages[0].body as Record<string, Record<string, unknown>>)['payload'];
    expect(videoPayload['poster_asset_id']).toBeUndefined();
    expect(videoPayload['duration_ms']).toBeUndefined();
    expect(log.find(/video without ffmpeg/)).toHaveLength(1);

    const before = server.richMessages.length;
    const receipt = await adapter.send(finalWith([{ kind: 'audio', path: voice }], '这段录音', '0198f4c1-1111-7000-8000-000000000002'));
    expect(receipt.status).toBe('sent');
    expect(server.richMessages).toHaveLength(before); // 一条 voice 都没发
    const notice = server.messages.at(-1)!.body;
    expect(notice).toContain('这段录音');
    expect(notice).toContain('ffprobe');
    expect(notice).toContain(voice);
  });

  it('语音：有时长 → kind=voice 带 duration_ms', async () => {
    probe = stubProbe({ av: conformingAv({ width: null, height: null, durationMs: 3300, videoCodec: null }) });
    const adapter = makeAdapter();
    const voice = writeFile('note.m4a', Buffer.alloc(128, 4));

    expect((await adapter.send(finalWith([{ kind: 'audio', path: voice }], ''))).status).toBe('sent');
    expect(server.richMessages[0].body).toMatchObject({ kind: 'voice' });
    expect((server.richMessages[0].body as Record<string, Record<string, unknown>>)['payload']).toMatchObject({ duration_ms: 3300 });
  });

  it('卡片：kind=playable_card 带 content_id 与 launch_ctx', async () => {
    server.seedContent('cnt_live');
    const adapter = makeAdapter();

    expect((await adapter.send(finalWith([{ kind: 'card', contentId: 'cnt_live', launchCtx: { room: 'ABCD' } }], '来一局'))).status).toBe('sent');
    expect(server.richMessages[0].body).toMatchObject({ kind: 'playable_card', content_id: 'cnt_live', launch_ctx: { room: 'ABCD' } });
    expect(server.uploads).toHaveLength(0);
  });

  it('卡片 404 content_not_found → 不当失败重投，改回一句"请用 --visibility public 重新发布"', async () => {
    const adapter = makeAdapter();

    const receipt = await adapter.send(finalWith([{ kind: 'card', contentId: 'cnt_private' }], '看看这个'));

    expect(receipt.status).toBe('sent'); // 整条 final 算发出去了：重投它没有意义
    const text = server.messages.at(-1)!.body;
    expect(text).toContain('看看这个');
    expect(text).toContain('visibility public');
  });

  it('超过出站上限 → 不读进内存、不上传，回一句人话（Agent 一句标记不该能撑爆 daemon）', async () => {
    const adapter = makeAdapter({ maxUploadBytes: 64 });
    const file = writeFile('big.png', Buffer.concat([pngOf(2, 3), Buffer.alloc(4096, 1)]));

    expect((await adapter.send(finalWith([{ kind: 'image', path: file }], ''))).status).toBe('sent');
    expect(server.uploads).toHaveLength(0);
    expect(server.messages.at(-1)!.body).toContain('太大发不了');
    expect(log.find(/attachment too large/)).toHaveLength(1);
  });

  it('附件不存在 → 一句人话，不炸也不重投', async () => {
    const adapter = makeAdapter();
    expect((await adapter.send(finalWith([{ kind: 'image', path: path.join(dir, 'nope.png') }], ''))).status).toBe('sent');
    expect(server.messages.at(-1)!.body).toContain('读不到');
  });

  it('幂等：同一条 final 重投 → client_msg_id 不变，平台上仍然只有一条消息', async () => {
    const adapter = makeAdapter();
    const file = writeFile('a.png', pngOf(2, 3));

    await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));
    await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));

    expect(server.messages.filter((m) => m.clientMsgId === attachmentClientMsgId(MSG, 0))).toHaveLength(1);
    expect(server.messages.filter((m) => m.clientMsgId === MSG)).toHaveLength(1);
  });

  it('上传成功但发送失败的重投**不重复上传**（asset 缓存）', async () => {
    const adapter = makeAdapter();
    const file = writeFile('a.png', pngOf(2, 3));
    server.failNextSend({ status: 503, code: 'unavailable' });

    const first = await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));
    expect(first).toMatchObject({ status: 'retryable' });
    expect(server.uploads).toHaveLength(1);

    const second = await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));
    expect(second.status).toBe('sent');
    expect(server.uploads).toHaveLength(1); // 第二次直接用缓存里的 asset_id
    expect(log.find(/asset cache hit/)).toHaveLength(1);
  });

  it('上传 429 → retryable 并带上 Retry-After；415 → permanent-failure（重投一万次也一样）', async () => {
    const adapter = makeAdapter();
    const file = writeFile('a.png', pngOf(2, 3));

    server.failNextUpload({ status: 429, code: 'rate_limited', retryAfterSec: 7 });
    expect(await adapter.send(finalWith([{ kind: 'image', path: file }], 'x'))).toEqual({ status: 'retryable', code: 'rate_limited', retryAfterMs: 7000 });

    server.failNextUpload({ status: 415, code: 'unsupported_media_type' });
    expect(await adapter.send(finalWith([{ kind: 'image', path: file }], 'x'))).toEqual({ status: 'permanent-failure', code: 'unsupported_media_type' });
  });

  it('多条附件按顺序发，client_msg_id 各不相同', async () => {
    server.seedContent('cnt_live');
    const adapter = makeAdapter();
    const a = writeFile('a.png', pngOf(2, 3));
    const b = writeFile('b.png', pngOf(4, 5));

    await adapter.send(
      finalWith([
        { kind: 'image', path: a },
        { kind: 'image', path: b },
        { kind: 'card', contentId: 'cnt_live' },
      ]),
    );

    expect(server.messages.map((m) => m.clientMsgId)).toEqual([
      attachmentClientMsgId(MSG, 0),
      attachmentClientMsgId(MSG, 1),
      attachmentClientMsgId(MSG, 2),
      MSG,
    ]);
  });

  it('只有附件、没有正文时不发空文本消息', async () => {
    const adapter = makeAdapter();
    const file = writeFile('a.png', pngOf(2, 3));

    await adapter.send(finalWith([{ kind: 'image', path: file }], ''));

    expect(server.messages).toHaveLength(1);
    expect(server.messages[0].clientMsgId).toBe(attachmentClientMsgId(MSG, 0));
  });

});

// ---------------------------------------------------------------------------

describe('waku-dm · 出站视频默认可播', () => {
  /**
   * 为什么默认要转：客户端能稳定播的是 ≤60s / ≤720p / h264+aac / faststart 的 mp4，平台后端
   * **不转码**。Agent 产出的视频五花八门（录屏 hevc、4K、webm、裸流），默认原样发的结果是
   * 用户点开一个转圈圈——而那在用户那端没有任何补救办法。
   */
  it.each([
    ['视频编码不是 h264', conformingAv({ videoCodec: 'hevc' }), 'clip.mp4'],
    ['分辨率超 720p', conformingAv({ width: 3840, height: 2160 }), 'clip.mp4'],
    ['容器不是 mp4', conformingAv(), 'clip.mov'],
    ['ffprobe 探不出来', null, 'clip.mp4'],
  ])('%s → 默认就转（不用等用户设 env）', async (_label, av, name) => {
    probe = stubProbe({ av, transcodedAv: conformingAv() });
    const adapter = makeAdapter();
    const file = writeFile(name, Buffer.alloc(128, 3));

    expect((await adapter.send(finalWith([{ kind: 'video', path: file }], ''))).status).toBe('sent');

    expect(probe.transcodeCalls).toBe(1);
    expect(probe.transcodeSeconds).toEqual([DEFAULT_MAX_VIDEO_SECONDS]);
    // 上传的是转码产物，不是源文件
    expect(server.uploads.map((u) => u.filename)).toContain(
      path.basename(fs.readdirSync(path.join(dir, 'outbound')).find((f) => f.startsWith('transcode-'))!),
    );
  });

  it('WAKU_DM_VIDEO_TRANSCODE=0 → 一律不转，原样发（用户显式要求，不自作主张）', async () => {
    probe = stubProbe({ av: conformingAv({ videoCodec: 'hevc', durationMs: 600_000 }) });
    const adapter = makeAdapter({ transcodeVideo: false });
    const file = writeFile('clip.mov', Buffer.alloc(128, 3));

    expect((await adapter.send(finalWith([{ kind: 'video', path: file }], ''))).status).toBe('sent');
    expect(probe.transcodeCalls).toBe(0);
    expect((server.richMessages[0].body as Record<string, unknown>)['body']).toBeUndefined();
  });

  it('超 60s：截断并**在正文里说一句**（不说的话用户以为视频丢了一半）', async () => {
    probe = stubProbe({
      av: conformingAv({ durationMs: 90_000 }),
      transcodedAv: conformingAv({ durationMs: 60_000 }),
    });
    const adapter = makeAdapter();
    const file = writeFile('long.mp4', Buffer.alloc(128, 3));

    expect((await adapter.send(finalWith([{ kind: 'video', path: file, caption: '看这个' }], ''))).status).toBe('sent');

    const sent = server.richMessages[0].body as Record<string, Record<string, unknown>>;
    // payload 描述的是**发出去的那个文件**，所以时长是转码后的 60s，不是源的 90s
    expect(sent['payload']).toMatchObject({ duration_ms: 60_000 });
    const body = String(sent['body']);
    expect(body).toContain('看这个'); // caption 还在
    expect(body).toContain('1:30'); // 原时长
    expect(body).toContain('60s'); // 只发了这么多
  });

  it('转码失败 → 原样发并在日志里响一声（发不出去比画质差更糟）', async () => {
    probe = stubProbe({ av: conformingAv({ videoCodec: 'hevc' }), transcodeFails: true });
    const adapter = makeAdapter();
    const file = writeFile('clip.mp4', Buffer.alloc(128, 3));

    expect((await adapter.send(finalWith([{ kind: 'video', path: file }], ''))).status).toBe('sent');
    expect(probe.transcodeCalls).toBe(1);
    expect(server.uploads.map((u) => u.filename)).toContain('clip.mp4');
    expect(log.find(/video transcode failed/)).toHaveLength(1);
  });

  it('转码产物按**源文件**做缓存 key：重投不会把刚转好的视频再传一遍', async () => {
    probe = stubProbe({ av: conformingAv({ videoCodec: 'hevc' }), transcodedAv: conformingAv() });
    const adapter = makeAdapter();
    const file = writeFile('clip.mp4', Buffer.alloc(128, 3));
    server.failNextSend({ status: 503, code: 'unavailable' });

    expect(await adapter.send(finalWith([{ kind: 'video', path: file }], 'x'))).toMatchObject({ status: 'retryable' });
    const afterFirst = server.uploads.length; // 封面 + 转码视频

    expect((await adapter.send(finalWith([{ kind: 'video', path: file }], 'x'))).status).toBe('sent');

    // 转码会再跑一次（产物 mtime 变了），但**上传**必须命中缓存——key 算的是源文件，不是产物。
    expect(server.uploads).toHaveLength(afterFirst);
    expect(log.find(/asset cache hit/).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------

describe('waku-dm · 出站文件 = 一条公开链接', () => {
  /**
   * Waku 私聊没有 `file` kind，也不为此新增（要动三端渲染 + 通知摘要 + 会话预览）。
   * 走法是：传上传门拿 public_url → 发一条 `kind=text`：`📎 名字（大小）\n<url>`。
   */
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'utf8'), Buffer.alloc(64, 1)]);
  const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 2)]);

  it.each([
    ['report.pdf', PDF, 'application/pdf'],
    ['bundle.zip', ZIP, 'application/zip'],
    ['notes.txt', Buffer.from('一段中文说明\n', 'utf8'), 'text/plain'],
    ['AGENTS.md', Buffer.from('# title\n', 'utf8'), 'text/markdown'],
    ['rows.csv', Buffer.from('a,b\n1,2\n', 'utf8'), 'text/csv'],
    ['data.json', Buffer.from('{"ok":true}', 'utf8'), 'application/json'],
  ])('%s → 上传（mime 对）+ 一条 text 消息带 📎 与可点的 URL', async (name, bytes, mime) => {
    const adapter = makeAdapter();
    const file = writeFile(name, bytes);

    expect((await adapter.send(finalWith([{ kind: 'file', path: file }], ''))).status).toBe('sent');

    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0]).toMatchObject({ route: '/agent-bridges/me/assets', filename: name, mime, by: PERSONA });
    const body = String(server.messages[0].body);
    expect(server.messages[0].clientMsgId).toBe(attachmentClientMsgId(MSG, 0));
    expect(body).toContain(`📎 ${name}`);
    expect(body).toContain(server.uploads[0].assetId); // public_url 里带 asset id
    expect(body).toMatch(/https?:\/\//);
    // 发的是 text，不是硬塞成图片
    expect(server.richMessages).toHaveLength(0);
  });

  it('caption 顶在链接前面', async () => {
    const adapter = makeAdapter();
    const file = writeFile('report.pdf', PDF);

    await adapter.send(finalWith([{ kind: 'file', path: file, caption: '这是刚跑出来的报告' }], ''));

    expect(String(server.messages[0].body)).toMatch(/^这是刚跑出来的报告\n📎 report\.pdf/);
  });

  it.each([['x.html'], ['x.svg'], ['run.py'], ['a.bin'], ['noext']])(
    '%s：扩展名不在平台白名单 → 不上传（不烧配额、不烧带宽），回一句人话',
    async (name) => {
      const adapter = makeAdapter();
      const file = writeFile(name, Buffer.from('<html><script>alert(1)</script>', 'utf8'));

      expect((await adapter.send(finalWith([{ kind: 'file', path: file }], ''))).status).toBe('sent');
      expect(server.uploads).toHaveLength(0);
      const notice = server.messages.at(-1)!.body;
      expect(notice).toContain(file);
      expect(notice).toContain('发不了');
    },
  );

  it.each([
    ['扩展名 .pdf 但内容是 PNG', 'fake.pdf', () => pngOf(2, 3)],
    ['扩展名 .txt 但内容含 NUL', 'fake.txt', () => Buffer.from([0x68, 0x00, 0x69])],
    ['扩展名 .zip 但内容不是 zip', 'fake.zip', () => Buffer.from('not a zip at all', 'utf8')],
  ])('%s → 本机就拦下，不上传', async (_label, name, make) => {
    const adapter = makeAdapter();
    const file = writeFile(name, make());

    expect((await adapter.send(finalWith([{ kind: 'file', path: file }], ''))).status).toBe('sent');
    expect(server.uploads).toHaveLength(0);
    expect(server.messages.at(-1)!.body).toContain(file);
    expect(log.find(/content does not match/)).toHaveLength(1);
  });

  it('平台 415（本机这张表比平台宽了）→ 降级成同一句人话，不是 permanent-failure', async () => {
    const adapter = makeAdapter();
    const file = writeFile('report.pdf', PDF);
    server.failNextUpload({ status: 415, code: 'agent_bridge_asset_mime_rejected' });

    // 整条 final 算发出去了：这条重投一万次也一样，但用户必须看到那句话
    expect((await adapter.send(finalWith([{ kind: 'file', path: file }], ''))).status).toBe('sent');
    expect(server.messages.at(-1)!.body).toContain(file);
    expect(log.find(/rejected by the platform \(415/)).toHaveLength(1);
  });

  it('上传成功、发消息失败的重投**不重复上传**——URL 也走缓存', async () => {
    const adapter = makeAdapter();
    const file = writeFile('report.pdf', PDF);
    server.failNextSend({ status: 503, code: 'unavailable' });

    expect(await adapter.send(finalWith([{ kind: 'file', path: file }], 'x'))).toMatchObject({ status: 'retryable' });
    expect(server.uploads).toHaveLength(1);

    expect((await adapter.send(finalWith([{ kind: 'file', path: file }], 'x'))).status).toBe('sent');
    expect(server.uploads).toHaveLength(1);
    // 附件那条的 client_msg_id 固定，重投不会在屏幕上留下第二条
    const link = server.messages.filter((m) => m.clientMsgId === attachmentClientMsgId(MSG, 0));
    expect(link).toHaveLength(1);
    expect(String(link[0].body)).toContain('📎 report.pdf');
  });

  it('.log 这类「不像文档」的扩展名也在表里（text/plain）—— agent 最常想发的就是日志', async () => {
    const adapter = makeAdapter();
    const file = writeFile('run.log', Buffer.from('line one\nline two\n', 'utf8'));

    await adapter.send(finalWith([{ kind: 'file', path: file }], ''));

    expect(server.uploads[0]).toMatchObject({ filename: 'run.log', mime: 'text/plain' });
    expect(String(server.messages[0].body)).toContain('📎 run.log');
  });
});

describe('waku-dm · 本机内部错误不许被吞成 send_failed', () => {
  /** 线上真实形态：老库没跑到建 asset_uploads 的 migration，缓存查询当场抛 sqlite 错误。 */
  function throwingCache(error: unknown): AssetUploadCache {
    return {
      get: () => {
        throw error;
      },
      set: () => undefined,
    };
  }

  it('缓存查询自己炸了 → 日志留下原始 message，code 带上错误标签（不再只剩 send_failed）', async () => {
    const adapter = makeAdapter({ cache: throwingCache(new Error('no such table: asset_uploads')) });
    const file = writeFile('a.png', pngOf(2, 3));

    const receipt = await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));

    expect(receipt).toEqual({ status: 'unknown', code: 'attachment_internal:Error' });
    // 上传都没走到：这不是"平台拒了"，是我们自己炸了
    expect(server.uploads).toHaveLength(0);
    // 附件层记一行原始错误
    expect(log.find(/attachment internal error: no such table: asset_uploads/)).toHaveLength(1);
    // 适配层那行也不能再只剩一个 code —— 运维只看得到这一行
    const adapterLine = log.find(/send failed .*attachment=1\/1 \(image\)/);
    expect(adapterLine).toHaveLength(1);
    expect(adapterLine[0]).toContain('attachment_internal:Error');
    expect(adapterLine[0]).toContain('no such table: asset_uploads');
  });

  it('带 code 的内部错误用 code 当标签（sqlite 的 name 一律是 Error，认不出东西）', async () => {
    const sqliteish = Object.assign(new Error('no such table: asset_uploads'), { code: 'ERR_SQLITE_ERROR' });
    const adapter = makeAdapter({ cache: throwingCache(sqliteish) });
    const file = writeFile('a.png', pngOf(2, 3));

    const receipt = await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));

    expect(receipt).toEqual({ status: 'unknown', code: 'attachment_internal:ERR_SQLITE_ERROR' });
    expect(log.find(/no such table: asset_uploads/).length).toBeGreaterThan(0);
  });

  it('message 截断到 300 字：留证据，但别把一整篇 stack 灌进日志', async () => {
    const adapter = makeAdapter({ cache: throwingCache(new Error('y'.repeat(1000))) });
    const file = writeFile('a.png', pngOf(2, 3));

    await adapter.send(finalWith([{ kind: 'image', path: file }], '看这个'));

    const line = log.find(/attachment internal error/)[0];
    expect(line).toContain('y'.repeat(300));
    expect(line).not.toContain('y'.repeat(301));
    expect(line).toContain('…');
  });

  it('平台自己的错误照旧按 HTTP 语义分类，不被内部错误这条路改掉', async () => {
    const adapter = makeAdapter();
    const file = writeFile('a.png', pngOf(2, 3));

    server.failNextUpload({ status: 415, code: 'unsupported_media_type' });
    expect(await adapter.send(finalWith([{ kind: 'image', path: file }], 'x'))).toEqual({
      status: 'permanent-failure',
      code: 'unsupported_media_type',
    });
  });
});

describe('waku-dm · 内部错误描述', () => {
  it('code 与 message 都留；非 Error 也不炸', () => {
    expect(describeInternalError(new Error('boom'))).toBe('boom');
    expect(describeInternalError(Object.assign(new Error('boom'), { code: 'ERR_X' }))).toBe('ERR_X: boom');
    expect(describeInternalError(new Error(''))).toBe('Error');
    expect(describeInternalError('plain string')).toBe('plain string');
    expect(describeInternalError(undefined)).toBe('undefined');
    expect(describeInternalError(new Error('z'.repeat(400)))).toBe(`${'z'.repeat(300)}…`);
  });

  it('回执 code 的标签只留安全字符，且不会长到污染日志', () => {
    expect(internalFailureCode(new Error('x'))).toBe('attachment_internal:Error');
    expect(internalFailureCode(Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR' }))).toBe(
      'attachment_internal:ERR_SQLITE_ERROR',
    );
    expect(internalFailureCode('nope')).toBe('attachment_internal:string');
    expect(internalFailureCode(Object.assign(new Error('x'), { code: 'a b/c\nd' }))).toBe('attachment_internal:a_b_c_d');
    expect(internalFailureCode(Object.assign(new Error('x'), { code: 'E'.repeat(200) })).length).toBeLessThanOrEqual(
      'attachment_internal:'.length + 48,
    );
  });
});

describe('waku-dm · 上传路由按身份分家', () => {
  it('session 模式（真账号）走 /assets，不是 /agent-bridges/me/assets', async () => {
    const authPath = path.join(dir, 'auth.json');
    const sessionToken = server.issueSessionToken(OWNER);
    fs.writeFileSync(authPath, JSON.stringify({ user_id: OWNER, api_base: server.apiBase, session_token: sessionToken, refresh_token: 'rt_1' }), { mode: 0o600 });
    server.seedRefreshToken('rt_1', OWNER);
    server.seedDm(CONV, OWNER);

    const tokens = createSessionCredentialProvider({ authPath, apiBase: server.apiBase });
    const adapter = makeAdapter({ tokens });
    const file = writeFile('a.png', pngOf(2, 3));

    expect((await adapter.send(finalWith([{ kind: 'image', path: file }], 'x'))).status).toBe('sent');
    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0].route).toBe('/assets');
    expect(server.uploads[0].by).toBe(OWNER);
  });
});

describe('waku-dm · 图片头解析', () => {
  it('PNG / GIF / JPEG / WEBP 的宽高', () => {
    expect(readImageDimensions(pngOf(1920, 1080))).toEqual({ width: 1920, height: 1080 });

    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0);
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(readImageDimensions(gif)).toEqual({ width: 320, height: 240 });

    // JPEG: SOI + APP0(len 4) + SOF0(len 11, prec, h, w, comps)
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0x01, 0x00]),
    ]);
    expect(readImageDimensions(jpeg)).toEqual({ width: 800, height: 600 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8X', 12);
    webp.writeUIntLE(1023, 24, 3);
    webp.writeUIntLE(767, 27, 3);
    expect(readImageDimensions(webp)).toEqual({ width: 1024, height: 768 });

    expect(readImageDimensions(Buffer.from('not an image'))).toEqual({ width: null, height: null });
  });
});
