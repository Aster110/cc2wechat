/**
 * M4 · PairingFlow：pair_request → pair_accept 握手（RED）
 *
 * 架构 §5 配对流程 + 任务书 §1.2 安全金线。
 *
 * 这一层是**跨端字节级协议**，事实源是 Playable 侧
 * `waku-feed-codex-playable/src/protocol/{constants,crypto}.js` 与 `src/client/pairing-client.js`：
 *
 * - bootstrap 路由 = `pr_` + base64url(HKDF(ikm=utf8(token), salt=utf8('waku-pair-bootstrap-v1'),
 *   info=utf8('waku-mailbox-v1|route|pair|k1'), L=16))
 * - bootstrap 密钥 = 同 HKDF，info 里的 direction 换成 to_agent / to_player，L=32
 * - 正常流量的 purpose 是 `msg`，握手的 purpose 是 `pair` —— 两把钥匙永不通用
 * - Playable 只接受满足这些条件的 pair_accept：32 字节 channelSecret、keyVersion≥1、
 *   pairingId/endpointId/scopes 非空、routeId **不以 `pr_` 开头**
 *
 * 本文件里的期望值全部由测试侧独立 HKDF 算出（见 harness），不复用被测实现，
 * 这样"daemon 与 Playable 能不能互解"才是被真正证明的，而不是自证。
 */
import { describe, it, expect, afterEach } from 'vitest';

import type { GatewayStore } from '../../gateway/state/sqlite-store.js';
import type { PairingService } from '../../gateway/core/pairing-service.js';

import {
  ADMIN_ISSUER,
  ALL_SCOPES,
  FakeChannel,
  PAIR_ROUTE_PREFIX,
  T0,
  TestClock,
  captureAsync,
  keysOf,
  lazyModule,
  makePairingService,
  makeUuidV7,
  openTestStore,
  playerBootstrapKey,
  playerMessageKey,
  playerOpen,
  playerPairRouteId,
  playerSeal,
  randomNonce,
  randomToken,
  seedEndpoint,
  type ChannelAdapterApi,
  type InboundEnvelope,
  type IngressAck,
  type MailboxChunk,
  type MailboxDirection,
  type OpenInput,
  type SealInput,
  type SecurePayload,
  type TestStore,
} from './harness.js';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type PairingFlowApi = {
  /** 管理员签发 grant 后立刻登记：flow 由此算出 pr_ 路由并留住 bootstrap 材料。 */
  registerGrant(input: {
    grantId: string;
    token: string;
    expiresAt: number;
  }): Promise<{ pairRouteId: string }>;
  /** 当前仍在等待握手的 pr_ 路由（交给 mailbox adapter 去轮询）。 */
  routes(): string[];
  /** ingress 的 opener 对 pr_ 路由的委托入口。 */
  openPairChunks(input: OpenInput): Promise<SecurePayload>;
  sealPairChunks(input: SealInput): Promise<MailboxChunk[]>;
  handle(envelope: InboundEnvelope): Promise<IngressAck>;
};

type PairingFlowModule = {
  createPairingFlow(options: {
    store: GatewayStore;
    pairings: PairingService;
    channel: ChannelAdapterApi;
    now(): number;
    newMessageId(): string;
    ttlMs?: number;
  }): PairingFlowApi;
  derivePairRouteId(token: string, keyVersion?: number): Promise<string>;
  deriveBootstrapKey(input: {
    pairingToken: string;
    direction: MailboxDirection;
    keyVersion?: number;
  }): Promise<Uint8Array>;
};

const loadFlow = lazyModule<PairingFlowModule>('../../gateway/core/pairing-flow.js');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let handle: TestStore | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface Fixture {
  store: GatewayStore;
  clock: TestClock;
  channel: FakeChannel;
  pairings: PairingService;
  flow: PairingFlowApi;
  newMessageId: () => string;
}

