/**
 * M1 · PairingService：原子消费、撤销、scope/endpoint/trust 授权（RED）
 *
 * 安全模型要点（架构 §5、§5.1；reviewer 一审第 2/7 条）：
 * - admin 授权**只**来自服务端注入的 `authorizeIssuer`。调用方自报的 `issuerTrustTier`
 *   一律是攻击输入，必须被拒；可信身份用对象 identity 表示，复制同字段的 context 不算数。
 * - 一次性 token 高熵（≥128 bit base64url），本地只留 tokenHash，明文只返回一次。
 * - grant 消费必须整体原子：mark consumed 与 principal/device/pairing 创建之间崩溃时，
 *   不许留半条。这里用真实 SQLite `BEFORE INSERT ON pairings` abort trigger 注入中途失败。
 * - expiry 一律 fail-closed：`now >= expiresAt` 不可消费；`createdAt >= expiresAt` 拒绝签发。
 *
 * 错误约定：createGrant / consumeGrant 失败时 reject 一个带 `code`（必要时带 `field`）的错误；
 * authorize 返回 decision union（便于断言"错误不泄密"）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type TrustTier = 'chat-only' | 'sandbox-workspace' | 'repo-pr' | 'admin-bypass';
type PairingScope =
  | 'chat.send'
  | 'conversation.new'
  | 'conversation.stop'
  | 'conversation.resume'
  | 'artifact.read';

type AgentEndpoint = {
  id: string;
  runnerProfileId: string;
  workspacePolicyId: string;
  trustTier: TrustTier;
  status: 'active' | 'disabled';
};

type GrantRow = {
  id: string;
  tokenHash: string;
  endpointId: string;
  scopes: PairingScope[];
  status: 'pending' | 'consumed' | 'expired' | 'revoked';
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
};

type PairingRow = {
  id: string;
  principalId: string;
  deviceId: string;
  endpointId: string;
  routeId: string;
  scopes: PairingScope[];
  secretCiphertext: string;
  keyVersion: number;
  status: 'active' | 'revoked';
  createdAt: number;
};

type GatewayTransaction = {
  upsertEndpoint(endpoint: AgentEndpoint): void;
};

type GatewayStoreApi = {
  readonly schemaVersion: number;
  transaction<T>(fn: (tx: GatewayTransaction) => T): T;
  getEndpoint(id: string): AgentEndpoint | null;
  getGrant(id: string): GrantRow | null;
  getPairing(id: string): PairingRow | null;
  getPairingSecret(id: string): Uint8Array | null;
  countPrincipals(): number;
  countDevices(): number;
  countPairings(): number;
  close(): void;
};

type SqliteStoreModule = {
  openGatewayStore(options: { dbPath: string; masterKeyPath: string }): GatewayStoreApi;
};

type IssuerContext = { readonly kind: string };
type IssuerDecision = { allowed: true; maxTrustTier: TrustTier } | { allowed: false; code: string };

type CreateGrantInput = {
  endpointId: string;
  scopes: PairingScope[];
  expiresAt: number;
};

type CreateGrantResult = {
  grantId: string;
  /** 明文只在这里出现一次，之后只剩 tokenHash */
  token: string;
  tokenHash: string;
  endpointId: string;
  scopes: PairingScope[];
  expiresAt: number;
};

type ConsumeGrantInput = { token: string; deviceLabel?: string };

type ConsumeGrantResult = {
  pairingId: string;
  principalId: string;
  deviceId: string;
  endpointId: string;
  routeId: string;
  channelSecret: Uint8Array;
  keyVersion: number;
  scopes: PairingScope[];
};

type AuthorizeInput = {
  pairingId: string;
  principalId: string;
  endpointId: string;
  scope: PairingScope;
};

type AuthorizeDecision =
  | { allowed: true; endpoint: AgentEndpoint; trustTier: TrustTier }
  | { allowed: false; code: string; message: string };

