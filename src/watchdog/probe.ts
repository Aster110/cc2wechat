import { DEFAULT_TIMEOUT_MS } from './paths.js';
import type { DaemonStatus, ProbeResult, WatchdogDaemonConfig } from './types.js';

/**
 * /health 里我们**只读**的字段。
 * 口径与 src/v6/health.ts 对齐，但这里是只读消费方——看门狗不碰 v5/v6 一行代码，
 * 也不假设 health 的全部形状（多一个字段少一个字段都不该让看门狗自己挂掉）。
 */
export interface HealthSnapshot {
  status?: unknown;
  agentHealth?: { ok?: unknown; detail?: unknown } | null;
  /** src/v6/contracts.ts TurnTiming[]，我们只看 outcome */
  turns?: Array<{ outcome?: unknown }> | null;
  account?: unknown;
  uptime?: unknown;
}

/** 连续多少轮 error 算 error-streak */
export const ERROR_STREAK_WINDOW = 5;

/** status 字段里被认为"正常"的取值——别的值一律当 down（宁可误报，不可漏报） */
const HEALTHY_STATUS = new Set(['running', 'ok']);

export interface Classification {
  status: DaemonStatus;
  detail?: string;
  account?: string;
  uptime?: number;
}

/**
 * 把一份 /health body 判成四态。纯函数，判定逻辑的唯一事实源。
 *
 * 优先级：down > degraded > error-streak > ok。
 * 先报最严重的那个——运维看到一条消息只会处理一件事。
 */
export function classifyHealth(body: unknown): Classification {
  if (!body || typeof body !== 'object') return { status: 'down', detail: '/health 返回的不是 JSON 对象' };
  const h = body as HealthSnapshot;

  const account = typeof h.account === 'string' ? h.account : undefined;
  const uptime = typeof h.uptime === 'number' ? h.uptime : undefined;
  const base = { account, uptime };

  if (typeof h.status === 'string' && !HEALTHY_STATUS.has(h.status)) {
    return { ...base, status: 'down', detail: `status=${h.status}` };
  }

  if (h.agentHealth && typeof h.agentHealth === 'object' && h.agentHealth.ok === false) {
    const detail = typeof h.agentHealth.detail === 'string' ? h.agentHealth.detail : '未给 detail';
    return { ...base, status: 'degraded', detail: `agentHealth.ok=false: ${detail}` };
  }

  const turns = Array.isArray(h.turns) ? h.turns : [];
  const recent = turns.slice(-ERROR_STREAK_WINDOW);
  if (recent.length === ERROR_STREAK_WINDOW && recent.every((t) => t && t.outcome === 'error')) {
    return { ...base, status: 'error-streak', detail: `最近 ${ERROR_STREAK_WINDOW} 轮全是 error` };
  }

  return { ...base, status: 'ok' };
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 敲一个 daemon 的 /health。
 *
 * 任何"敲不通"（连接拒绝 / 超时 / 非 200 / 不是 JSON）都算 down：
 * 桥挂了的时候，端口上通常什么都没有，这条路径就是最常触发的那条。
 */
export async function probeDaemon(daemon: WatchdogDaemonConfig, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = daemon.host ?? '127.0.0.1';
  const url = `http://${host}:${daemon.port}/health`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (res.status !== 200) {
      return { name: daemon.name, port: daemon.port, status: 'down', detail: `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { name: daemon.name, port: daemon.port, status: 'down', detail: '/health 响应不是合法 JSON' };
    }
    const c = classifyHealth(body);
    return { name: daemon.name, port: daemon.port, ...c };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = controller.signal.aborted ? `探测超时 ${timeoutMs}ms` : `连接失败: ${msg}`;
    return { name: daemon.name, port: daemon.port, status: 'down', detail };
  } finally {
    clearTimeout(timer);
  }
}