async function setup(endpoint: { id: string; status?: 'active' | 'disabled' } = { id: 'aster-admin' }): Promise<Fixture> {
  handle = openTestStore();
  const store = handle.store;
  const clock = new TestClock();
  seedEndpoint(store, { id: endpoint.id, status: endpoint.status ?? 'active' });

  const pairings = makePairingService(store, clock);
  const channel = new FakeChannel();
  const newMessageId = makeUuidV7();
  const mod = await loadFlow();
  const flow = mod.createPairingFlow({
    store,
    pairings,
    channel,
    now: clock.now,
    newMessageId,
  });
  return { store, clock, channel, pairings, flow, newMessageId };
}

async function issueGrant(
  f: Fixture,
  endpointId = 'aster-admin',
): Promise<{ grantId: string; token: string; pairRouteId: string; expiresAt: number }> {
  const expiresAt = f.clock.now() + 600_000;
  const grant = await f.pairings.createGrant(
    { endpointId, scopes: ALL_SCOPES, expiresAt },
    ADMIN_ISSUER,
  );
  const registered = await f.flow.registerGrant({
    grantId: grant.grantId,
    token: grant.token,
    expiresAt,
  });
  return { grantId: grant.grantId, token: grant.token, pairRouteId: registered.pairRouteId, expiresAt };
}

/** 扮演 Playable：在 pr_ 路由上封一条 pair_request。 */
function playablePairRequest(
  token: string,
  now: number,
  messageId: string,
  overrides: Record<string, unknown> = {},
): { chunks: MailboxChunk[]; routeId: string } {
  const routeId = playerPairRouteId(token);
  const chunks = playerSeal({
    key: playerBootstrapKey({ token, direction: 'to_agent' }),
    routeId,
    messageId,
    direction: 'to_agent',
    kind: 'pair',
    keyVersion: 1,
    createdAt: now,
    expiresAt: now + 180_000,
    payload: {
      type: 'pair_request',
      clientNonce: randomNonce(),
      clientTimeMs: now,
      deviceLabel: 'playable',
      ...overrides,
    },
  });
  return { chunks, routeId };
}

function inbound(
  chunks: MailboxChunk[],
  payload: SecurePayload,
  receivedAt: number,
): InboundEnvelope {
  const head = chunks[0];
  return {
    channel: 'waku',
    routeId: head.routeId,
    messageId: head.messageId,
    kind: head.kind,
    keyVersion: head.keyVersion,
    createdAt: head.createdAt,
    expiresAt: head.expiresAt,
    receivedAt,
    payload,
  };
}

function asPayload(record: Record<string, unknown>): SecurePayload {
  return record as unknown as SecurePayload;
}

// ---------------------------------------------------------------------------
// 派生：必须与 Playable 逐字节一致
// ---------------------------------------------------------------------------

