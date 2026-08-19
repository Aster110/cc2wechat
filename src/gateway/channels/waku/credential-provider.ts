/**
 * Runtime 凭证提供者（架构 §8 / 任务书 §4.2）。
 *
 * 输入是**真 CLI 的产物**，不是我们自己定的 JSON：
 * `waku agent bootstrap --write-runtime-js <path>` 写出的是一段 JS
 *   `window.__POLYVERSE_RUNTIME__ = Object.assign({}, window.__POLYVERSE_RUNTIME__ || {}, {…})`
 * （`cli/waku/waku_cli.mjs::buildRuntimeBootstrapScript`），文件以 0600 落盘。
 *
 * 所以这里**只做文本抽取 + JSON.parse，绝不 eval**：那是磁盘上的一段可执行文本，
 * 拿它当代码跑 = 给任何能写这个文件的人一次 RCE。同理，权限不是 0600 就 fail closed——
 * token 已经被别的用户看过了，装作没事等于把 runtime 凭证当公开配置。
 *
 * 刷新策略：到期前 `refreshSkewMs`（默认 5 分钟）重铸；失败时**保留仍有效的旧 token**
 * 并指数退避（不循环刷）；旧 token 也过期了才 fail closed。
 * token / sessionId 不进 health、不进 lastRefreshError、不进任何日志。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeCredentials {
  token: string;
  sessionId: string;
  apiBaseUrl: string;
  origin: string;
  /** epoch ms（文件里可能是 ISO 串，归一在这里做）。 */
  expiresAt: number;
  capabilities: readonly string[];
}

export interface CredentialHealth {
  ok: boolean;
  /** ready=正常；stale=刷新失败但旧 token 仍有效；degraded=已过期且刷不出来。 */
  state: 'ready' | 'stale' | 'degraded';
  expiresInSec: number;
  refreshFailures: number;
  lastRefreshError?: string;
}

export interface RuntimeCredentialProvider {
  current(): Promise<RuntimeCredentials>;
  refresh(): Promise<void>;
  health(): CredentialHealth;
}

export interface RuntimeCredentialProviderOptions {
  runtimeJsPath: string;
  /** 重新执行 bootstrap（真实实现是 spawn waku CLI；测试注入函数）。 */
  mint: () => Promise<void>;
  now: () => number;
  refreshSkewMs?: number;
  requiredCapabilities?: readonly string[];
  backoff?: { baseMs: number; maxMs: number };
}

export interface CredentialError extends Error {
  code: string;
}

export const RUNTIME_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export const REQUIRED_RUNTIME_CAPABILITIES: readonly string[] = ['datastore.read', 'datastore.write'];

const DEFAULT_BACKOFF = { baseMs: 2_000, maxMs: 5 * 60 * 1000 } as const;

/** bootstrap 脚本里锚定 payload 的那一句；找不到就说明文件不是 bootstrap 产物。 */
const PAYLOAD_ANCHOR = '__POLYVERSE_RUNTIME__ || {}';

