/**
 * waku-dm · 通道适配器（RED）
 *
 * 契约 §3.3 入站过滤与游标、§3.4 出站切片与回执映射、§3.5 心跳与健康。
 * 用真 FakeBridgeServer（node:http）+ 真 SQLite store；sink 是录制替身。
 * 定时类阈值全部缩短并通过选项注入，断言靠 waitFor 等条件，不 sleep 猜时间。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWakuDmAdapter, WAKU_DM_CURSOR_COLLECTION, type WakuDmAdapter } from '../../gateway/channels/waku-dm/adapter.js';
import { createWakuChatClient } from '../../gateway/channels/waku-dm/chat-client.js';
import { createBridgeCredentialProvider, type BridgeTokenProvider } from '../../gateway/channels/waku-dm/credential-provider.js';
import type { DmInboundEnvelope, InboundEnvelope } from '../../gateway/core/ingress.js';
import type { IngressAck } from '../../gateway/contracts/channel.js';
import type { OutboundEnvelope } from '../../gateway/core/delivery.js';
import { openGatewayStore, type GatewayStore } from '../../gateway/state/sqlite-store.js';

import { FakeBridgeServer, RecordingLogger, waitFor, sleep } from './fake-bridge-server.js';

const PERSONA = 'usr_persona_000000000000000000001';
const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';
const OTHER_BOT = 'usr_otherbot_0000000000000000001';
const CONV = 'conv_01J0000000000000000000001';
const CREDENTIAL = 'abc_XfQ1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E0';

interface Fixture {
  dir: string;
  server: FakeBridgeServer;
  store: GatewayStore;
  provider: BridgeTokenProvider;
  log: RecordingLogger;
  envelopes: DmInboundEnvelope[];
  sinkResult: IngressAck | (() => IngressAck);
  sinkThrows: Error | null;
  queues: { running: number; queued: number };
  adapters: WakuDmAdapter[];
}

let f: Fixture;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-adapter-'));
  const server = new FakeBridgeServer({ personaUserId: PERSONA, ownerUserId: OWNER, credential: CREDENTIAL, keepaliveMs: 50 });
  await server.start();
  server.seedDm(CONV, OWNER);
  const credentialFile = path.join(dir, 'bridge.credential');
  fs.writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });
  const store = openGatewayStore({ dbPath: path.join(dir, 'gateway.db'), masterKeyPath: path.join(dir, 'master.key') });
  const provider = createBridgeCredentialProvider({ credentialFile, apiBase: server.apiBase });
  f = {
    dir,
    server,
    store,
    provider,
    log: new RecordingLogger(),
    envelopes: [],
    sinkResult: { status: 'accepted' },
    sinkThrows: null,
    queues: { running: 0, queued: 0 },
    adapters: [],
  };
});

afterEach(async () => {
  for (const adapter of f.adapters) await adapter.stop();
  await f.server.close();
  f.store.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
});

function makeAdapter(overrides: Partial<Parameters<typeof createWakuDmAdapter>[0]> = {}): WakuDmAdapter {
  const chat = createWakuChatClient({ apiBase: f.server.apiBase, tokens: f.provider });
  const adapter = createWakuDmAdapter({
    instanceId: 'waku-dm-test',
    apiBase: f.server.apiBase,
    tokens: f.provider,
    chat,
    store: f.store,
    now: Date.now,
    log: f.log,
    heartbeat: { enabled: true, intervalMs: 150, agentName: 'codex', queues: () => f.queues },
    sse: { idleTimeoutMs: 500, backoff: { baseMs: 40, maxMs: 160 }, reconnectDelayMs: 20 },
    slowAckMs: 0,
    coldStartGraceMs: 60_000,
    unsupportedKindNoticeMs: 60_000,
    ...overrides,
  });
  f.adapters.push(adapter);
  return adapter;
}

const sink = async (envelope: InboundEnvelope): Promise<IngressAck> => {
  if (envelope.channel !== 'waku-dm') throw new Error('adapter must emit waku-dm envelopes');
  if (f.sinkThrows) throw f.sinkThrows;
  f.envelopes.push(envelope);
  return typeof f.sinkResult === 'function' ? f.sinkResult() : f.sinkResult;
};

function finalEnvelope(text: string, overrides: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    routeId: CONV,
    messageId: '0198f4c1-1111-7000-8000-000000000001',
    kind: 'final',
    keyVersion: 1,
    expiresAt: Date.now() + 300_000,
    payload: { type: 'final', conversationId: CONV, replyTo: 'cmsg_in_1', text },
    ...overrides,
  };
}

async function started(adapter: WakuDmAdapter): Promise<void> {
  await adapter.start(sink);
  await waitFor(() => f.server.liveConnectionCount === 1, { label: 'sse connected' });
}

// ---------------------------------------------------------------------------
// 入站
// ---------------------------------------------------------------------------

describe('waku-dm · 入站映射与过滤', () => {
  it('owner 的 dm 文本 → 明文信封；字段来自帧；日志 `<- sender8: text50`；游标持久到 SQLite', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    const { seq, message } = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: '请只回答这个暗号本身：ZX123456' });
    await waitFor(() => f.envelopes.length === 1);

    const envelope = f.envelopes[0];
    expect(envelope).toMatchObject({
      channel: 'waku-dm',
      routeId: CONV,
      messageId: message.id,
      principalRef: OWNER,
      text: '请只回答这个暗号本身：ZX123456',
    });
    expect(typeof envelope.createdAt).toBe('number');
    expect(Math.abs(envelope.createdAt - Date.now())).toBeLessThan(60_000);
    expect(envelope.receivedAt).toBeGreaterThan(0);

    await waitFor(() => f.store.getCursor(WAKU_DM_CURSOR_COLLECTION)?.lastCreatedAt === seq, { label: 'cursor persisted' });
    expect(f.log.find(`<- ${OWNER.slice(0, 8)}: 请只回答这个暗号本身：ZX123456`)).toHaveLength(1);
    // 凭证与 JWT 绝不进日志
    expect(f.log.all()).not.toContain(CREDENTIAL);
    for (const token of f.server.issuedTokens()) expect(f.log.all()).not.toContain(token);
  });

  it('过滤：自回显 / 群聊 / 已撤回 / 别的 bot（source=agent_bridge）/ 缺 conversation_kind 一律丢，但游标照推', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    f.server.seedGroup('conv_group', [OWNER]);
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: PERSONA, body: 'echo of myself' });
    f.server.emitChatMessage({ conversationId: 'conv_group', senderUserId: OWNER, body: 'group chatter' });
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'recalled', recalled: true });
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OTHER_BOT, body: 'bot to bot', source: 'agent_bridge' });
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'no kind', omitConversationKind: true });
    const last = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'real one' });
    await waitFor(() => f.envelopes.length === 1, { label: 'only the real one' });
    expect(f.envelopes[0].text).toBe('real one');
    await waitFor(() => f.store.getCursor(WAKU_DM_CURSOR_COLLECTION)?.lastCreatedAt === last.seq);
    await sleep(50);
    expect(f.envelopes).toHaveLength(1);
  });

  it('非文字消息（image 等）→ 回一句「暂时只支持文字」，每会话 60s 最多一次，且不进 sink', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'image', body: null });
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, kind: 'sticker', body: null });
    await waitFor(() => f.server.messages.length === 1, { label: 'one notice' });
    expect(f.server.messages[0]).toMatchObject({ conversationId: CONV, senderUserId: PERSONA });
    expect(f.server.messages[0].body).toContain('只支持文字');
    await sleep(80);
    expect(f.server.messages).toHaveLength(1);
    expect(f.envelopes).toHaveLength(0);
  });

  it('其它事件（chat.read / activity.*）不进 sink，但游标照推', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    f.server.emit('chat.read', { conversation_id: CONV, read_cursor: 3 });
    const seq = f.server.emit('activity.updated', { id: 'act_1' });
    await waitFor(() => f.store.getCursor(WAKU_DM_CURSOR_COLLECTION)?.lastCreatedAt === seq, { label: 'cursor advanced on non-chat events' });
    expect(f.envelopes).toHaveLength(0);
  });

  it('畸形 data（非 JSON）只记日志不炸流，游标照推', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    f.server.emitRaw('id: 1\nevent: chat.message\ndata: {not json\n\n');
    const seq = f.server.emit('chat.read', { conversation_id: CONV });
    await waitFor(() => f.store.getCursor(WAKU_DM_CURSOR_COLLECTION)?.lastCreatedAt === seq);
    expect(f.envelopes).toHaveLength(0);
    expect(f.log.find(/malformed|parse/i).length).toBeGreaterThan(0);
  });
});

describe('waku-dm · 冷启动与游标', () => {
  it('首次启动无游标：不带 Last-Event-ID；回放出来的旧历史（created_at < 启动-60s）丢弃但游标照记；新消息照常', async () => {
    const old = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'ancient history', createdAtMs: Date.now() - 10 * 60_000 });
    const adapter = makeAdapter();
    await started(adapter);
    const fresh = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'fresh' });
    await waitFor(() => f.envelopes.length === 1);
    expect(f.envelopes[0].text).toBe('fresh');
    expect(f.server.sseConnections[0].lastEventId).toBeNull();
    expect(f.store.getCursor(WAKU_DM_CURSOR_COLLECTION)?.lastCreatedAt).toBe(fresh.seq);
    expect(old.seq).toBeLessThan(fresh.seq);
  });

  it('重启后从持久游标续读：带 Last-Event-ID，只拿到断线期间的新帧，已处理的不重投', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'before restart' });
    await waitFor(() => f.envelopes.length === 1);
    await adapter.stop();
    await waitFor(() => f.server.liveConnectionCount === 0);

    // 停机期间来的消息（created_at 很新）
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'while down' });

    const revived = makeAdapter();
    await revived.start(sink);
    await waitFor(() => f.envelopes.length === 2, { label: 'delta replayed' });
    expect(f.envelopes[1].text).toBe('while down');
    expect(f.server.sseConnections[1].lastEventId).toBe('1');
    await sleep(50);
    expect(f.envelopes).toHaveLength(2);
  });

  it('sink 抛错：游标不推进，重连后同一条重投；恢复后 duplicate/accepted 都算处理完', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    f.sinkThrows = new Error('db locked');
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'retry me' });
    await waitFor(() => f.server.sseConnections.length >= 2, { timeoutMs: 3_000, label: 'reconnect after sink failure' });
    expect(f.store.getCursor(WAKU_DM_CURSOR_COLLECTION)).toBeNull();
    f.sinkThrows = null;
    await waitFor(() => f.envelopes.length === 1, { timeoutMs: 3_000, label: 'redelivered' });
    expect(f.envelopes[0].text).toBe('retry me');
    expect(f.log.find(/sink|frame/i).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 出站
// ---------------------------------------------------------------------------

describe('waku-dm · 出站：切片、client_msg_id、回执映射', () => {
  it('final 单片：POST body 原文、client_msg_id = messageId、kind=text → sent；随后 POST read 带该会话最后入站 conv_seq', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    const inbound = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'q' });
    await waitFor(() => f.envelopes.length === 1);

    const receipt = await adapter.send(finalEnvelope('搞定 ✅', { payload: { type: 'final', conversationId: CONV, replyTo: inbound.message.id, text: '搞定 ✅' } }));
    expect(receipt.status).toBe('sent');
    const sent = f.server.requestsTo(`/api/v1/chat/conversations/${CONV}/messages`, 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ client_msg_id: '0198f4c1-1111-7000-8000-000000000001', kind: 'text', body: '搞定 ✅' });
    expect(sent[0].headers['authorization']).toMatch(/^Bearer /);
    await waitFor(() => f.server.reads.length === 1, { label: 'read receipt' });
    expect(f.server.reads[0]).toMatchObject({ conversationId: CONV, convSeq: inbound.message.conv_seq, by: PERSONA });
  });

  it('超长正文按字符 ≤3900 切片，client_msg_id = `<messageId>:<index>`，按序发送；markdown 被剥掉', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    const paragraph = `${'字'.repeat(3000)}\n`;
    const text = `# 标题\n**粗体**\n${paragraph}${paragraph}${paragraph}`;
    const receipt = await adapter.send(finalEnvelope(text));
    expect(receipt.status).toBe('sent');
    const sent = f.server.requestsTo(`/api/v1/chat/conversations/${CONV}/messages`, 'POST');
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const ids = sent.map((r) => r.body['client_msg_id']);
    expect(ids).toEqual(ids.map((_, index) => `0198f4c1-1111-7000-8000-000000000001:${index}`));
    for (const request of sent) {
      const body = String(request.body['body']);
      expect(body.length).toBeLessThanOrEqual(3900);
      expect(body).not.toContain('**');
      expect(body).not.toMatch(/^# /m);
    }
    expect(sent.map((r) => String(r.body['body'])).join('')).toContain('标题');
  });

  it('429 带 Retry-After → retryable(retryAfterMs)；5xx → retryable；403 not_friends / 404 → permanent-failure；网络断 → unknown', async () => {
    const adapter = makeAdapter();
    await started(adapter);

    f.server.failNextSend({ status: 429, code: 'rate_limited', retryAfterSec: 7 });
    expect(await adapter.send(finalEnvelope('a'))).toEqual({ status: 'retryable', code: 'rate_limited', retryAfterMs: 7_000 });

    f.server.failNextSend({ status: 503, code: 'upstream' });
    expect(await adapter.send(finalEnvelope('b'))).toMatchObject({ status: 'retryable' });

    f.server.failNextSend({ status: 403, code: 'not_friends' });
    expect(await adapter.send(finalEnvelope('c'))).toEqual({ status: 'permanent-failure', code: 'not_friends' });

    f.server.failNextSend({ status: 404, code: 'not_found' });
    expect(await adapter.send(finalEnvelope('d'))).toEqual({ status: 'permanent-failure', code: 'not_found' });

    f.server.failNextSend({ network: true, applyWrite: true });
    expect(await adapter.send(finalEnvelope('e'))).toMatchObject({ status: 'unknown' });
    // 四件套之四：send 失败要有日志
    expect(f.log.find(/send/i).length).toBeGreaterThan(0);
  });

  it('401 → 换 token 后同请求重放一次（成功则 sent）；持续 401 → retryable 且 tokenState 可见', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    const before = f.server.tokenCalls;
    f.server.revokeAllTokens();
    expect(await adapter.send(finalEnvelope('after revoke'))).toMatchObject({ status: 'sent' });
    expect(f.server.tokenCalls).toBe(before + 1);
    expect(f.server.messages.at(-1)?.body).toBe('after revoke');

    f.server.credentialRevoked = true;
    f.server.revokeAllTokens();
    const receipt = await adapter.send(finalEnvelope('still dead'));
    expect(receipt).toMatchObject({ status: 'retryable' });
    expect((await adapter.health()).tokenState).toBe('degraded');
  });

  it('重投同一 messageId：服务端幂等（created=false），回执仍 sent，不产生第二条', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    expect(await adapter.send(finalEnvelope('once'))).toMatchObject({ status: 'sent' });
    // 重投：服务端 created=false，但对 Core 而言仍是 sent（同一 messageId，不换 id）
    expect(await adapter.send(finalEnvelope('once'))).toMatchObject({ status: 'sent' });
    expect(f.server.messages.filter((m) => m.body === 'once')).toHaveLength(1);
  });

  it('progress / ack / status 这些 Playable 才看的 kind 在 waku-dm 是 no-op（sent，不打网络）；error 映射成人话', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    const base = finalEnvelope('');
    expect(await adapter.send({ ...base, kind: 'progress', payload: { type: 'progress', conversationId: CONV, replyTo: 'x', stage: 'running' } })).toEqual({ status: 'sent' });
    expect(await adapter.send({ ...base, kind: 'ack', payload: { type: 'ack', ackMessageId: 'x', status: 'completed' } })).toEqual({ status: 'sent' });
    expect(await adapter.send({ ...base, kind: 'status', payload: { type: 'status', agent: 'online', at: 1 } })).toEqual({ status: 'sent' });
    expect(f.server.messages).toHaveLength(0);

    expect(await adapter.send({ ...base, kind: 'error', payload: { type: 'error', code: 'queue_full', conversationId: CONV, replyTo: 'x' } })).toMatchObject({ status: 'sent' });
    expect(f.server.messages.at(-1)?.body).toContain('排队');
    expect(await adapter.send({ ...base, messageId: '0198f4c1-1111-7000-8000-000000000002', kind: 'error', payload: { type: 'error', code: 'codex-error', message: '配额用完了', conversationId: CONV, replyTo: 'x' } })).toMatchObject({ status: 'sent' });
    expect(f.server.messages.at(-1)?.body).toContain('配额用完了');
  });

  it('stop 之后 send → permanent-failure waku_dm_stopped', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    await adapter.stop();
    expect(await adapter.send(finalEnvelope('late'))).toEqual({ status: 'permanent-failure', code: 'waku_dm_stopped' });
  });
});

// ---------------------------------------------------------------------------
// 心跳 / 健康 / 慢回执
// ---------------------------------------------------------------------------

describe('waku-dm · 心跳与健康', () => {
  it('按 intervalMs 心跳，body 含 agent_state / queued / running / capabilities；running>0 时 busy', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    await waitFor(() => f.server.heartbeats.length >= 1, { label: 'first heartbeat' });
    expect(f.server.heartbeats[0]).toMatchObject({ agent_state: 'online', queued: 0, running: 0, capabilities: { channel: 'waku-dm', agent: 'codex' } });
    f.queues = { running: 1, queued: 2 };
    await waitFor(() => f.server.heartbeats.some((hb) => hb['agent_state'] === 'busy' && hb['running'] === 1 && hb['queued'] === 2), { timeoutMs: 3_000 });
    const health = await adapter.health();
    expect(health.lastHeartbeatAt).not.toBeNull();
  });

  it('心跳返回 bridge.status=disabled → 停止消费、health 标红 state=disabled、有日志', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    f.server.bridgeStatus = 'disabled';
    await waitFor(() => f.server.liveConnectionCount === 0, { timeoutMs: 3_000, label: 'sse closed' });
    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.state).toBe('disabled');
    expect(f.log.find(/disabled/i).length).toBeGreaterThan(0);
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'nobody home' });
    await sleep(100);
    expect(f.envelopes).toHaveLength(0);
  });

  it('心跳关闭（session 模式）时不打 heartbeat 端点', async () => {
    const adapter = makeAdapter({ heartbeat: { enabled: false, intervalMs: 50, agentName: 'codex', queues: () => f.queues } });
    await started(adapter);
    await sleep(200);
    expect(f.server.heartbeats).toHaveLength(0);
  });

  it('health：type/cursor/lastEventAt/reconnects/tokenState/selfUserId 齐全且不含 token', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    const seq = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'x' }).seq;
    await waitFor(() => f.envelopes.length === 1);
    await waitFor(() => f.store.getCursor(WAKU_DM_CURSOR_COLLECTION)?.lastCreatedAt === seq);
    const health = await adapter.health();
    expect(health).toMatchObject({ ok: true, state: 'running', cursor: seq, reconnects: 0, tokenState: 'ready', selfUserId: PERSONA });
    expect(health.lastEventAt).not.toBeNull();
    for (const token of f.server.issuedTokens()) expect(JSON.stringify(health)).not.toContain(token);
  });

  it('SSE 401 → 换 token 重连（tokenCalls +1），reconnects 计数', async () => {
    const adapter = makeAdapter();
    await started(adapter);
    const before = f.server.tokenCalls;
    f.server.revokeAllTokens();
    f.server.dropConnections();
    await waitFor(() => f.server.tokenCalls === before + 1, { timeoutMs: 3_000, label: 're-exchanged' });
    await waitFor(() => f.server.liveConnectionCount === 1, { timeoutMs: 3_000, label: 'reconnected' });
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'after reauth' });
    await waitFor(() => f.envelopes.length === 1, { timeoutMs: 3_000 });
    expect((await adapter.health()).reconnects).toBeGreaterThanOrEqual(1);
    expect(f.log.find(/sse/i).length).toBeGreaterThan(0);
  });
});

describe('waku-dm · 慢回执（CC2WECHAT_ACK_MS 语义）', () => {
  it('turn 被接收后 slowAckMs 内没有 final → 直接发「收到，正在处理…」；final 先到则不发', async () => {
    const adapter = makeAdapter({ slowAckMs: 150 });
    await started(adapter);
    const slow = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'slow one' });
    await waitFor(() => f.envelopes.length === 1);
    await waitFor(() => f.server.messages.some((m) => m.body.includes('正在处理')), { timeoutMs: 2_000, label: 'slow ack' });
    expect(f.server.messages.filter((m) => m.body.includes('正在处理'))).toHaveLength(1);

    const quick = f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'quick one' });
    await waitFor(() => f.envelopes.length === 2);
    await adapter.send(finalEnvelope('instant', { messageId: '0198f4c1-1111-7000-8000-000000000009', payload: { type: 'final', conversationId: CONV, replyTo: quick.message.id, text: 'instant' } }));
    await sleep(300);
    expect(f.server.messages.filter((m) => m.body.includes('正在处理'))).toHaveLength(1);
    expect(slow.message.id).not.toBe(quick.message.id);
  });

  it('sink 回 duplicate / rejected 的消息不起慢回执计时', async () => {
    const adapter = makeAdapter({ slowAckMs: 100 });
    await started(adapter);
    f.sinkResult = { status: 'rejected', code: 'acl_denied' };
    f.server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'denied' });
    await waitFor(() => f.envelopes.length === 1);
    await sleep(250);
    expect(f.server.messages).toHaveLength(0);
  });
});