describe('M4 · bootstrap 派生与 Playable 逐字节一致', () => {
  it('derivePairRouteId 复现 pr_ + base64url(HKDF(token, waku-pair-bootstrap-v1, ...|route|pair|k1, 16))', async () => {
    const mod = await loadFlow();
    const token = randomToken();

    const derived = await mod.derivePairRouteId(token);
    expect(derived).toBe(playerPairRouteId(token));
    expect(derived.startsWith(PAIR_ROUTE_PREFIX)).toBe(true);
    // 16 字节 base64url = 22 字符，加 3 字符前缀
    expect(derived).toHaveLength(PAIR_ROUTE_PREFIX.length + 22);

    // 稳定且单向：同 token 恒等，不同 token 必不同
    expect(await mod.derivePairRouteId(token)).toBe(derived);
    expect(await mod.derivePairRouteId(`${token}x`)).not.toBe(derived);
    // 路由标签里不许残留 token 本体
    expect(derived).not.toContain(token);
  });

  it('deriveBootstrapKey 复现两个方向各 32 字节，且两方向互不相同、与长期 msg 密钥不同', async () => {
    const mod = await loadFlow();
    const token = randomToken();

    const toAgent = await mod.deriveBootstrapKey({ pairingToken: token, direction: 'to_agent' });
    const toPlayer = await mod.deriveBootstrapKey({ pairingToken: token, direction: 'to_player' });

    expect(Buffer.from(toAgent).toString('hex')).toBe(
      Buffer.from(playerBootstrapKey({ token, direction: 'to_agent' })).toString('hex'),
    );
    expect(Buffer.from(toPlayer).toString('hex')).toBe(
      Buffer.from(playerBootstrapKey({ token, direction: 'to_player' })).toString('hex'),
    );
    expect(toAgent).toHaveLength(32);
    expect(Buffer.from(toAgent).toString('hex')).not.toBe(Buffer.from(toPlayer).toString('hex'));

    // purpose 隔离：握手钥匙不得等于任何长期 msg 钥匙
    const asSecret = new Uint8Array(32);
    asSecret.set(toAgent.subarray(0, 32));
    const longTerm = playerMessageKey({
      channelSecret: asSecret,
      pairingId: 'pr_x',
      direction: 'to_agent',
    });
    expect(Buffer.from(toAgent).toString('hex')).not.toBe(Buffer.from(longTerm).toString('hex'));
  });

  it('keyVersion 进 info：k1 与 k2 派生出不同的路由与密钥', async () => {
    const mod = await loadFlow();
    const token = randomToken();
    expect(await mod.derivePairRouteId(token, 2)).not.toBe(await mod.derivePairRouteId(token, 1));
    const k1 = await mod.deriveBootstrapKey({ pairingToken: token, direction: 'to_agent', keyVersion: 1 });
    const k2 = await mod.deriveBootstrapKey({ pairingToken: token, direction: 'to_agent', keyVersion: 2 });
    expect(Buffer.from(k1).toString('hex')).not.toBe(Buffer.from(k2).toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// 正路径
// ---------------------------------------------------------------------------

describe('M4 · 握手正路径', () => {
  it('pair_request → 消费 grant → 建 pairing → 在同一 pr_ 路由回写 Playable 可接受的 pair_accept', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());

    // ingress 的 opener 把 pr_ 路由交给 flow：这里先证明它能解开 Playable 封的包
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });
    expect(opened.type).toBe('pair_request');

    const ack = await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));
    expect(ack).toEqual({ status: 'accepted' });

    // grant 已被原子消费
    expect(f.store.getGrant(grant.grantId)?.status).toBe('consumed');
    expect(f.store.countPairings()).toBe(1);

    // 回写落在同一个 pr_ 路由、kind=pair
    expect(f.channel.sent).toHaveLength(1);
    const outbound = f.channel.sent[0];
    expect(outbound.routeId).toBe(request.routeId);
    expect(outbound.kind).toBe('pair');

    const accept = outbound.payload;
    expect(accept.type).toBe('pair_accept');
    if (accept.type !== 'pair_accept') return;

    // 字段清单以 Playable envelope.js 为准
    expect(keysOf(accept as unknown as Record<string, unknown>)).toEqual([
      'channelSecret',
      'endpointId',
      'keyVersion',
      'pairingId',
      'principalId',
      'routeId',
      'scopes',
      'type',
    ]);

    // Playable 的 admitPairAccept 全部条件
    expect(typeof accept.pairingId).toBe('string');
    expect(accept.pairingId).not.toBe('');
    expect(typeof accept.routeId).toBe('string');
    expect(accept.routeId?.startsWith(PAIR_ROUTE_PREFIX)).toBe(false);
    expect(accept.routeId).not.toBe(request.routeId);
    expect(accept.keyVersion).toBe(1);
    expect(accept.endpointId).toBe('aster-admin');
    expect(accept.scopes).toEqual(ALL_SCOPES);

    const secret = Buffer.from(String(accept.channelSecret), 'base64url');
    expect(secret).toHaveLength(32);
    // 发出去的正是库里那把（master key wrapping 后能原样解出）
    const stored = f.store.getPairingSecret(String(accept.pairingId));
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored ?? new Uint8Array()).toString('hex')).toBe(secret.toString('hex'));
  });

  it('pair_accept 用 bootstrap to_player 密钥封装：Playable 侧独立密钥能原样解开', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });
    await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));

    const outbound = f.channel.sent[0];
    const sealInput: SealInput = {
      routeId: outbound.routeId,
      messageId: outbound.messageId,
      kind: outbound.kind,
      keyVersion: outbound.keyVersion,
      direction: 'to_player',
      createdAt: f.clock.now(),
      expiresAt: outbound.expiresAt,
      payload: outbound.payload,
    };
    const chunks = await f.flow.sealPairChunks(sealInput);
    expect(chunks.length).toBeGreaterThan(0);

    const decoded = playerOpen({
      key: playerBootstrapKey({ token: grant.token, direction: 'to_player' }),
      chunks,
    });
    expect(decoded['type']).toBe('pair_accept');
    expect(decoded['endpointId']).toBe('aster-admin');

    // 换一把钥匙（错 token / 长期钥匙）都必须解不开
    expect(() =>
      playerOpen({
        key: playerBootstrapKey({ token: `${grant.token}x`, direction: 'to_player' }),
        chunks,
      }),
    ).toThrow();
    expect(() =>
      playerOpen({
        key: playerBootstrapKey({ token: grant.token, direction: 'to_agent' }),
        chunks,
      }),
    ).toThrow();
  });

  it('握手拿到的 channelSecret 能直接派生长期 msg 方向密钥（双向互解真跑通）', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });
    await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));

    const accept = f.channel.sent[0].payload;
    expect(accept.type).toBe('pair_accept');
    if (accept.type !== 'pair_accept') return;

    const pairingId = String(accept.pairingId);
    const routeId = String(accept.routeId);
    const channelSecret = new Uint8Array(Buffer.from(String(accept.channelSecret), 'base64url'));

    // Playable 侧算出的 to_agent 长期钥匙，必须和 daemon 库里那把 secret 派生的一致
    const playerKey = playerMessageKey({ channelSecret, pairingId, direction: 'to_agent' });
    const daemonSecret = f.store.getPairingSecret(pairingId);
    expect(daemonSecret).not.toBeNull();
    const daemonKey = playerMessageKey({
      channelSecret: daemonSecret ?? new Uint8Array(32),
      pairingId,
      direction: 'to_agent',
    });
    expect(Buffer.from(playerKey).toString('hex')).toBe(Buffer.from(daemonKey).toString('hex'));

    // 用它封一条真 turn，AAD 里带的是握手回来的长期 routeId
    const turn = playerSeal({
      key: playerKey,
      routeId,
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'turn',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 300_000,
      payload: { type: 'turn', conversationId: 'conv-1', generation: 1, clientSeq: 0, text: 'ping' },
    });
    expect(turn[0].routeId).toBe(routeId);
    expect(turn[0].routeId.startsWith(PAIR_ROUTE_PREFIX)).toBe(false);
  });

  it('pair_accept 里绝不出现一次性 token 本体', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });
    await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));

    const serialized = JSON.stringify(f.channel.sent);
    expect(serialized).not.toContain(grant.token);
    expect(serialized).not.toContain(f.store.getGrant(grant.grantId)?.tokenHash ?? '__none__');
  });

  it('routes() 只列还在等的 pr_ 路由：配对成功后退役，过期后自动消失', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    expect(f.flow.routes()).toContain(grant.pairRouteId);

    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });
    await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));
    expect(f.flow.routes()).not.toContain(grant.pairRouteId);

    // 另一张 grant 只要过了期，也不该继续被轮询
    const stale = await issueGrant(f);
    expect(f.flow.routes()).toContain(stale.pairRouteId);
    f.clock.set(stale.expiresAt);
    expect(f.flow.routes()).not.toContain(stale.pairRouteId);
  });
});