function credentialError(code: string, message: string): CredentialError {
  const err = new Error(message) as CredentialError;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// 解析（纯文本，不执行）
// ---------------------------------------------------------------------------

/** 从 `{` 起做 string-aware 的花括号配平，取出完整 JSON 对象文本。 */
function sliceBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractPayload(text: string): Record<string, unknown> | null {
  const anchor = text.lastIndexOf(PAYLOAD_ANCHOR);
  if (anchor < 0) return null;
  const start = text.indexOf('{', anchor + PAYLOAD_ANCHOR.length);
  if (start < 0) return null;
  const slice = sliceBalancedObject(text, start);
  if (slice === null) return null;
  let parsed: unknown;
  try {
    // `<\/` 是 CLI 为防 </script> 做的转义，JSON 本身就认这个 escape，不用手工还原。
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function normalizeExpiry(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createRuntimeCredentialProvider(
  options: RuntimeCredentialProviderOptions,
): RuntimeCredentialProvider {
  const { runtimeJsPath, mint, now } = options;
  const refreshSkewMs = options.refreshSkewMs ?? RUNTIME_TOKEN_REFRESH_SKEW_MS;
  const requiredCapabilities = options.requiredCapabilities ?? REQUIRED_RUNTIME_CAPABILITIES;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const fileLabel = path.basename(runtimeJsPath);

  let cached: RuntimeCredentials | null = null;
  let refreshFailures = 0;
  let lastFailureAt = 0;
  let lastRefreshError: string | undefined;
  let inflight: Promise<void> | null = null;

  /** 只抹掉已知的两个 secret，外加 rt_/rts_ 形状兜底（凭证还没加载时也管用）。 */
  function redact(text: string): string {
    let out = text;
    if (cached) {
      out = out.split(cached.token).join('[redacted]');
      out = out.split(cached.sessionId).join('[redacted]');
    }
    return out.replace(/\brts?_[A-Za-z0-9_-]{6,}/g, '[redacted]');
  }

  function readFromDisk(): RuntimeCredentials {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(runtimeJsPath);
    } catch {
      throw credentialError(
        'waku_credential_missing',
        `runtime credentials are missing at ${runtimeJsPath}; run 'waku agent bootstrap --write-runtime-js <path>' first`,
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      // 组/其他可读 = token 已经被别的用户看过了，不能当没事。
      throw credentialError(
        'waku_credential_insecure_file',
        `${fileLabel} must not be readable by group/other (expected mode 0600); re-run waku agent bootstrap`,
      );
    }

    let text: string;
    try {
      text = fs.readFileSync(runtimeJsPath, 'utf8');
    } catch {
      throw credentialError(
        'waku_credential_unreadable',
        `${fileLabel} could not be read`,
      );
    }

    const payload = extractPayload(text);
    if (!payload) {
      throw credentialError(
        'waku_credential_unreadable',
        `${fileLabel} is not a waku agent bootstrap product (payload not found)`,
      );
    }

    const token = nonEmptyString(payload['runtimeToken']);
    const sessionId = nonEmptyString(payload['sessionId']);
    const apiBaseUrl = nonEmptyString(payload['apiBaseUrl']);
    const origin = nonEmptyString(payload['origin']);
    const expiresAt = normalizeExpiry(payload['expiresAt']);
    const rawCapabilities = payload['capabilities'];
    const capabilities =
      Array.isArray(rawCapabilities) && rawCapabilities.every((item) => typeof item === 'string')
        ? (rawCapabilities as string[])
        : null;

    if (!token || !sessionId || !apiBaseUrl || !origin || expiresAt === null || !capabilities) {
      throw credentialError(
        'waku_credential_unreadable',
        `${fileLabel} is missing required bootstrap fields`,
      );
    }

    const missing = requiredCapabilities.filter((cap) => !capabilities.includes(cap));
    if (missing.length > 0) {
      throw credentialError(
        'waku_credential_capability_missing',
        `runtime token lacks ${missing.join(', ')}; re-run waku agent bootstrap with --runtime-capabilities ${requiredCapabilities.join(',')}`,
      );
    }

    return { token, sessionId, apiBaseUrl, origin, expiresAt, capabilities };
  }

  function backoffAllows(): boolean {
    if (refreshFailures === 0) return true;
    const delay = Math.min(backoff.baseMs * 2 ** (refreshFailures - 1), backoff.maxMs);
    return now() - lastFailureAt >= delay;
  }

  /** single-flight：并发 current() 只会烧一次 CLI 与一个后端 session。 */
  function runRefresh(): Promise<void> {
    if (inflight) return inflight;
    const pending = (async (): Promise<void> => {
      try {
        await mint();
        // 重铸过程中文件可能被写坏——解析失败就当刷新失败，不把半截文件当新凭证。
        cached = readFromDisk();
        refreshFailures = 0;
        lastRefreshError = undefined;
      } catch (cause) {
        refreshFailures += 1;
        lastFailureAt = now();
        lastRefreshError = redact(cause instanceof Error ? cause.message : String(cause));
        throw credentialError('waku_credential_refresh_failed', 'waku agent bootstrap did not produce usable credentials');
      } finally {
        inflight = null;
      }
    })();
    inflight = pending;
    return pending;
  }

  return {
    async current(): Promise<RuntimeCredentials> {
      if (cached === null) cached = readFromDisk();

      if (cached.expiresAt - now() <= refreshSkewMs && backoffAllows()) {
        // 刷新失败不是致命的：旧 token 还有效就继续用（state=stale）。
        await runRefresh().catch(() => undefined);
      }

      const live = cached;
      if (live === null || live.expiresAt <= now()) {
        throw credentialError(
          'waku_credential_degraded',
          'runtime credentials are expired and could not be refreshed',
        );
      }
      return live;
    },

    async refresh(): Promise<void> {
      await runRefresh();
    },

    health(): CredentialHealth {
      const expiresInSec = cached === null ? 0 : Math.floor((cached.expiresAt - now()) / 1000);
      const expired = cached === null || cached.expiresAt <= now();
      const state: CredentialHealth['state'] = expired
        ? 'degraded'
        : refreshFailures > 0
          ? 'stale'
          : 'ready';
      const health: CredentialHealth = {
        ok: state !== 'degraded',
        state,
        expiresInSec,
        refreshFailures,
      };
      if (lastRefreshError !== undefined) health.lastRefreshError = lastRefreshError;
      return health;
    },
  };
}
