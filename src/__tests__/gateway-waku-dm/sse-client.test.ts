/**
 * waku-dm · SSE 客户端（RED）
 *
 * 契约 §3.3：`GET {API_BASE}/users/me/events`，Node 22 全局 fetch + ReadableStream 逐行解析；
 * 帧 = `id: <user_seq>\nevent: <name>\ndata: <单行 JSON>\n\n`；`: keepalive` 注释行 ≈ 每秒一条；
 * 30s 无任何字节 → 判死重连；正常 EOF → 重连；401 → 换 token 再连；其它错误指数退避（2s → 60s）。
 *
 * 传输层全用真 `node:http`（FakeBridgeServer）：断流 / 挂起 / 401 都是真的网络行为，
 * 不是对 fetch 的 mock。超时阈值通过选项缩短，测试不 sleep 猜时间，用 waitFor 等条件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSseParser, createSseSubscription, type SseFrame, type SseSubscription } from '../../gateway/channels/waku-dm/sse-client.js';
import { FakeBridgeServer, RecordingLogger, waitFor, sleep } from './fake-bridge-server.js';

const PERSONA = 'usr_persona_000000000000000000001';
const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';

// ---------------------------------------------------------------------------
// 纯解析器
// ---------------------------------------------------------------------------

describe('waku-dm · SSE 帧解析（单行 data 契约）', () => {
  it('标准帧：id / event / data 三行 + 空行结帧，data 原样保留（不二次解析）', () => {
    const parser = createSseParser();
    const frames = parser.feed('id: 7\nevent: chat.message\ndata: {"id":"cmsg_1","body":"hi"}\n\n');
    expect(frames).toEqual<SseFrame[]>([
      { id: '7', event: 'chat.message', data: '{"id":"cmsg_1","body":"hi"}' },
    ]);
  });

  it('注释行（`: keepalive` / `: replay-mode=…`）不产帧；跨 chunk 撕裂的帧能拼回来；CRLF 也认', () => {
    const parser = createSseParser();
    expect(parser.feed(': replay-mode=filtered\n\n: keepalive\n\n')).toEqual([]);
    expect(parser.feed('id: 8\r\nevent: chat.re')).toEqual([]);
    expect(parser.feed('ad\r\ndata: {"conv')).toEqual([]);
    const frames = parser.feed('ersation_id":"conv_1"}\r\n\r\nid: 9\nevent: x\ndata: {}\n\n');
    expect(frames).toEqual<SseFrame[]>([
      { id: '8', event: 'chat.read', data: '{"conversation_id":"conv_1"}' },
      { id: '9', event: 'x', data: '{}' },
    ]);
  });

  it('缺 event 按规范回落 message，缺 id 为 null；多行 data 按规范用 \\n 拼接（契约说只有单行，但解析器不得因此吞行）', () => {
    const parser = createSseParser();
    const frames = parser.feed('data: a\ndata: b\n\nid: 3\ndata:no-space\n\n');
    expect(frames).toEqual<SseFrame[]>([
      { id: null, event: 'message', data: 'a\nb' },
      { id: '3', event: 'message', data: 'no-space' },
    ]);
  });

  it('没有 data 行的块不产帧（规范：dispatch 时 data buffer 为空就丢弃）', () => {
    const parser = createSseParser();
    expect(parser.feed('id: 4\nevent: ping\n\n')).toEqual([]);
    expect(parser.flush()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 真传输
// ---------------------------------------------------------------------------

interface Harness {
  server: FakeBridgeServer;
  token: string;
  headersCalls: number;
  authRejected: number;
  frames: SseFrame[];
  lastId: string | null;
  log: RecordingLogger;
  sub: SseSubscription | null;
  onFrame: (frame: SseFrame) => Promise<void>;
}

let h: Harness;

beforeEach(async () => {
  const server = new FakeBridgeServer({ personaUserId: PERSONA, ownerUserId: OWNER, keepaliveMs: 50 });
  await server.start();
  h = {
    server,
    token: server.issueSessionToken(PERSONA),
    headersCalls: 0,
    authRejected: 0,
    frames: [],
    lastId: null,
    log: new RecordingLogger(),
    sub: null,
    onFrame: async (frame) => {
      h.frames.push(frame);
      if (frame.id !== null) h.lastId = frame.id;
    },
  };
});

afterEach(async () => {
  await h.sub?.stop();
  await h.server.close();
});

function subscribe(overrides: Partial<Parameters<typeof createSseSubscription>[0]> = {}): SseSubscription {
  const sub = createSseSubscription({
    url: `${h.server.apiBase}/users/me/events`,
    headers: async () => {
      h.headersCalls += 1;
      return { Authorization: `Bearer ${h.token}` };
    },
    lastEventId: () => h.lastId,
    onFrame: (frame) => h.onFrame(frame),
    onAuthRejected: () => {
      h.authRejected += 1;
    },
    log: h.log,
    idleTimeoutMs: 400,
    backoff: { baseMs: 40, maxMs: 160 },
    reconnectDelayMs: 20,
    ...overrides,
  });
  h.sub = sub;
  sub.start();
  return sub;
}

describe('waku-dm · SSE 订阅（真 http）', () => {
  it('首连不带 Last-Event-ID；帧按序到达，注释行不产帧', async () => {
    subscribe();
    await waitFor(() => h.server.liveConnectionCount === 1, { label: 'connected' });
    h.server.emit('chat.message', { id: 'cmsg_1' });
    h.server.emit('chat.read', { conversation_id: 'conv_1' });
    await waitFor(() => h.frames.length === 2, { label: 'two frames' });

    expect(h.server.sseConnections[0].lastEventId).toBeNull();
    expect(h.frames.map((f) => [f.id, f.event])).toEqual([
      ['1', 'chat.message'],
      ['2', 'chat.read'],
    ]);
    expect(h.sub!.stats().state).toBe('open');
    expect(h.sub!.stats().lastEventAt).not.toBeNull();
  });

  it('断流后自动重连，并带上 Last-Event-ID=最后消费的 user_seq；漏掉的帧由服务端补发', async () => {
    subscribe();
    await waitFor(() => h.server.liveConnectionCount === 1);
    h.server.emit('chat.message', { id: 'cmsg_1' });
    await waitFor(() => h.frames.length === 1);

    h.server.dropConnections();
    // 断线期间发的帧
    h.server.emit('chat.message', { id: 'cmsg_2' });
    await waitFor(() => h.server.sseConnections.length === 2, { label: 'reconnected' });
    await waitFor(() => h.frames.length === 2, { label: 'missed frame replayed' });

    expect(h.server.sseConnections[1].lastEventId).toBe('1');
    expect(h.frames[1].id).toBe('2');
    expect(h.sub!.stats().reconnects).toBeGreaterThanOrEqual(1);
    // 四件套之三：SSE 重连/错误必须有日志
    expect(h.log.find(/sse/i).length).toBeGreaterThan(0);
  });

  it('连接打开后 idleTimeoutMs 内一个字节都没有 → 判死重连', async () => {
    h.server.sseMode = 'hang';
    subscribe({ idleTimeoutMs: 150 });
    await waitFor(() => h.server.sseConnections.length >= 3, { timeoutMs: 3_000, label: 'idle reconnects' });
    expect(h.sub!.stats().reconnects).toBeGreaterThanOrEqual(2);
  });

  it('连响应头都不给（TCP 通了但服务端不说话）同样受 idle 看门狗管', async () => {
    h.server.sseMode = 'hang-headers';
    subscribe({ idleTimeoutMs: 150 });
    await waitFor(() => h.server.sseConnections.length >= 2, { timeoutMs: 3_000, label: 'header-hang reconnect' });
  });

  it('401 → 通知凭证失效（onAuthRejected）并用新 header 重连', async () => {
    h.server.failNextSse(401);
    subscribe();
    await waitFor(() => h.authRejected === 1, { label: 'auth rejected' });
    // 模拟 provider 换出新 token
    h.token = h.server.issueSessionToken(PERSONA);
    await waitFor(() => h.server.liveConnectionCount === 1, { timeoutMs: 3_000, label: 'reconnected after 401' });
    expect(h.headersCalls).toBeGreaterThanOrEqual(2);
    expect(h.server.sseConnections.at(-1)?.authorization).toBe(`Bearer ${h.token}`);
  });

  it('5xx → 指数退避再连（不打爆服务端），成功收帧后失败计数归零', async () => {
    h.server.failNextSse(500, 2);
    const startedAt = Date.now();
    subscribe({ backoff: { baseMs: 60, maxMs: 500 } });
    await waitFor(() => h.server.liveConnectionCount === 1, { timeoutMs: 3_000, label: 'eventually connected' });
    // 两次失败：至少等了 60 + 120 ms 才成功
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(h.server.sseConnections.length).toBe(3);
    h.server.emit('chat.message', { id: 'x' });
    await waitFor(() => h.frames.length === 1);
    expect(h.sub!.stats().consecutiveFailures).toBe(0);
    expect(h.log.find(/sse/i).length).toBeGreaterThan(0);
  });

  it('onFrame 抛错 = sink 故障：该帧不算消费、连接重建后同一帧重投（游标不前进）', async () => {
    let failOnce = true;
    h.onFrame = async (frame) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('store closed');
      }
      h.frames.push(frame);
      if (frame.id !== null) h.lastId = frame.id;
    };
    subscribe();
    await waitFor(() => h.server.liveConnectionCount === 1);
    h.server.emit('chat.message', { id: 'cmsg_1' });
    await waitFor(() => h.frames.length === 1, { timeoutMs: 3_000, label: 'redelivered' });
    expect(h.frames[0].id).toBe('1');
    expect(h.server.sseConnections.length).toBe(2);
    expect(h.server.sseConnections[1].lastEventId).toBeNull(); // 没消费成功就不带游标
    expect(h.log.find(/sink|frame/i).length).toBeGreaterThan(0);
  });

  it('stop() 立刻断开并不再重连', async () => {
    const sub = subscribe();
    await waitFor(() => h.server.liveConnectionCount === 1);
    await sub.stop();
    await waitFor(() => h.server.liveConnectionCount === 0, { label: 'closed' });
    await sleep(150);
    expect(h.server.sseConnections.length).toBe(1);
    expect(sub.stats().state).toBe('stopped');
  });
});