type PairingServiceApi = {
  createGrant(input: CreateGrantInput, context: IssuerContext): Promise<CreateGrantResult>;
  consumeGrant(input: ConsumeGrantInput): Promise<ConsumeGrantResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeDecision>;
  revokePairing(pairingId: string): Promise<void>;
};

type PairingServiceOptions = {
  store: GatewayStoreApi;
  now(): number;
  authorizeIssuer(context: IssuerContext): Promise<IssuerDecision>;
};

type PairingServiceModule = {
  createPairingService(options: PairingServiceOptions): PairingServiceApi;
};

type EnvelopeContractsModule = { MAX_CLOCK_SKEW_MS: number };

type GatewayError = Error & { code: string; field?: string };

function lazyModule<T>(specifier: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = import(specifier) as Promise<T>;
    return cached;
  };
}

const loadStore = lazyModule<SqliteStoreModule>('../../gateway/state/sqlite-store.js');
const loadService = lazyModule<PairingServiceModule>('../../gateway/core/pairing-service.js');
const loadEnvelope = lazyModule<EnvelopeContractsModule>('../../gateway/contracts/envelope.js');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NOW = 1_760_000_000_000;
const GRANT_TTL = 15 * 60_000;

const ADMIN_ENDPOINT: AgentEndpoint = {
  id: 'aster-admin',
  runnerProfileId: 'local-729a',
  workspacePolicyId: 'admin-home',
  trustTier: 'admin-bypass',
  status: 'active',
};

const GUEST_ENDPOINT: AgentEndpoint = {
  id: 'guest-sandbox',
  runnerProfileId: 'local-729a',
  workspacePolicyId: 'sandbox-guest',
  trustTier: 'sandbox-workspace',
  status: 'active',
};

/** 可信 admin 身份：由对象 identity 代表已认证的服务端 CLI 会话，字段可抄，身份抄不走。 */
const TRUSTED_ADMIN: IssuerContext = { kind: 'server-cli-session' };
const FORGED_ADMIN: IssuerContext = { kind: 'server-cli-session' };

let dir: string;
let dbPath: string;
let masterKeyPath: string;
let clock: number;
const opened: GatewayStoreApi[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-pairing-'));
  dbPath = path.join(dir, 'gateway.db');
  masterKeyPath = path.join(dir, 'master.key');
  clock = NOW;
});

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* 关不掉不该掩盖真正的断言失败 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function openStore(): Promise<GatewayStoreApi> {
  const mod = await loadStore();
  const store = mod.openGatewayStore({ dbPath, masterKeyPath });
  opened.push(store);
  return store;
}

async function bootstrap(
  endpoints: AgentEndpoint[] = [ADMIN_ENDPOINT],
): Promise<{ store: GatewayStoreApi; service: PairingServiceApi }> {
  // 先探本文件的主角模块：否则 sqlite-store 缺失会把 pairing-service 的路径完全遮住，
  // RED 证据里就看不见它（reviewer 两轮都点过这个观察点）。
  await loadService();
  const store = await openStore();
  store.transaction((tx) => {
    for (const e of endpoints) tx.upsertEndpoint(e);
  });
  const service = await makeService(store);
  return { store, service };
}

async function makeService(
  store: GatewayStoreApi,
  maxTrustTier: TrustTier = 'admin-bypass',
): Promise<PairingServiceApi> {
  const mod = await loadService();
  return mod.createPairingService({
    store,
    now: () => clock,
    authorizeIssuer: async (context) =>
      context === TRUSTED_ADMIN
        ? { allowed: true, maxTrustTier }
        : { allowed: false, code: 'issuer_not_authorized' },
  });
}

