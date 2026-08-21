/**
 * waku-dm 的凭证提供者（契约 §3.2）。两种模式，同一个接口：
 *
 * - **bridge**：0600 文件里的长效凭证 `abc_<token_urlsafe(32)>` → `POST /agent-bridges/token`
 *   换 1h 短效 JWT（`aud=vi-agent-bridge`, `sub=persona_user_id`）。到期前 5 分钟重换；
 *   换发失败时旧 token 仍有效就继续用（stale）并指数退避（2s → 5min），旧 token 也过期才 fail closed。
 * - **session**：备选路径，用一个能登录的真账号的 `auth.json`（与 `waku` CLI 同一份文件）。
 *   `session_token` 未过期直接用；过期用 `refresh_token` 调 `POST /cli/auth/refresh`
 *   （形状以 `cli/waku/waku_cli.mjs::refreshCliSession` 为准：`{refresh_token}` → `{session_token, refresh_token}`）。
 *   服务端**旋转** refresh_token（旧的立刻作废），所以必须**原子写回**轮换后的 pair——不写回 = 自锁。
 *   刷新前先重读磁盘：CLI 可能已经替我们轮换过了，拿到新 token 就不该再烧一次 refresh_token。
 *
 * 纪律沿用 V1 credential-provider：文件权限不是 0600 就 fail closed；
 * 明文凭证 / JWT / refresh_token 不进 health、不进错误文案、不进日志。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface BridgeIdentity {
  /** daemon 自己在 Waku 上的 user id（bridge = persona，session = 登录账号）。 */
  userId: string;
  bridgeId?: string;
  ownerUserId?: string;
}

export interface BridgeTokenHealth {
  mode: 'bridge' | 'session';
  ok: boolean;
  /** unloaded=还没换过；ready=正常；stale=刷新失败但旧 token 仍有效；degraded=没有可用 token。 */
  state: 'unloaded' | 'ready' | 'stale' | 'degraded';
  expiresInSec: number;
  refreshFailures: number;
  lastError?: string;
}

export interface BridgeTokenProvider {
  readonly mode: 'bridge' | 'session';
  current(): Promise<string>;
  /** 401 的配合点：下一次 current() 必定重换。 */
  invalidate(): void;
  identity(): Promise<BridgeIdentity>;
  health(): BridgeTokenHealth;
}

export interface CredentialError extends Error {
  code: string;
}

export const BRIDGE_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
export const BRIDGE_TOKEN_BACKOFF = { baseMs: 2_000, maxMs: 5 * 60 * 1000 } as const;
export const BRIDGE_CREDENTIAL_PREFIX = 'abc_';
/** CLI 的口径（`sessionTokenExpired` skewSeconds=60）：exp 距现在不足 60s 视为已过期。 */
const SESSION_EXPIRY_SKEW_MS = 60 * 1000;

