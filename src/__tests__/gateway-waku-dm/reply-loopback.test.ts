/**
 * waku-dm · 回环回复口（`waku-dm-reply` → `POST /admin/reply`）。
 *
 * 这条链存在的理由只有一个：Agent 干活干到一半想先把一张图发过去。
 * 所以最要紧的两条不变量都在"发给谁"上：
 *
 * 1. **不猜会话**。微信版靠 ctx 目录里 mtime 最新的文件推断当前会话，两个人同时聊天时会串人。
 *    这里只认 `--conversation` 或"恰好一条正在跑的 turn"，0 条 / 多条一律报错要求显式指定。
 * 2. **走同一条出站路**。落 outbox → adapter.send → 同一套幂等与回执，不另开一条捷径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { buildWakuDmGateway, loadDmGatewayConfig, type WakuDmGateway } from '../../gateway/bootstrap/waku-dm.js';
import { createOpsServer, HEALTH_PORT_FILE, parseReplyBody } from '../../gateway/server.js';
import { parseReplyArgs, postReply, resolveHealthPort } from '../../gateway/reply-cli.js';
import { FakeAgent } from '../gateway-core/harness.js';
import { FakeBridgeServer, RecordingLogger, waitFor, sleep } from './fake-bridge-server.js';

const PERSONA = 'usr_persona_000000000000000000001';
const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';
const CONV = 'conv_01J0000000000000000000001';
const CONV_B = 'conv_01J0000000000000000000002';
/** 第二条车道要换个人：串行是**按人**分的（pairingId = sender），同一个人的两条会话不会同时在跑。 */
const OWNER_B = 'usr_1111111111111111111111111111';
const CREDENTIAL = 'abc_XfQ1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E0';

function pngOf(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([header, ihdr, Buffer.alloc(16, 9)]);
}

let dir: string;
let server: FakeBridgeServer;
let gateway: WakuDmGateway | null;
let agent: FakeAgent;
let ops: http.Server | null;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-reply-'));
  server = new FakeBridgeServer({ personaUserId: PERSONA, ownerUserId: OWNER, credential: CREDENTIAL, keepaliveMs: 50 });
  await server.start();
  server.seedDm(CONV, OWNER);
  server.seedDm(CONV_B, OWNER_B);
  gateway = null;
  ops = null;
});

afterEach(async () => {
  if (ops !== null) await new Promise<void>((resolve) => ops!.close(() => resolve()));
  // 闸门模式下的 turn 不会自己结束；不放行的话 drain() 会一直等下去。
  for (const turn of agent?.turns ?? []) turn.end();
  if (gateway !== null) await gateway.stop();
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(options: { ackMs?: string } = {}): Promise<WakuDmGateway> {
  const credentialFile = path.join(dir, 'bridge.credential');
  fs.writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });
  const config = loadDmGatewayConfig({
    WAKU_GATEWAY_CHANNEL: 'waku-dm',
    WAKU_GATEWAY_STATE_DIR: path.join(dir, 'state'),
    WAKU_GATEWAY_WORKSPACE_DIR: dir,
    WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: credentialFile,
    WAKU_GATEWAY_API_BASE: server.apiBase,
    WAKU_GATEWAY_OWNER_USER_IDS: `${OWNER},${OWNER_B}`,
    WAKU_GATEWAY_SSE_IDLE_TIMEOUT_MS: '2000',
    CC2WECHAT_ACK_MS: options.ackMs ?? '0',
  } as NodeJS.ProcessEnv);
  agent = new FakeAgent();
  gateway = buildWakuDmGateway({ config, agent, log: new RecordingLogger() });
  await gateway.start();
  await waitFor(() => server.liveConnectionCount === 1, { label: 'gateway subscribed' });
  return gateway;
}

/** 让一轮跑起来并**挂住**（闸门模式），这样它一直算作 running。 */
async function startBlockedTurn(conversationId: string, senderUserId = OWNER): Promise<void> {
  agent.gate();
  const before = agent.turns.length;
  server.emitChatMessage({ conversationId, senderUserId, body: 'long task' });
  await waitFor(() => agent.turns.length === before + 1, { label: `turn running in ${conversationId}` });
}