// ---------------------------------------------------------------------------
// 安全负例
// ---------------------------------------------------------------------------

describe('M4 · 握手安全负例', () => {
  it('错 token：落到另一条 pr_ 路由，opener 报 permanent 失败，且不产生任何 pairing', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const wrongToken = randomToken();
    expect(playerPairRouteId(wrongToken)).not.toBe(grant.pairRouteId);

    const request = playablePairRequest(wrongToken, f.clock.now(), f.newMessageId());
    const error = await captureAsync(() =>
      f.flow.openPairChunks({
        routeId: request.routeId,
        messageId: request.chunks[0].messageId,
        kind: 'pair',
        keyVersion: 1,
        direction: 'to_agent',
        createdAt: f.clock.now(),
        expiresAt: f.clock.now() + 180_000,
        chunks: request.chunks,
      }),
    );
    expect(error.code).toBe('unknown_pair_route');
    expect(error.permanent).toBe(true);
    expect(String(error.message)).not.toContain(wrongToken);

    expect(f.store.countPairings()).toBe(0);
    expect(f.store.getGrant(grant.grantId)?.status).toBe('pending');
    expect(f.channel.sent).toHaveLength(0);
  });

  it('对的 pr_ 路由但错的 bootstrap 密钥：认证失败，标 permanent，不建 pairing、不回任何东西', async () => {
    const f = await setup();
    const grant = await issueGrant(f);

    // 攻击者知道路由（它是公开可见的），但没有 token
    const forged = playerSeal({
      key: playerBootstrapKey({ token: randomToken(), direction: 'to_agent' }),
      routeId: grant.pairRouteId,
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'pair',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      payload: { type: 'pair_request', clientNonce: randomNonce(), clientTimeMs: f.clock.now() },
    });

    const error = await captureAsync(() =>
      f.flow.openPairChunks({
        routeId: grant.pairRouteId,
        messageId: forged[0].messageId,
        kind: 'pair',
        keyVersion: 1,
        direction: 'to_agent',
        createdAt: f.clock.now(),
        expiresAt: f.clock.now() + 180_000,
        chunks: forged,
      }),
    );
    expect(error.code).toBe('chunk_auth_failed');
    expect(error.permanent).toBe(true);

    expect(f.store.countPairings()).toBe(0);
    expect(f.store.getGrant(grant.grantId)?.status).toBe('pending');
    expect(f.channel.sent).toHaveLength(0);
  });

  it('过期 grant：回 pair_reject，不建 pairing，且错误里不含 token/hash/secret', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });

    f.clock.set(grant.expiresAt); // now >= expiresAt 即失效（fail-closed）
    const ack = await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));

    expect(ack.status).toBe('rejected');
    expect(f.store.countPairings()).toBe(0);
    expect(f.channel.sent).toHaveLength(1);
    const reject = f.channel.sent[0].payload;
    expect(reject.type).toBe('pair_reject');
    if (reject.type !== 'pair_reject') return;
    expect(reject.code).toBe('grant_expired');
    expect(keysOf(reject as unknown as Record<string, unknown>)).toEqual(['code', 'type']);
    expect(JSON.stringify(f.channel.sent)).not.toContain(grant.token);
  });

  it('重放同一条 pair_request：grant 只被消费一次，绝不出现第二个 pairing', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });

    const first = await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));
    expect(first.status).toBe('accepted');

    const replay = await f.flow.handle(inbound(request.chunks, opened, f.clock.now() + 10));
    expect(replay.status).not.toBe('accepted');
    expect(f.store.countPairings()).toBe(1);
    expect(f.store.countPrincipals()).toBe(1);
    expect(f.store.countDevices()).toBe(1);
  });

  it('endpoint 在签发后被 disable：拒绝配对，且 grant 保持 pending（不许白白烧掉）', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const request = playablePairRequest(grant.token, f.clock.now(), f.newMessageId());
    const opened = await f.flow.openPairChunks({
      routeId: request.routeId,
      messageId: request.chunks[0].messageId,
      kind: 'pair',
      keyVersion: 1,
      direction: 'to_agent',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      chunks: request.chunks,
    });

    seedEndpoint(f.store, { id: 'aster-admin', status: 'disabled' });
    const ack = await f.flow.handle(inbound(request.chunks, opened, f.clock.now()));

    expect(ack.status).toBe('rejected');
    expect(f.store.countPairings()).toBe(0);
    expect(f.store.getGrant(grant.grantId)?.status).toBe('pending');
    const reject = f.channel.sent[0]?.payload;
    expect(reject?.type).toBe('pair_reject');
    if (reject?.type === 'pair_reject') expect(reject.code).toBe('endpoint_disabled');
  });

  it('pr_ 路由上塞的不是 pair_request（比如一条 turn）：拒绝，不建 pairing', async () => {
    const f = await setup();
    const grant = await issueGrant(f);
    const chunks = playerSeal({
      key: playerBootstrapKey({ token: grant.token, direction: 'to_agent' }),
      routeId: grant.pairRouteId,
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'pair',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      payload: { type: 'turn', conversationId: 'conv-1', generation: 1, clientSeq: 0, text: 'hi' },
    });

    const ack = await f.flow.handle(
      inbound(
        chunks,
        asPayload({ type: 'turn', conversationId: 'conv-1', generation: 1, clientSeq: 0, text: 'hi' }),
        f.clock.now(),
      ),
    );
    expect(ack.status).toBe('rejected');
    if (ack.status === 'rejected') expect(ack.code).toBe('invalid_pair_request');
    expect(f.store.countPairings()).toBe(0);
    expect(f.store.getGrant(grant.grantId)?.status).toBe('pending');
  });

  it('未登记的 pr_ 路由送来的 pair_request 直接拒（不做全信箱试解）', async () => {
    const f = await setup();
    const orphanToken = randomToken();
    const request = playablePairRequest(orphanToken, f.clock.now(), f.newMessageId());

    const ack = await f.flow.handle(
      inbound(
        request.chunks,
        asPayload({ type: 'pair_request', clientNonce: randomNonce(), clientTimeMs: T0 }),
        f.clock.now(),
      ),
    );
    expect(ack.status).toBe('rejected');
    if (ack.status === 'rejected') expect(ack.code).toBe('unknown_pair_route');
    expect(f.store.countPairings()).toBe(0);
    expect(f.channel.sent).toHaveLength(0);
  });

  it('两张 grant 各自独立：A 的 token 解不开 B 路由上的包，配对结果互不串台', async () => {
    const f = await setup();
    const a = await issueGrant(f);
    const b = await issueGrant(f);
    expect(a.pairRouteId).not.toBe(b.pairRouteId);

    // 用 A 的钥匙封，却发到 B 的路由 —— 认证必然失败
    const crossed = playerSeal({
      key: playerBootstrapKey({ token: a.token, direction: 'to_agent' }),
      routeId: b.pairRouteId,
      messageId: f.newMessageId(),
      direction: 'to_agent',
      kind: 'pair',
      createdAt: f.clock.now(),
      expiresAt: f.clock.now() + 180_000,
      payload: { type: 'pair_request', clientNonce: randomNonce(), clientTimeMs: f.clock.now() },
    });
    const error = await captureAsync(() =>
      f.flow.openPairChunks({
        routeId: b.pairRouteId,
        messageId: crossed[0].messageId,
        kind: 'pair',
        keyVersion: 1,
        direction: 'to_agent',
        createdAt: f.clock.now(),
        expiresAt: f.clock.now() + 180_000,
        chunks: crossed,
      }),
    );
    expect(error.code).toBe('chunk_auth_failed');
    expect(f.store.getGrant(a.grantId)?.status).toBe('pending');
    expect(f.store.getGrant(b.grantId)?.status).toBe('pending');
    expect(f.store.countPairings()).toBe(0);
  });
});
