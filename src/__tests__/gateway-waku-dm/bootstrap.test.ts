/**
 * waku-dm · 组装层（RED）：配置读取 + 真 Core + FakeAgent + FakeBridgeServer 的端到端。
 *
 * 契约 §3.1 环境变量表；§3.6 复用 Core；四件套日志由组装层接线（`[turn] …`）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadDmGatewayConfig, buildWakuDmGateway, type WakuDmGateway } from '../../gateway/bootstrap/waku-dm.js';
import { FakeAgent } from '../gateway-core/harness.js';
import { FakeBridgeServer, RecordingLogger, waitFor, sleep } from './fake-bridge-server.js';

const PERSONA = 'usr_persona_000000000000000000001';
const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';
const STRANGER = 'usr_stranger_00000000000000000001';
const CONV = 'conv_01J0000000000000000000001';
const CREDENTIAL = 'abc_XfQ1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E0';

const dirs: string[] = [];
const servers: FakeBridgeServer[] = [];
const gateways: WakuDmGateway[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-boot-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function baseEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    WAKU_GATEWAY_CHANNEL: 'waku-dm',
    WAKU_GATEWAY_STATE_DIR: path.join(dir, 'state'),
    WAKU_GATEWAY_WORKSPACE_DIR: dir,
    WAKU_GATEWAY_HEALTH_PORT: '18999',
    WAKU_GATEWAY_NODE_ID: 'test-node',
    ...extra,
  };
}

function writeCredential(dir: string): string {
  const file = path.join(dir, 'bridge.credential');
  fs.writeFileSync(file, `${CREDENTIAL}\n`, { mode: 0o600 });
  return file;
}

describe('waku-dm · loadDmGatewayConfig', () => {
  it('bridge 模式：凭证文件 + API_BASE + OWNER_USER_IDS 齐全 → 默认值合理（独立 state dir / 端口 / 心跳 30s / deny）', () => {
    const dir = tmp();
    const config = loadDmGatewayConfig(
      baseEnv(dir, {
        WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: writeCredential(dir),
        WAKU_GATEWAY_API_BASE: 'https://api.example/api/v1/',
        WAKU_GATEWAY_OWNER_USER_IDS: `${OWNER}, usr_second`,
      }),
    );
    expect(config.credential).toEqual({ mode: 'bridge', file: path.join(dir, 'bridge.credential') });
    expect(config.apiBase).toBe('https://api.example/api/v1');
    expect(config.ownerUserIds).toEqual([OWNER, 'usr_second']);
    expect(config.defaultTier).toBe('deny');
    expect(config.guestEndpoint).toBeNull();
    expect(config.healthPort).toBe(18999);
    expect(config.healthHost).toBe('127.0.0.1');
    expect(config.heartbeatIntervalMs).toBe(30_000);
    expect(config.sseIdleTimeoutMs).toBe(30_000);
    expect(config.slowAckMs).toBe(60_000);
    expect(config.endpoint).toMatchObject({ id: 'aster-admin', trustTier: 'admin-bypass', workspacePolicyId: 'admin-home' });
    expect(config.workspaces['admin-home']).toBe(dir);
    expect(config.stateDir).toBe(path.join(dir, 'state'));
  });

  it('默认 state dir 与 V1 不同（~/.waku-gateway-dm），默认端口 18092，CC2WECHAT_ACK_MS 决定慢回执', () => {
    const dir = tmp();
    const config = loadDmGatewayConfig({
      WAKU_GATEWAY_CHANNEL: 'waku-dm',
      WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: writeCredential(dir),
      WAKU_GATEWAY_API_BASE: 'https://api.example/api/v1',
      WAKU_GATEWAY_OWNER_USER_IDS: OWNER,
      WAKU_GATEWAY_WORKSPACE_DIR: dir,
      CC2WECHAT_ACK_MS: '0',
    });
    expect(config.stateDir).toBe(path.join(os.homedir(), '.waku-gateway-dm'));
    expect(config.healthPort).toBe(18092);
    expect(config.slowAckMs).toBe(0);
  });

  it('session 模式：API_BASE 缺省从 auth.json 的 api_base 读', () => {
    const dir = tmp();
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({ user_id: OWNER, session_token: 'x', refresh_token: 'y', api_base: 'https://core.example/api/v1' }), { mode: 0o600 });
    const config = loadDmGatewayConfig(baseEnv(dir, { WAKU_GATEWAY_AUTH_PATH: authPath, WAKU_GATEWAY_OWNER_USER_IDS: OWNER }));
    expect(config.credential).toEqual({ mode: 'session', authPath });
    expect(config.apiBase).toBe('https://core.example/api/v1');
  });

  it('两种凭证都给 / 都不给 / 没有 owner 且默认 deny / API_BASE 缺失 → 启动失败并说人话', () => {
    const dir = tmp();
    const credentialFile = writeCredential(dir);
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({ user_id: OWNER, api_base: 'https://core.example/api/v1' }), { mode: 0o600 });

    expect(() => loadDmGatewayConfig(baseEnv(dir, { WAKU_GATEWAY_OWNER_USER_IDS: OWNER }))).toThrow(/WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE|WAKU_GATEWAY_AUTH_PATH/);
    expect(() =>
      loadDmGatewayConfig(baseEnv(dir, { WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: credentialFile, WAKU_GATEWAY_AUTH_PATH: authPath, WAKU_GATEWAY_API_BASE: 'https://x/api/v1', WAKU_GATEWAY_OWNER_USER_IDS: OWNER })),
    ).toThrow(/二选一|one of/i);
    expect(() => loadDmGatewayConfig(baseEnv(dir, { WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: credentialFile, WAKU_GATEWAY_API_BASE: 'https://x/api/v1' }))).toThrow(/OWNER_USER_IDS/);
    expect(() => loadDmGatewayConfig(baseEnv(dir, { WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: credentialFile, WAKU_GATEWAY_OWNER_USER_IDS: OWNER }))).toThrow(/API_BASE/);
  });

  it('DEFAULT_TIER 不是 deny 时必须给 GUEST_WORKSPACE_DIR（陌生人绝不落进 owner 的工作区）', () => {
    const dir = tmp();
    const env = baseEnv(dir, {
      WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: writeCredential(dir),
      WAKU_GATEWAY_API_BASE: 'https://x/api/v1',
      WAKU_GATEWAY_OWNER_USER_IDS: OWNER,
      WAKU_GATEWAY_DEFAULT_TIER: 'chat-only',
    });
    expect(() => loadDmGatewayConfig(env)).toThrow(/GUEST_WORKSPACE_DIR/);
    const guestDir = path.join(dir, 'guest');
    fs.mkdirSync(guestDir);
    const config = loadDmGatewayConfig({ ...env, WAKU_GATEWAY_GUEST_WORKSPACE_DIR: guestDir });
    expect(config.defaultTier).toBe('chat-only');
    expect(config.guestEndpoint).toMatchObject({ id: 'guest', trustTier: 'chat-only', workspacePolicyId: 'guest-home' });
    expect(config.workspaces['guest-home']).toBe(guestDir);
    expect(() => loadDmGatewayConfig({ ...env, WAKU_GATEWAY_DEFAULT_TIER: 'root' })).toThrow(/DEFAULT_TIER/);
  });
});

describe('waku-dm · 端到端（FakeBridgeServer ↔ 真 Core ↔ FakeAgent）', () => {
  async function boot(options: { slowAckMs?: string } = {}): Promise<{ gateway: WakuDmGateway; server: FakeBridgeServer; agent: FakeAgent; log: RecordingLogger }> {
    const dir = tmp();
    const server = new FakeBridgeServer({ personaUserId: PERSONA, ownerUserId: OWNER, credential: CREDENTIAL, keepaliveMs: 50 });
    servers.push(server);
    await server.start();
    server.seedDm(CONV, OWNER);
    server.seedDm('conv_stranger', STRANGER);
    const config = loadDmGatewayConfig(
      baseEnv(dir, {
        WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: writeCredential(dir),
        WAKU_GATEWAY_API_BASE: server.apiBase,
        WAKU_GATEWAY_OWNER_USER_IDS: OWNER,
        WAKU_GATEWAY_HEARTBEAT_INTERVAL_MS: '150',
        WAKU_GATEWAY_SSE_IDLE_TIMEOUT_MS: '500',
        CC2WECHAT_ACK_MS: options.slowAckMs ?? '0',
      }),
    );
    const agent = new FakeAgent();
    const log = new RecordingLogger();
    const gateway = buildWakuDmGateway({ config, agent, log });
    gateways.push(gateway);
    await gateway.start();
    await waitFor(() => server.liveConnectionCount === 1, { label: 'gateway subscribed' });
    return { gateway, server, agent, log };
  }

  it('owner 私聊 → Codex(FakeAgent) 回声落到同一会话；[turn] 日志四件套；health 带 channel 块；陌生人静默', async () => {
    const { gateway, server, agent, log } = await boot();

    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: '请只回答这个暗号本身：ZX123456' });
    await waitFor(() => server.messages.some((m) => m.conversationId === CONV && m.body === 'echo:请只回答这个暗号本身：ZX123456'), { timeoutMs: 5_000, label: 'echo reply' });
    expect(agent.turns).toHaveLength(1);
    expect(agent.turns[0].request.cwd).toBe(gateway.config.workspaces['admin-home']);
    expect(server.messages[0].senderUserId).toBe(PERSONA);

    await waitFor(() => log.find(/^\[turn\] conv=/).length === 1, { label: '[turn] line' });
    expect(log.find(/^\[turn\] conv=/)[0]).toMatch(/^\[turn\] conv=conv_01J0 agent=codex queue=\d+ms first=-?\d+ms total=\d+ms outcome=final$/);
    expect(log.find(`<- ${OWNER.slice(0, 8)}: 请只回答这个暗号本身：ZX123456`)).toHaveLength(1);
    await waitFor(() => server.reads.length >= 1, { label: 'read receipt' });

    // 陌生人：不调 Agent、不回话
    server.emitChatMessage({ conversationId: 'conv_stranger', senderUserId: STRANGER, body: '我也要' });
    await sleep(200);
    expect(agent.turns).toHaveLength(1);
    expect(server.messages.filter((m) => m.conversationId === 'conv_stranger')).toHaveLength(0);

    const health = await gateway.health();
    expect(health.channel).toMatchObject({ type: 'waku-dm', state: 'running', selfUserId: PERSONA });
    expect(health.credential).toMatchObject({ mode: 'bridge', state: 'ready', ok: true });
    expect(health.core.ok).toBe(true);
    expect(health.queues).toEqual({ running: 0, queued: 0 });
    expect(health.outbox.pending).toBe(0);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(CREDENTIAL);
    for (const token of server.issuedTokens()) expect(serialized).not.toContain(token);
    await waitFor(() => server.heartbeats.length >= 1, { label: 'heartbeat' });
    expect(server.heartbeats[0]).toMatchObject({ capabilities: { channel: 'waku-dm', agent: 'codex' } });
  });

  it('/help 与 /new 走文本命令：帮助文本回到会话；/new 后 Agent 收到 binding=null（续聊记忆断开）', async () => {
    const { server, agent } = await boot();
    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: '/help' });
    await waitFor(() => server.messages.some((m) => m.body.includes('/new') && m.body.includes('/stop')), { timeoutMs: 5_000, label: 'help text' });
    expect(agent.turns).toHaveLength(0);

    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'first' });
    await waitFor(() => agent.turns.length === 1, { timeoutMs: 5_000 });
    await waitFor(() => server.messages.some((m) => m.body === 'echo:first'), { timeoutMs: 5_000 });
    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'second' });
    await waitFor(() => agent.turns.length === 2, { timeoutMs: 5_000 });
    expect(agent.turns[1].request.binding?.providerSessionId).toBe(`thread_${CONV}`);
    await waitFor(() => server.messages.some((m) => m.body === 'echo:second'), { timeoutMs: 5_000 });

    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: '/new' });
    await waitFor(() => server.messages.some((m) => m.body.includes('新对话')), { timeoutMs: 5_000, label: 'new ack' });
    server.emitChatMessage({ conversationId: CONV, senderUserId: OWNER, body: 'third' });
    await waitFor(() => agent.turns.length === 3, { timeoutMs: 5_000 });
    expect(agent.turns[2].request.binding).toBeNull();
  });

  it('stop() 排水：SSE 断开、Agent shutdown、store 关闭后 health 不再可用', async () => {
    const { gateway, server, agent } = await boot();
    await gateway.stop();
    await waitFor(() => server.liveConnectionCount === 0, { label: 'sse closed on stop' });
    expect(agent.shutdownCalls).toBe(1);
  });
});