describe('waku-dm · 回环回复：会话推断', () => {
  it('恰好一条正在跑的 turn → 不传 --conversation 也能发到那条会话', async () => {
    const gw = await boot();
    await startBlockedTurn(CONV);

    const result = await gw.reply({ text: '先给你看个东西' });

    expect(result.conversationId).toBe(CONV);
    expect(result.status).toBe('sent');
    expect(result.messageId.startsWith('reply:')).toBe(true);
    await waitFor(() => server.messages.some((m) => m.body === '先给你看个东西'), { label: 'loopback text delivered' });
  });

  it('一条都没在跑 → 报错并明说"把 --conversation 传上"', async () => {
    const gw = await boot();
    await expect(gw.reply({ text: 'hi' })).rejects.toThrow(/--conversation/);
  });

  it('两条同时在跑 → 拒绝猜，报错要求指定（不按 mtime 挑一个）', async () => {
    const gw = await boot();
    await startBlockedTurn(CONV);
    await startBlockedTurn(CONV_B, OWNER_B);
    await waitFor(() => gw.orchestrator.runningTurns().length === 2, { label: 'two running turns' });

    await expect(gw.reply({ text: 'hi' })).rejects.toThrow(/2 turns are running/);
  });

  it('显式 --conversation：不需要有 turn 在跑，只要这条会话在本机存在过', async () => {
    const gw = await boot();
    // 先让 CONV 有一轮跑完（会话行落库）
    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'hello' });
    await waitFor(() => agent.turns.length === 1, { label: 'first turn' });

    const result = await gw.reply({ conversationId: CONV, text: '补一句' });
    expect(result.conversationId).toBe(CONV);
    await waitFor(() => server.messages.some((m) => m.body === '补一句'), { label: 'explicit conversation delivered' });
  });

  it('没人在本机聊过的会话 id → 报错（不知道该以谁的名义发）', async () => {
    const gw = await boot();
    await expect(gw.reply({ conversationId: 'conv_never_seen', text: 'hi' })).rejects.toThrow(/unknown conversation/);
  });

  it('既没文本也没附件 → 报错，不发空消息', async () => {
    const gw = await boot();
    await startBlockedTurn(CONV);
    await expect(gw.reply({ text: '   ' })).rejects.toThrow(/nothing to send/);
  });
});

describe('waku-dm · 回环回复与慢回执', () => {
  /**
   * 慢回执（「收到，正在处理…」）的前提是"用户到现在还什么都没收到"。Agent 中途用回环口
   * 发过东西之后这个前提就不成立了，再补一句只会像机器人自言自语。
   *
   * 原先做不到，是因为回环发布把 `replyTo` 写死成哨兵 `'loopback'`，永远匹配不上真正的
   * 入站 messageId ⇒ `cancelSlowAck` 全程是个空操作。
   */
  it('中途回环发过东西 → 这一轮不再补「正在处理」', async () => {
    const gw = await boot({ ackMs: '200' });
    await startBlockedTurn(CONV);

    await gw.reply({ text: '先给你看个东西' });
    await waitFor(() => server.messages.some((m) => m.body === '先给你看个东西'), { label: 'loopback delivered' });

    await sleep(500);
    expect(server.messages.filter((m) => m.body.includes('正在处理'))).toHaveLength(0);
  });

  it('对照：同样的慢轮，没有回环回复时慢回执照发（证明上一条不是因为压根没起计时）', async () => {
    const gw = await boot({ ackMs: '200' });
    void gw;
    await startBlockedTurn(CONV);

    await waitFor(() => server.messages.some((m) => m.body.includes('正在处理')), {
      timeoutMs: 3_000,
      label: 'slow ack fired',
    });
    expect(server.messages.filter((m) => m.body.includes('正在处理'))).toHaveLength(1);
  });

  it('慢回执只发一次：等两个阈值也不会冒出第二句', async () => {
    const gw = await boot({ ackMs: '200' });
    void gw;
    await startBlockedTurn(CONV);

    await waitFor(() => server.messages.some((m) => m.body.includes('正在处理')), { timeoutMs: 3_000 });
    await sleep(600);
    expect(server.messages.filter((m) => m.body.includes('正在处理'))).toHaveLength(1);
  });
});

describe('waku-dm · 回环回复：附件与标记', () => {
  it('--image 走与 Agent final 同一条上传/发送路（kind=image + 幂等 id）', async () => {
    const gw = await boot();
    await startBlockedTurn(CONV);
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, pngOf(120, 90));

    const result = await gw.reply({ text: '看这个', attachments: [{ kind: 'image', path: file }] });

    expect(result.attachments).toBe(1);
    await waitFor(() => server.richMessages.length === 1, { label: 'image sent' });
    expect(server.richMessages[0].body).toMatchObject({ kind: 'image', image_width: 120, image_height: 90 });
    expect(String(server.richMessages[0].body['client_msg_id'])).toBe(`${result.messageId}:att0`);
  });

  it('--text 里写的 [[send-image: …]] 标记同样被解析并剥离', async () => {
    const gw = await boot();
    await startBlockedTurn(CONV);
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, pngOf(10, 10));

    const result = await gw.reply({ text: `拿去 [[send-image: ${file}]]` });

    expect(result.attachments).toBe(1);
    await waitFor(() => server.messages.some((m) => m.body === '拿去'), { label: 'marker stripped' });
    expect(server.messages.every((m) => !m.body.includes('send-image'))).toBe(true);
  });
});

