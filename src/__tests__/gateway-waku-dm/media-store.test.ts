/**
 * waku-dm · 入站媒体落盘：三道闸（体积 / 时限 / TTL）、扩展名判定、失败不丢消息。
 *
 * 用真 `node:http` 服务器（FakeBridgeServer 的 `/blobs/*`）+ 真磁盘：
 * "边读边数字节然后掐断"这种行为只有在真流上才是真的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMediaStore, sniffExtension, type MediaStore } from '../../gateway/channels/waku-dm/media-store.js';
import { FakeBridgeServer, RecordingLogger, waitFor } from './fake-bridge-server.js';

const CONV = 'conv_01J0000000000000000000001';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);

let dir: string;
let server: FakeBridgeServer;
let log: RecordingLogger;
let store: MediaStore;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-media-'));
  server = new FakeBridgeServer({ personaUserId: 'usr_persona', ownerUserId: 'usr_owner' });
  await server.start();
  log = new RecordingLogger();
  store = createMediaStore({
    rootDir: path.join(dir, 'media'),
    log,
    limits: { imageMaxBytes: 1024, mediaMaxBytes: 4096, timeoutMs: 2_000, ttlMs: 50, sweepIntervalMs: 60_000 },
  });
});

afterEach(async () => {
  store.stop();
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('waku-dm · 入站媒体落盘', () => {
  it('落到 <root>/<conv>/<messageId>-<idx>.<ext>，扩展名按 Content-Type 定', async () => {
    const url = server.seedBlob('a.bin', PNG, { contentType: 'image/png' });
    const saved = await store.download({ conversationId: CONV, messageId: 'cmsg_1', index: 0, url, kind: 'image' });

    expect(saved).toBe(path.join(dir, 'media', CONV, 'cmsg_1-0.png'));
    expect(fs.readFileSync(saved as string)).toEqual(PNG);
    // 0600/0700：媒体是别人发来的内容，不给同机其它用户看。
    expect(fs.statSync(saved as string).mode & 0o077).toBe(0);
  });

  it('没有 Content-Type 时按魔数判扩展名', async () => {
    const url = server.seedBlob('b.bin', JPEG);
    const saved = await store.download({ conversationId: CONV, messageId: 'cmsg_2', index: 1, url, kind: 'image' });
    expect(path.extname(saved as string)).toBe('.jpg');
  });

  it('魔数也认不出时按 kind 兜底', async () => {
    const url = server.seedBlob('c.bin', Buffer.from('not a real media file'));
    expect(path.extname((await store.download({ conversationId: CONV, messageId: 'm1', index: 0, url, kind: 'voice' })) as string)).toBe('.m4a');
    expect(path.extname((await store.download({ conversationId: CONV, messageId: 'm2', index: 0, url, kind: 'video' })) as string)).toBe('.mp4');
  });

  it('闸一：声明的 Content-Length 超限 → 一个字节都不读就拒，返回 null', async () => {
    const url = server.seedBlob('big.png', Buffer.alloc(2048, 1), { contentType: 'image/png' });
    const saved = await store.download({ conversationId: CONV, messageId: 'cmsg_big', index: 0, url, kind: 'image' });

    expect(saved).toBeNull();
    expect(log.find(/media too large/)).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'media', CONV))).toBe(false);
  });

  it('闸一（续）：不声明长度时边读边数，超限即掐断且不留半截文件', async () => {
    const url = server.seedBlob('sneaky.png', Buffer.alloc(2048, 1), { contentType: 'image/png', declareLength: false });
    const saved = await store.download({ conversationId: CONV, messageId: 'cmsg_sneaky', index: 0, url, kind: 'image' });

    expect(saved).toBeNull();
    expect(log.find(/media too large/)).toHaveLength(1);
    const leftovers = fs.existsSync(path.join(dir, 'media', CONV)) ? fs.readdirSync(path.join(dir, 'media', CONV)) : [];
    expect(leftovers).toEqual([]);
  });

  it('图片与音视频各有各的上限（1KiB / 4KiB）', async () => {
    const url = server.seedBlob('mid.mp4', Buffer.alloc(2048, 2), { contentType: 'video/mp4' });
    expect(await store.download({ conversationId: CONV, messageId: 'v1', index: 0, url, kind: 'video' })).not.toBeNull();
    expect(await store.download({ conversationId: CONV, messageId: 'v2', index: 0, url, kind: 'image' })).toBeNull();
  });

  it('下载失败（404 / 连不上）→ null + 一行错误日志，不抛（调用方要降级成 [Image]）', async () => {
    expect(await store.download({ conversationId: CONV, messageId: 'x1', index: 0, url: server.blobUrl('missing'), kind: 'image' })).toBeNull();
    expect(await store.download({ conversationId: CONV, messageId: 'x2', index: 0, url: 'http://127.0.0.1:1/nope', kind: 'image' })).toBeNull();
    expect(log.find(/media download failed/).length).toBeGreaterThanOrEqual(2);
  });

  it('闸三：TTL 到期的文件被 sweep 清掉，空目录一并删；没到期的留着', async () => {
    const url = server.seedBlob('keep.png', PNG, { contentType: 'image/png' });
    const stale = (await store.download({ conversationId: CONV, messageId: 'old', index: 0, url, kind: 'image' })) as string;
    const fresh = (await store.download({ conversationId: 'conv_fresh', messageId: 'new', index: 0, url, kind: 'image' })) as string;

    // 把一份的 mtime 拨回过去（TTL=50ms）
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, past, past);

    expect(store.sweep()).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'media', CONV))).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('start() 立刻扫一次，并起周期任务（stop 后不再扫）', async () => {
    const url = server.seedBlob('sweepme.png', PNG, { contentType: 'image/png' });
    const file = (await store.download({ conversationId: CONV, messageId: 'sw', index: 0, url, kind: 'image' })) as string;
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);

    store.start();
    await waitFor(() => !fs.existsSync(file), { label: 'swept at startup' });
    store.stop();
  });

  it('文件名里的怪字符不落到磁盘路径上', async () => {
    const url = server.seedBlob('ok.png', PNG, { contentType: 'image/png' });
    const saved = (await store.download({
      conversationId: '../../etc',
      messageId: '../passwd',
      index: 0,
      url,
      kind: 'image',
    })) as string;
    expect(saved.startsWith(path.join(dir, 'media'))).toBe(true);
    expect(saved).not.toContain('..');
  });
});

describe('waku-dm · 魔数嗅探', () => {
  it('认识常见容器', () => {
    expect(sniffExtension(PNG, 'image')).toBe('.png');
    expect(sniffExtension(JPEG, 'image')).toBe('.jpg');
    expect(sniffExtension(Buffer.from('GIF89a....'), 'image')).toBe('.gif');
    expect(sniffExtension(Buffer.concat([Buffer.from('RIFF0000WEBP')]), 'image')).toBe('.webp');
    expect(sniffExtension(Buffer.concat([Buffer.from('RIFF0000WAVE')]), 'voice')).toBe('.wav');
    expect(sniffExtension(Buffer.from('0000ftypM4A '), 'voice')).toBe('.m4a');
    expect(sniffExtension(Buffer.from('0000ftypisom'), 'video')).toBe('.mp4');
    expect(sniffExtension(Buffer.from('OggS......'), 'voice')).toBe('.ogg');
    expect(sniffExtension(Buffer.from('ID3......'), 'voice')).toBe('.mp3');
    expect(sniffExtension(Buffer.from('nonsense'), 'image')).toBeNull();
  });
});
