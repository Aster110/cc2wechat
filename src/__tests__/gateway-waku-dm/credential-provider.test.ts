/**
 * waku-dm · 凭证提供者（RED）
 *
 * 契约 §3.2：
 * - bridge 模式：0600 文件里的 `abc_…` 明文 → `POST /agent-bridges/token` 换 1h JWT，到期前 5 分钟重换；
 *   401 → 立即重换一次再失败则 degraded（指数退避，上限 5 分钟）；明文凭证与 JWT 不进日志/health/错误文案。
 * - session 模式：读 auth.json；`session_token` 未过期直接用；过期用 `refresh_token` 调
 *   `POST /cli/auth/refresh` 并**原子写回**轮换后的 pair（不写回 = 自锁：旧 refresh_token 已被服务端作废）。
 *
 * 权限纪律沿用 V1 credential-provider：文件不是 0600 就 fail closed。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBridgeCredentialProvider,
  createSessionCredentialProvider,
  decodeJwtClaims,
  readAuthApiBase,
} from '../../gateway/channels/waku-dm/credential-provider.js';
import { FakeBridgeServer } from './fake-bridge-server.js';

const PERSONA = 'usr_persona_000000000000000000001';
const OWNER = 'usr_8c8b6c0329f140cd8dc78dfcff7ddeec';
const CREDENTIAL = 'abc_XfQ1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E0';

let dir: string;
let server: FakeBridgeServer;
let clock: number;
const now = (): number => clock;

async function captureError(fn: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected rejection');
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-cred-'));
  clock = 1_760_000_000_000;
  server = new FakeBridgeServer({ personaUserId: PERSONA, ownerUserId: OWNER, credential: CREDENTIAL, now, tokenTtlSec: 3600 });
  await server.start();
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeCredentialFile(content = `${CREDENTIAL}\n`, mode = 0o600): string {
  const file = path.join(dir, 'bridge.credential');
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

// ---------------------------------------------------------------------------
// bridge 模式
// ---------------------------------------------------------------------------

describe('waku-dm · bridge 凭证：文件纪律', () => {
  it('文件缺失 → bridge_credential_missing，错误文案说人话（指向 waku agent-friend credential issue --write）', async () => {
    const provider = createBridgeCredentialProvider({ credentialFile: path.join(dir, 'nope'), apiBase: server.apiBase, now });
    const error = await captureError(() => provider.current());
    expect(error.code).toBe('bridge_credential_missing');
    expect(error.message).toContain('agent-friend credential issue');
  });

  it('权限不是 0600（组/其他可读）→ fail closed，不发任何网络请求', async () => {
    const file = writeCredentialFile(undefined, 0o644);
    const provider = createBridgeCredentialProvider({ credentialFile: file, apiBase: server.apiBase, now });
    const error = await captureError(() => provider.current());
    expect(error.code).toBe('bridge_credential_insecure_file');
    expect(server.tokenCalls).toBe(0);
    expect(error.message).not.toContain(CREDENTIAL);
  });

  it('内容不是 abc_ 前缀 → bridge_credential_invalid，且不把内容回显进错误', async () => {
    const file = writeCredentialFile('rt_not_a_bridge_credential_at_all_0123456789\n');
    const provider = createBridgeCredentialProvider({ credentialFile: file, apiBase: server.apiBase, now });
    const error = await captureError(() => provider.current());
    expect(error.code).toBe('bridge_credential_invalid');
    expect(error.message).not.toContain('rt_not_a_bridge');
    expect(server.tokenCalls).toBe(0);
  });
});

describe('waku-dm · bridge 凭证：换发与刷新', () => {
  it('首次 current() 换 token 并缓存；identity() 给出 persona / bridge / owner；health 不含 token', async () => {
    const file = writeCredentialFile();
    const provider = createBridgeCredentialProvider({ credentialFile: file, apiBase: server.apiBase, now });

    const token = await provider.current();
    expect(server.issuedTokens()).toContain(token);
    expect(await provider.current()).toBe(token);
    expect(server.tokenCalls).toBe(1);

    const who = await provider.identity();
    expect(who).toEqual({ userId: PERSONA, bridgeId: server.bridgeId, ownerUserId: OWNER });

    const health = provider.health();
    expect(health.mode).toBe('bridge');
    expect(health.state).toBe('ready');
    expect(health.ok).toBe(true);
    expect(health.expiresInSec).toBeGreaterThan(3000);
    expect(JSON.stringify(health)).not.toContain(token);
    expect(JSON.stringify(health)).not.toContain(CREDENTIAL);
    // 请求体里是明文凭证（这是协议），但 Authorization 头绝不带它
    const exchange = server.requestsTo('/api/v1/agent-bridges/token')[0];
    expect(exchange.body).toEqual({ credential: CREDENTIAL });
  });

  it('到期前 5 分钟（refreshSkew）主动重换；没到点不碰网络', async () => {
    const file = writeCredentialFile();
    const provider = createBridgeCredentialProvider({ credentialFile: file, apiBase: server.apiBase, now });
    const first = await provider.current();

    clock += 50 * 60 * 1000; // 还剩 10 分钟
    expect(await provider.current()).toBe(first);
    expect(server.tokenCalls).toBe(1);

    clock += 6 * 60 * 1000; // 还剩 4 分钟 < 5 分钟 skew
    const second = await provider.current();
    expect(second).not.toBe(first);
    expect(server.tokenCalls).toBe(2);
    expect(decodeJwtClaims(second)?.['sub']).toBe(PERSONA);
  });

  it('invalidate() 后下一次 current() 必定重换（401 路径的配合点）', async () => {
    const file = writeCredentialFile();
    const provider = createBridgeCredentialProvider({ credentialFile: file, apiBase: server.apiBase, now });
    const first = await provider.current();
    provider.invalidate();
    const second = await provider.current();
    expect(second).not.toBe(first);
    expect(server.tokenCalls).toBe(2);
  });

  it('换发 401（凭证被吊销）→ degraded，指数退避期内不重复打服务端；health 标红且不含凭证', async () => {
    const file = writeCredentialFile();
    server.credentialRevoked = true;
    const provider = createBridgeCredentialProvider({
      credentialFile: file,
      apiBase: server.apiBase,
      now,
      backoff: { baseMs: 2_000, maxMs: 300_000 },
    });

    const error = await captureError(() => provider.current());
    expect(error.code).toBe('bridge_token_unauthenticated');
    expect(error.message).not.toContain(CREDENTIAL);
    expect(server.tokenCalls).toBe(1);

    // 退避期内再来：不打网络
    clock += 500;
    await captureError(() => provider.current());
    expect(server.tokenCalls).toBe(1);

    // 退避过了才再试
    clock += 2_000;
    await captureError(() => provider.current());
    expect(server.tokenCalls).toBe(2);

    const health = provider.health();
    expect(health.ok).toBe(false);
    expect(health.state).toBe('degraded');
    expect(health.refreshFailures).toBe(2);
    expect(JSON.stringify(health)).not.toContain(CREDENTIAL);
  });

  it('刷新失败但旧 token 仍有效 → 继续用旧的（stale），不 fail closed', async () => {
    const file = writeCredentialFile();
    const provider = createBridgeCredentialProvider({ credentialFile: file, apiBase: server.apiBase, now });
    const first = await provider.current();

    clock += 56 * 60 * 1000; // 进入 skew 窗口，但旧 token 还有 4 分钟
    server.failNextTokenExchange(503);
    expect(await provider.current()).toBe(first);
    expect(provider.health().state).toBe('stale');
    expect(provider.health().ok).toBe(true);
  });

  it('bridge disabled（403）→ bridge_disabled，不是泛化的 unauthenticated', async () => {
    const file = writeCredentialFile();
    server.bridgeStatus = 'disabled';
    const provider = createBridgeCredentialProvider({ credentialFile: file, apiBase: server.apiBase, now });
    const error = await captureError(() => provider.current());
    expect(error.code).toBe('bridge_disabled');
  });
});

// ---------------------------------------------------------------------------
// session 模式
// ---------------------------------------------------------------------------

interface AuthFile {
  user_id: string;
  session_token: string;
  refresh_token: string;
  api_base: string;
  display_name?: string;
  web_base?: string;
}

function writeAuth(auth: AuthFile, mode = 0o600): string {
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

describe('waku-dm · session 凭证（auth.json）', () => {
  it('session_token 未过期 → 直接用，不碰网络；identity 来自 user_id；readAuthApiBase 读 api_base', async () => {
    const token = server.issueSessionToken(OWNER, 3600);
    const file = writeAuth({ user_id: OWNER, session_token: token, refresh_token: 'rt_seed', api_base: server.apiBase, display_name: 'aster' });
    const provider = createSessionCredentialProvider({ authPath: file, now });

    expect(await provider.current()).toBe(token);
    expect(await provider.identity()).toEqual({ userId: OWNER });
    expect(server.refreshCalls).toBe(0);
    expect(provider.health().mode).toBe('session');
    expect(readAuthApiBase(file)).toBe(server.apiBase);
  });

  it('过期 → /cli/auth/refresh 换新 pair 并原子写回（其它键保留、0600）', async () => {
    const expired = server.issueSessionToken(OWNER, -10);
    server.seedRefreshToken('rt_seed', OWNER);
    const file = writeAuth({ user_id: OWNER, session_token: expired, refresh_token: 'rt_seed', api_base: server.apiBase, display_name: 'aster', web_base: 'https://web.example' });
    const provider = createSessionCredentialProvider({ authPath: file, now });

    const fresh = await provider.current();
    expect(fresh).not.toBe(expired);
    expect(server.refreshCalls).toBe(1);

    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as AuthFile;
    expect(written.session_token).toBe(fresh);
    expect(written.refresh_token).not.toBe('rt_seed');
    expect(written.display_name).toBe('aster');
    expect(written.web_base).toBe('https://web.example');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // 目录里不能留临时文件
    expect(fs.readdirSync(dir).filter((name) => name !== 'auth.json')).toEqual([]);

    // 第二次 current() 不再刷新
    expect(await provider.current()).toBe(fresh);
    expect(server.refreshCalls).toBe(1);
  });

  it('refresh 401（refresh_token 已作废）→ degraded 且文件不被改写', async () => {
    const expired = server.issueSessionToken(OWNER, -10);
    const file = writeAuth({ user_id: OWNER, session_token: expired, refresh_token: 'rt_dead', api_base: server.apiBase });
    const before = fs.readFileSync(file, 'utf8');
    const provider = createSessionCredentialProvider({ authPath: file, now });

    const error = await captureError(() => provider.current());
    expect(error.code).toBe('session_refresh_failed');
    expect(error.message).toContain('waku login');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(provider.health().state).toBe('degraded');
  });

  it('auth.json 不是 0600 → fail closed', async () => {
    const token = server.issueSessionToken(OWNER, 3600);
    const file = writeAuth({ user_id: OWNER, session_token: token, refresh_token: 'rt', api_base: server.apiBase }, 0o644);
    const provider = createSessionCredentialProvider({ authPath: file, now });
    const error = await captureError(() => provider.current());
    expect(error.code).toBe('session_auth_insecure_file');
  });

  it('另一进程（waku CLI）已经轮换过文件：刷新前重读磁盘，拿到新 token 就不打 refresh', async () => {
    const expired = server.issueSessionToken(OWNER, -10);
    const file = writeAuth({ user_id: OWNER, session_token: expired, refresh_token: 'rt_seed', api_base: server.apiBase });
    const provider = createSessionCredentialProvider({ authPath: file, now });
    // 先成功一次，让 provider 缓存住
    server.seedRefreshToken('rt_seed', OWNER);
    const first = await provider.current();
    expect(server.refreshCalls).toBe(1);

    // 走到过期；与此同时 CLI 在磁盘上写了一枚更新的 token
    clock += 3700 * 1000;
    const cliToken = server.issueSessionToken(OWNER, 3600);
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as AuthFile;
    writeAuth({ ...current, session_token: cliToken, refresh_token: 'rt_from_cli' });

    const next = await provider.current();
    expect(next).toBe(cliToken);
    expect(next).not.toBe(first);
    expect(server.refreshCalls).toBe(1);
  });

  it('decodeJwtClaims：三段 base64url 能解 sub/exp；坏 token 返回 null', () => {
    const token = server.issueSessionToken(OWNER, 60);
    const claims = decodeJwtClaims(token);
    expect(claims?.['sub']).toBe(OWNER);
    expect(typeof claims?.['exp']).toBe('number');
    expect(decodeJwtClaims('garbage')).toBeNull();
    expect(decodeJwtClaims('a.!!!.c')).toBeNull();
  });
});