describe('waku-dm · 回环运维口', () => {
  it('POST /admin/reply 打通 CLI → daemon；错误回 400 且带人能看懂的 message', async () => {
    const gw = await boot();
    await startBlockedTurn(CONV);
    ops = createOpsServer(gw);
    await new Promise<void>((resolve) => ops!.listen(0, '127.0.0.1', resolve));
    const port = (ops.address() as AddressInfo).port;

    const ok = await postReply(port, { text: '来自回环' });
    expect(ok['conversationId']).toBe(CONV);
    await waitFor(() => server.messages.some((m) => m.body === '来自回环'), { label: 'delivered via ops' });

    await expect(postReply(port, { conversationId: 'conv_nope', text: 'x' })).rejects.toThrow(/unknown conversation/);
  });

  it('V1 信箱通道没有这个口：404 reply_not_supported_on_this_channel', async () => {
    ops = createOpsServer({ health: async () => ({ core: { ok: true } }) });
    await new Promise<void>((resolve) => ops!.listen(0, '127.0.0.1', resolve));
    const port = (ops.address() as AddressInfo).port;
    await expect(postReply(port, { text: 'x' })).rejects.toThrow(/reply_not_supported_on_this_channel/);
  });

  it('parseReplyBody 只放行白名单字段（回环≠可信）', () => {
    expect(
      parseReplyBody({
        conversationId: CONV,
        text: 'hi',
        attachments: [
          { kind: 'image', path: '/tmp/a.png', evil: 'x' },
          { kind: 'nope', path: '/tmp/b.png' },
          { kind: 'card', contentId: 'cnt_1', launchCtx: { room: 'A', bad: 3 } },
          'not an object',
        ],
      } as Record<string, unknown>),
    ).toEqual({
      conversationId: CONV,
      text: 'hi',
      attachments: [
        { kind: 'image', path: '/tmp/a.png' },
        { kind: 'card', contentId: 'cnt_1', launchCtx: { room: 'A' } },
      ],
    });
  });
});

describe('waku-dm-reply · 参数与端口发现', () => {
  it('参数词法：文本 / 四类附件 / --caption 与 --launch-ctx 作用在最近一个附件上', () => {
    expect(
      parseReplyArgs([
        '--conversation',
        CONV,
        '--text',
        '看这些',
        '--image',
        '/tmp/a.png',
        '--caption',
        '第一张',
        '--card',
        'cnt_1',
        '--launch-ctx',
        '{"room":"ABCD"}',
      ]),
    ).toEqual({
      conversationId: CONV,
      text: '看这些',
      attachments: [
        { kind: 'image', path: '/tmp/a.png', caption: '第一张' },
        { kind: 'card', contentId: 'cnt_1', launchCtx: { room: 'ABCD' } },
      ],
    });
  });

  it('相对路径会被解析成绝对路径（daemon 的 cwd 和 Agent 的不一定一样）', () => {
    const parsed = parseReplyArgs(['--image', 'rel.png']);
    expect(parsed.attachments?.[0].path).toBe(path.resolve('rel.png'));
  });

  it('说不清要发什么 / 参数缺值 / 不认识的旗标 → 报错并打用法', () => {
    expect(() => parseReplyArgs([])).toThrow(/nothing to send/);
    expect(() => parseReplyArgs(['--text'])).toThrow(/needs a value/);
    expect(() => parseReplyArgs(['--nope', 'x'])).toThrow(/unknown flag/);
    expect(() => parseReplyArgs(['--launch-ctx', '{}'])).toThrow(/must follow an attachment/);
    expect(() => parseReplyArgs(['--card', 'cnt_1', '--launch-ctx', 'oops'])).toThrow(/JSON object/);
  });

  it('端口发现：env 优先，其次 state dir 里的 health.port，再不行用缺省 18092', () => {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, HEALTH_PORT_FILE), '19999\n');

    expect(resolveHealthPort({ WAKU_GATEWAY_HEALTH_PORT: '18093', WAKU_GATEWAY_STATE_DIR: stateDir } as NodeJS.ProcessEnv)).toBe(18093);
    expect(resolveHealthPort({ WAKU_GATEWAY_STATE_DIR: stateDir } as NodeJS.ProcessEnv)).toBe(19999);
    expect(resolveHealthPort({ WAKU_GATEWAY_STATE_DIR: path.join(dir, 'empty') } as NodeJS.ProcessEnv)).toBe(18092);
  });

  it('daemon 没跑时的报错点出该怎么起它（而不是一个裸的 ECONNREFUSED）', async () => {
    await expect(postReply(1, { text: 'x' })).rejects.toThrow(/is it running/);
  });
});