function credentialError(code: string, message: string): CredentialError {
  const error = new Error(message) as CredentialError;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// JWT（只解析不校验：我们拿到的 token 本来就是自己换出来的）
// ---------------------------------------------------------------------------

export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2 || parts[1].length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function expiryOf(token: string): number | null {
  const claims = decodeJwtClaims(token);
  const exp = claims?.['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

function subjectOf(token: string): string | null {
  const sub = decodeJwtClaims(token)?.['sub'];
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

// ---------------------------------------------------------------------------
// 文件纪律
// ---------------------------------------------------------------------------

function assertPrivateFile(file: string, codePrefix: string, hint: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw credentialError(`${codePrefix}_missing`, `${path.basename(file)} is missing at ${file}; ${hint}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    // 组/其他可读 = 凭证已经被别的用户看过了，不能当没事。
    throw credentialError(
      `${codePrefix}_insecure_file`,
      `${path.basename(file)} must not be readable by group/other (expected mode 0600); chmod 600 ${file}`,
    );
  }
  return stat;
}

/** 读 bridge 凭证明文：去空白、校验前缀与字符集。只在这里碰明文。 */
function readBridgeCredential(file: string): string {
  assertPrivateFile(file, 'bridge_credential', "issue one with 'waku agent-friend credential issue <bridge_id> --write <path>'");
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw credentialError('bridge_credential_unreadable', `${path.basename(file)} could not be read`);
  }
  const credential = text.trim();
  if (!credential.startsWith(BRIDGE_CREDENTIAL_PREFIX) || !/^[A-Za-z0-9_-]{20,200}$/.test(credential.slice(BRIDGE_CREDENTIAL_PREFIX.length))) {
    throw credentialError(
      'bridge_credential_invalid',
      `${path.basename(file)} does not contain a bridge credential (expected '${BRIDGE_CREDENTIAL_PREFIX}…' on a single line)`,
    );
  }
  return credential;
}

interface AuthFile {
  raw: Record<string, unknown>;
  sessionToken: string | null;
  refreshToken: string | null;
  apiBase: string | null;
  userId: string | null;
}

function readAuthFile(authPath: string): AuthFile {
  assertPrivateFile(authPath, 'session_auth', "log in with 'waku login' or point WAKU_GATEWAY_AUTH_PATH at an auth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    throw credentialError('session_auth_invalid', `${path.basename(authPath)} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw credentialError('session_auth_invalid', `${path.basename(authPath)} is not a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = raw[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    raw,
    sessionToken: str('session_token'),
    refreshToken: str('refresh_token'),
    apiBase: str('api_base')?.replace(/\/+$/, '') ?? null,
    userId: str('user_id'),
  };
}

/** 配置层用：session 模式缺省的 API base 来自 auth.json。文件不存在/不合法返回 null。 */
export function readAuthApiBase(authPath: string): string | null {
  try {
    return readAuthFile(authPath).apiBase;
  } catch {
    return null;
  }
}

/** 原子写回：临时文件 + rename，0600。其它键原样保留（CLI 还要读它们）。 */
function writeAuthFile(authPath: string, raw: Record<string, unknown>): void {
  const tmp = `${authPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, authPath);
}

// ---------------------------------------------------------------------------
// 公共引擎：缓存 + 刷新策略 + 退避
// ---------------------------------------------------------------------------

interface Minted {
  token: string;
  expiresAt: number;
  identity: BridgeIdentity;
}

interface EngineOptions {
  mode: 'bridge' | 'session';
  now: () => number;
  refreshSkewMs: number;
  backoff: { baseMs: number; maxMs: number };
  /** 走网络换一枚新 token。 */
  mint(): Promise<Minted>;
  /** 不走网络的来源（session：重读磁盘）。返回仍有效的就直接用。 */
  probe?(): Minted | null;
  degradedCode: string;
}

function createEngine(options: EngineOptions): BridgeTokenProvider {
  const { now, refreshSkewMs, backoff } = options;

  let cached: Minted | null = null;
  let refreshFailures = 0;
  let lastFailureAt = 0;
  let lastError: CredentialError | null = null;
  let inflight: Promise<void> | null = null;

  function expired(entry: Minted | null): boolean {
    return entry === null || entry.expiresAt <= now();
  }

  function nearExpiry(entry: Minted): boolean {
    return entry.expiresAt - now() <= refreshSkewMs;
  }

  function backoffAllows(): boolean {
    if (refreshFailures === 0) return true;
    const delay = Math.min(backoff.baseMs * 2 ** (refreshFailures - 1), backoff.maxMs);
    return now() - lastFailureAt >= delay;
  }

  /** single-flight：并发 current() 只换一次。 */
  function refresh(): Promise<void> {
    if (inflight !== null) return inflight;
    const pending = (async (): Promise<void> => {
      try {
        const probed = options.probe?.() ?? null;
        if (probed !== null && !expired(probed) && !nearExpiry(probed)) {
          cached = probed;
        } else {
          cached = await options.mint();
        }
        refreshFailures = 0;
        lastError = null;
      } catch (error) {
        refreshFailures += 1;
        lastFailureAt = now();
        lastError =
          typeof (error as CredentialError | undefined)?.code === 'string'
            ? (error as CredentialError)
            : credentialError('credential_refresh_failed', 'credential refresh failed');
        throw lastError;
      } finally {
        inflight = null;
      }
    })();
    inflight = pending;
    return pending;
  }

  async function current(): Promise<string> {
    if (cached === null || expired(cached)) {
      if (!backoffAllows()) {
        throw lastError ?? credentialError(options.degradedCode, 'credentials unavailable (backing off)');
      }
      await refresh();
    } else if (nearExpiry(cached) && backoffAllows()) {
      // 主动续期失败不是致命的：旧 token 还有效就继续用（stale）。
      await refresh().catch(() => undefined);
    }

    const live = cached;
    if (live === null || expired(live)) {
      throw lastError ?? credentialError(options.degradedCode, 'credentials are expired and could not be refreshed');
    }
    return live.token;
  }

  return {
    mode: options.mode,
    current,

    invalidate(): void {
      cached = null;
    },

    async identity(): Promise<BridgeIdentity> {
      await current();
      if (cached === null) throw credentialError(options.degradedCode, 'credentials unavailable');
      return { ...cached.identity };
    },

    health(): BridgeTokenHealth {
      const live = cached !== null && !expired(cached) ? cached : null;
      const state: BridgeTokenHealth['state'] =
        live !== null
          ? refreshFailures > 0
            ? 'stale'
            : 'ready'
          : refreshFailures > 0 || lastError !== null
            ? 'degraded'
            : 'unloaded';
      const health: BridgeTokenHealth = {
        mode: options.mode,
        ok: state === 'ready' || state === 'stale',
        state,
        expiresInSec: live === null ? 0 : Math.floor((live.expiresAt - now()) / 1000),
        refreshFailures,
      };
      if (lastError !== null) health.lastError = lastError.code;
      return health;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

function detailCode(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const detail = (body as Record<string, unknown>)['detail'];
    if (typeof detail === 'object' && detail !== null) {
      const code = (detail as Record<string, unknown>)['code'];
      if (typeof code === 'string' && code.length > 0) return code;
    }
  }
  return fallback;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// bridge 模式
// ---------------------------------------------------------------------------

export interface BridgeCredentialProviderOptions {
  credentialFile: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
  backoff?: { baseMs: number; maxMs: number };
}

export function createBridgeCredentialProvider(options: BridgeCredentialProviderOptions): BridgeTokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const apiBase = stripTrailingSlash(options.apiBase);

  async function mint(): Promise<Minted> {
    // 每次换发都重读文件：凭证轮换后改文件即可，不用重启。
    const credential = readBridgeCredential(options.credentialFile);

    let result: { status: number; json: unknown };
    try {
      result = await postJson(fetchImpl, `${apiBase}/agent-bridges/token`, { credential });
    } catch {
      throw credentialError('bridge_token_exchange_failed', 'token exchange request failed before a response arrived');
    }

    if (result.status === 401) {
      throw credentialError(
        'bridge_token_unauthenticated',
        'the bridge credential was rejected (revoked, expired or unknown); issue a new one with waku agent-friend credential issue',
      );
    }
    if (result.status === 403) {
      throw credentialError('bridge_disabled', `the bridge is disabled (${detailCode(result.json, 'agent_bridge_disabled')})`);
    }
    if (result.status < 200 || result.status >= 300) {
      throw credentialError('bridge_token_exchange_failed', `token exchange failed with HTTP ${result.status} (${detailCode(result.json, 'unknown')})`);
    }

    const payload = (typeof result.json === 'object' && result.json !== null ? result.json : {}) as Record<string, unknown>;
    const token = payload['access_token'];
    if (typeof token !== 'string' || token.length === 0) {
      throw credentialError('bridge_token_exchange_failed', 'token exchange response did not include access_token');
    }

    let expiresAt: number | null = null;
    if (typeof payload['expires_in'] === 'number' && Number.isFinite(payload['expires_in'])) {
      expiresAt = now() + payload['expires_in'] * 1000;
    } else if (typeof payload['expires_at'] === 'string') {
      const parsed = Date.parse(payload['expires_at']);
      if (!Number.isNaN(parsed)) expiresAt = parsed;
    }
    expiresAt ??= expiryOf(token);
    if (expiresAt === null) {
      throw credentialError('bridge_token_exchange_failed', 'token exchange response did not say when the token expires');
    }

    const personaUserId =
      typeof payload['persona_user_id'] === 'string' && payload['persona_user_id'].length > 0
        ? payload['persona_user_id']
        : subjectOf(token);
    if (personaUserId === null) {
      throw credentialError('bridge_token_exchange_failed', 'token exchange response did not identify the persona');
    }
    const identity: BridgeIdentity = { userId: personaUserId };
    if (typeof payload['bridge_id'] === 'string') identity.bridgeId = payload['bridge_id'];
    if (typeof payload['owner_user_id'] === 'string') identity.ownerUserId = payload['owner_user_id'];

    return { token, expiresAt, identity };
  }

  return createEngine({
    mode: 'bridge',
    now,
    refreshSkewMs: options.refreshSkewMs ?? BRIDGE_TOKEN_REFRESH_SKEW_MS,
    backoff: options.backoff ?? BRIDGE_TOKEN_BACKOFF,
    mint,
    degradedCode: 'bridge_token_degraded',
  });
}

// ---------------------------------------------------------------------------
// session 模式
// ---------------------------------------------------------------------------

export interface SessionCredentialProviderOptions {
  authPath: string;
  /** 缺省读 auth.json 的 api_base。 */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
  backoff?: { baseMs: number; maxMs: number };
}

export function createSessionCredentialProvider(options: SessionCredentialProviderOptions): BridgeTokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  function toMinted(auth: AuthFile): Minted | null {
    if (auth.sessionToken === null) return null;
    const expiresAt = expiryOf(auth.sessionToken);
    if (expiresAt === null) return null;
    const userId = auth.userId ?? subjectOf(auth.sessionToken);
    if (userId === null) return null;
    // CLI 口径：距过期不足 60s 当已过期
    return { token: auth.sessionToken, expiresAt: expiresAt - SESSION_EXPIRY_SKEW_MS, identity: { userId } };
  }

  function probe(): Minted | null {
    return toMinted(readAuthFile(options.authPath));
  }

  async function mint(): Promise<Minted> {
    const auth = readAuthFile(options.authPath);
    const fresh = toMinted(auth);
    if (fresh !== null && fresh.expiresAt > now()) return fresh;

    if (auth.refreshToken === null) {
      throw credentialError('session_refresh_failed', 'stored session is expired and auth.json has no refresh_token; run: waku login');
    }
    const apiBase = stripTrailingSlash(options.apiBase ?? auth.apiBase ?? '');
    if (apiBase.length === 0) {
      throw credentialError('session_auth_invalid', 'auth.json is missing api_base and WAKU_GATEWAY_API_BASE is not set; run: waku login');
    }

    let result: { status: number; json: unknown };
    try {
      result = await postJson(fetchImpl, `${apiBase}/cli/auth/refresh`, { refresh_token: auth.refreshToken });
    } catch {
      throw credentialError('session_refresh_failed', 'cli/auth/refresh request failed before a response arrived');
    }
    if (result.status < 200 || result.status >= 300) {
      throw credentialError(
        'session_refresh_failed',
        `cli/auth/refresh failed with HTTP ${result.status} (${detailCode(result.json, 'unknown')}); run: waku login`,
      );
    }
    const payload = (typeof result.json === 'object' && result.json !== null ? result.json : {}) as Record<string, unknown>;
    const sessionToken = payload['session_token'];
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
      throw credentialError('session_refresh_failed', 'cli/auth/refresh response did not include session_token; run: waku login');
    }
    const rotated = typeof payload['refresh_token'] === 'string' && payload['refresh_token'].length > 0 ? payload['refresh_token'] : auth.refreshToken;

    // 原子写回：服务端已经作废了旧 refresh_token，不写回下次就自锁。
    // 重读一次再合并：别把 CLI 刚写进去的别的键冲掉。
    const latest = readAuthFile(options.authPath);
    writeAuthFile(options.authPath, { ...latest.raw, session_token: sessionToken, refresh_token: rotated });

    const minted = toMinted({ ...latest, sessionToken, refreshToken: rotated });
    if (minted === null) {
      throw credentialError('session_refresh_failed', 'refreshed session_token is not a decodable JWT; run: waku login');
    }
    return minted;
  }

  return createEngine({
    mode: 'session',
    now,
    refreshSkewMs: options.refreshSkewMs ?? BRIDGE_TOKEN_REFRESH_SKEW_MS,
    backoff: options.backoff ?? BRIDGE_TOKEN_BACKOFF,
    mint,
    probe,
    degradedCode: 'session_token_degraded',
  });
}