async function expectReject(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p;
  } catch (e) {
    return e as GatewayError;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function grantInput(overrides: Partial<CreateGrantInput> = {}): CreateGrantInput {
  return {
    endpointId: ADMIN_ENDPOINT.id,
    scopes: ['chat.send', 'conversation.new', 'conversation.stop'],
    expiresAt: NOW + GRANT_TTL,
    ...overrides,
  };
}

function withRawDb(fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

describe('M1 · Grant 签发', () => {
  it('签发高熵一次性 token：明文只回一次，库里只留 hash，且文件里搜不到明文', async () => {
    const { store, service } = await bootstrap();
    const grant = await service.createGrant(grantInput(), TRUSTED_ADMIN);

    // ≥128 bit 的 base64url（22 个 base64url 字符 = 132 bit），禁止 6 位数字码
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(Buffer.from(grant.token, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(grant.tokenHash).not.toBe(grant.token);
    expect(grant.token).not.toContain(grant.tokenHash);

    const second = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    expect(second.token).not.toBe(grant.token);
    expect(second.grantId).not.toBe(grant.grantId);

    const row = store.getGrant(grant.grantId);
    expect(row?.status).toBe('pending');
    expect(row?.tokenHash).toBe(grant.tokenHash);
    expect(JSON.stringify(row)).not.toContain(grant.token);

    store.close();
    expect(fs.readFileSync(dbPath).includes(Buffer.from(grant.token, 'utf8'))).toBe(false);
  });

  it('admin 授权只认服务端注入的 authorizeIssuer：伪造 context / 自报 issuerTrustTier 全部拒绝', async () => {
    const { service } = await bootstrap();

    // 字段完全一样、但不是同一个对象 —— 不算已认证
    const forged = await expectReject(service.createGrant(grantInput(), FORGED_ADMIN));
    expect(forged.code).toBe('issuer_not_authorized');

    // 即便拿着可信 context，调用方也不能夹带 issuerTrustTier —— 这个入参根本不存在
    const smuggled = await expectReject(
      service.createGrant(
        { ...grantInput(), issuerTrustTier: 'admin-bypass' } as unknown as CreateGrantInput,
        TRUSTED_ADMIN,
      ),
    );
    expect(smuggled.field).toBe('issuerTrustTier');

    // 可信 context 才能给 admin-bypass endpoint 签发
    const ok = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    expect(ok.endpointId).toBe('aster-admin');
  });

  it('signer 的信任上限由服务端决定：只能签不高于 maxTrustTier 的 endpoint', async () => {
    const store = await openStore();
    store.transaction((tx) => {
      tx.upsertEndpoint(ADMIN_ENDPOINT);
      tx.upsertEndpoint(GUEST_ENDPOINT);
    });
    const limited = await makeService(store, 'sandbox-workspace');

    const denied = await expectReject(limited.createGrant(grantInput(), TRUSTED_ADMIN));
    expect(denied.code).toBe('trust_tier_denied');

    const ok = await limited.createGrant(grantInput({ endpointId: GUEST_ENDPOINT.id }), TRUSTED_ADMIN);
    expect(ok.endpointId).toBe(GUEST_ENDPOINT.id);
  });

  it('签发期的时间边界 fail-closed：createdAt>=expiresAt 拒绝，有效期落在时钟偏移窗口内也拒绝', async () => {
    const { service } = await bootstrap();
    const skew = (await loadEnvelope()).MAX_CLOCK_SKEW_MS;

    expect((await expectReject(service.createGrant(grantInput({ expiresAt: clock }), TRUSTED_ADMIN))).code).toBe(
      'invalid_expiry',
    );
    expect(
      (await expectReject(service.createGrant(grantInput({ expiresAt: clock - 1 }), TRUSTED_ADMIN))).code,
    ).toBe('invalid_expiry');
    // 剩余寿命短于时钟不确定窗口 = 无法安全判定，直接拒绝
    expect(
      (await expectReject(service.createGrant(grantInput({ expiresAt: clock + skew - 1 }), TRUSTED_ADMIN))).code,
    ).toBe('invalid_expiry');

    const ok = await service.createGrant(grantInput({ expiresAt: clock + skew + 1 }), TRUSTED_ADMIN);
    expect(ok.expiresAt).toBe(clock + skew + 1);
  });

  it('拒绝未知 endpoint、空 scope 与词表外 scope', async () => {
    const { service } = await bootstrap();
    expect(
      (await expectReject(service.createGrant(grantInput({ endpointId: 'nope' }), TRUSTED_ADMIN))).code,
    ).toBe('endpoint_not_found');
    expect((await expectReject(service.createGrant(grantInput({ scopes: [] }), TRUSTED_ADMIN))).field).toBe('scopes');
    expect(
      (
        await expectReject(
          service.createGrant(
            grantInput({ scopes: ['shell.exec'] as unknown as PairingScope[] }),
            TRUSTED_ADMIN,
          ),
        )
      ).field,
    ).toBe('scopes');
  });
});

// ---------------------------------------------------------------------------

describe('M1 · Grant 消费', () => {
  it('消费成功：grant 变 consumed，生成独立 principal/device/pairing/routeId/长期密钥', async () => {
    const { store, service } = await bootstrap();
    const grant = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    const a = await service.consumeGrant({ token: grant.token, deviceLabel: 'iPhone' });

    expect(store.getGrant(grant.grantId)?.status).toBe('consumed');
    expect(store.getGrant(grant.grantId)?.consumedAt).toBe(clock);
    expect(a.endpointId).toBe('aster-admin');
    expect(a.scopes).toEqual(grant.scopes);
    expect(a.keyVersion).toBe(1);
    expect(a.channelSecret).toHaveLength(32);
    expect(a.routeId).not.toBe(a.pairingId);

    const row = store.getPairing(a.pairingId);
    expect(row?.status).toBe('active');
    // 长期密钥不以明文进持久对象
    expect(JSON.stringify(row)).not.toContain(Buffer.from(a.channelSecret).toString('base64url'));
    expect(Buffer.from(store.getPairingSecret(a.pairingId) ?? new Uint8Array()).toString('hex')).toBe(
      Buffer.from(a.channelSecret).toString('hex'),
    );

    // 第二个 grant → 完全独立的一套身份与密钥
    const grantB = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    const b = await service.consumeGrant({ token: grantB.token, deviceLabel: 'Android' });
    expect(b.principalId).not.toBe(a.principalId);
    expect(b.deviceId).not.toBe(a.deviceId);
    expect(b.pairingId).not.toBe(a.pairingId);
    expect(b.routeId).not.toBe(a.routeId);
    expect(Buffer.from(b.channelSecret).toString('hex')).not.toBe(Buffer.from(a.channelSecret).toString('hex'));
    expect(store.countPrincipals()).toBe(2);
    expect(store.countPairings()).toBe(2);
  });

  it('错 token / 过期 token / 已消费 token 全部拒绝，且错误消息不泄密', async () => {
    const { service } = await bootstrap();
    const grant = await service.createGrant(grantInput(), TRUSTED_ADMIN);

    const wrong = await expectReject(
      service.consumeGrant({ token: randomBytes(24).toString('base64url') }),
    );
    expect(wrong.code).toBe('grant_not_found');
    expect(wrong.message).not.toContain(grant.token);
    expect(wrong.message).not.toContain(grant.tokenHash);

    // 到期点即失效（不是 +1ms 才失效）
    clock = grant.expiresAt - 1;
    const stillOk = await service.createGrant(grantInput({ expiresAt: NOW + 2 * GRANT_TTL }), TRUSTED_ADMIN);
    clock = grant.expiresAt;
    expect((await expectReject(service.consumeGrant({ token: grant.token }))).code).toBe('grant_expired');
    clock = grant.expiresAt + 1;
    expect((await expectReject(service.consumeGrant({ token: grant.token }))).code).toBe('grant_expired');

    // 已消费的不能复用
    clock = NOW;
    await service.consumeGrant({ token: stillOk.token });
    const reused = await expectReject(service.consumeGrant({ token: stillOk.token }));
    expect(reused.code).toBe('grant_consumed');
    expect(reused.message).not.toContain(stillOk.token);
  });

  it('并发消费同一个 grant 只有一个成功，另一个拿到明确的已消费错误', async () => {
    const { store, service } = await bootstrap();
    const grant = await service.createGrant(grantInput(), TRUSTED_ADMIN);

    const results = await Promise.allSettled([
      service.consumeGrant({ token: grant.token, deviceLabel: 'A' }),
      service.consumeGrant({ token: grant.token, deviceLabel: 'B' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.code).toBe('grant_consumed');

    expect(store.countPairings()).toBe(1);
    expect(store.countPrincipals()).toBe(1);
    expect(store.getGrant(grant.grantId)?.status).toBe('consumed');
  });

  it('消费中途失败必须整体回滚：不留半个 principal/device/pairing，grant 仍可用', async () => {
    const { store, service } = await bootstrap();
    const grant = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    store.close();

    // 在 principal/device 已经进入事务之后、pairing 落库之前炸掉
    withRawDb((db) => {
      db.exec(
        `CREATE TRIGGER injected_pairing_failure BEFORE INSERT ON pairings
         BEGIN SELECT RAISE(ABORT, 'injected mid-transaction failure'); END;`,
      );
    });

    const broken = await openStore();
    const brokenService = await makeService(broken);
    await expectReject(brokenService.consumeGrant({ token: grant.token }));
    expect(broken.getGrant(grant.grantId)?.status).toBe('pending');
    expect(broken.countPrincipals()).toBe(0);
    expect(broken.countDevices()).toBe(0);
    expect(broken.countPairings()).toBe(0);
    broken.close();

    // 重开数据库结论不变
    const reopened = await openStore();
    expect(reopened.getGrant(grant.grantId)?.status).toBe('pending');
    expect(reopened.countPrincipals()).toBe(0);
    reopened.close();

    // 移除注入后，同一个 token 仍然可以正常消费
    withRawDb((db) => db.exec('DROP TRIGGER injected_pairing_failure'));
    const healthy = await openStore();
    const healthyService = await makeService(healthy);
    const pairing = await healthyService.consumeGrant({ token: grant.token });
    expect(pairing.pairingId).toBeTruthy();
    expect(healthy.getGrant(grant.grantId)?.status).toBe('consumed');
    expect(healthy.countPairings()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('M1 · 授权判定', () => {
  it('scope 不足、endpoint 未绑定、endpoint 被 disabled 都拒绝', async () => {
    const store = await openStore();
    store.transaction((tx) => {
      tx.upsertEndpoint(ADMIN_ENDPOINT);
      tx.upsertEndpoint(GUEST_ENDPOINT);
    });
    const service = await makeService(store);

    const grant = await service.createGrant(grantInput({ scopes: ['chat.send'] }), TRUSTED_ADMIN);
    const p = await service.consumeGrant({ token: grant.token });

    const ok = await service.authorize({
      pairingId: p.pairingId,
      principalId: p.principalId,
      endpointId: p.endpointId,
      scope: 'chat.send',
    });
    expect(ok.allowed).toBe(true);
    if (ok.allowed) expect(ok.trustTier).toBe('admin-bypass');

    const noScope = await service.authorize({
      pairingId: p.pairingId,
      principalId: p.principalId,
      endpointId: p.endpointId,
      scope: 'conversation.new',
    });
    expect(noScope.allowed).toBe(false);
    if (!noScope.allowed) expect(noScope.code).toBe('scope_denied');

    // 非本 pairing 绑定的 endpoint 不能被路由到
    const wrongEndpoint = await service.authorize({
      pairingId: p.pairingId,
      principalId: p.principalId,
      endpointId: GUEST_ENDPOINT.id,
      scope: 'chat.send',
    });
    expect(wrongEndpoint.allowed).toBe(false);
    if (!wrongEndpoint.allowed) expect(wrongEndpoint.code).toBe('endpoint_not_bound');

    // 配对之后 endpoint 被停用 → 立刻拒绝
    store.transaction((tx) => tx.upsertEndpoint({ ...ADMIN_ENDPOINT, status: 'disabled' }));
    const disabled = await service.authorize({
      pairingId: p.pairingId,
      principalId: p.principalId,
      endpointId: p.endpointId,
      scope: 'chat.send',
    });
    expect(disabled.allowed).toBe(false);
    if (!disabled.allowed) expect(disabled.code).toBe('endpoint_disabled');
  });

  it('非 admin pairing 无法路由到 admin-bypass endpoint（不得偷用 aster 凭证）', async () => {
    const store = await openStore();
    store.transaction((tx) => {
      tx.upsertEndpoint(ADMIN_ENDPOINT);
      tx.upsertEndpoint(GUEST_ENDPOINT);
    });
    const service = await makeService(store);

    const guestGrant = await service.createGrant(
      grantInput({ endpointId: GUEST_ENDPOINT.id, scopes: ['chat.send'] }),
      TRUSTED_ADMIN,
    );
    const guest = await service.consumeGrant({ token: guestGrant.token });
    expect(guest.endpointId).toBe(GUEST_ENDPOINT.id);

    const escalate = await service.authorize({
      pairingId: guest.pairingId,
      principalId: guest.principalId,
      endpointId: ADMIN_ENDPOINT.id,
      scope: 'chat.send',
    });
    expect(escalate.allowed).toBe(false);
    if (!escalate.allowed) expect(escalate.code).toBe('endpoint_not_bound');
  });

  it('两个 pairing 的 principal/pairing 交叉组合一律拒绝', async () => {
    const { service } = await bootstrap();
    const ga = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    const gb = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    const a = await service.consumeGrant({ token: ga.token });
    const b = await service.consumeGrant({ token: gb.token });

    const cross1 = await service.authorize({
      pairingId: a.pairingId,
      principalId: b.principalId,
      endpointId: a.endpointId,
      scope: 'chat.send',
    });
    expect(cross1.allowed).toBe(false);
    if (!cross1.allowed) expect(cross1.code).toBe('principal_mismatch');

    const cross2 = await service.authorize({
      pairingId: b.pairingId,
      principalId: a.principalId,
      endpointId: b.endpointId,
      scope: 'chat.send',
    });
    expect(cross2.allowed).toBe(false);
    if (!cross2.allowed) expect(cross2.code).toBe('principal_mismatch');

    // 未知 pairing 不得因为 principal 对得上就放行
    const unknown = await service.authorize({
      pairingId: 'pr_does_not_exist',
      principalId: a.principalId,
      endpointId: a.endpointId,
      scope: 'chat.send',
    });
    expect(unknown.allowed).toBe(false);
    if (!unknown.allowed) expect(unknown.code).toBe('pairing_not_found');
  });

  it('撤销 pairing 后立即拒绝，且错误不泄密；撤销状态可跨重开保持', async () => {
    const { store, service } = await bootstrap();
    const grant = await service.createGrant(grantInput(), TRUSTED_ADMIN);
    const p = await service.consumeGrant({ token: grant.token });
    const secretB64 = Buffer.from(p.channelSecret).toString('base64url');

    await service.revokePairing(p.pairingId);
    const denied = await service.authorize({
      pairingId: p.pairingId,
      principalId: p.principalId,
      endpointId: p.endpointId,
      scope: 'chat.send',
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.code).toBe('pairing_revoked');
      expect(denied.message).not.toContain(secretB64);
      expect(denied.message).not.toContain(grant.token);
      expect(denied.message).not.toContain(p.routeId);
    }
    expect(store.getPairing(p.pairingId)?.status).toBe('revoked');

    store.close();
    const reopened = await openStore();
    const reopenedService = await makeService(reopened);
    expect(reopened.getPairing(p.pairingId)?.status).toBe('revoked');
    const afterRestart = await reopenedService.authorize({
      pairingId: p.pairingId,
      principalId: p.principalId,
      endpointId: p.endpointId,
      scope: 'chat.send',
    });
    expect(afterRestart.allowed).toBe(false);
  });
});
