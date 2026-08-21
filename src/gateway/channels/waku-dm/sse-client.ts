/**
 * Waku per-user 总线的 SSE 客户端（契约 §3.3）。
 *
 * 传输事实（抄自 waku-core `routes/v1/users.py`）：
 * - 帧 = `id: <user_seq>\nevent: <name>\ndata: <单行 JSON>\n\n`；`data:` 恒占一物理行且是帧内末行
 *   （跨仓「单行 data 契约」），但解析器仍按 SSE 规范实现多行 data 拼接——契约是上游保证，不是解析器该赌的。
 * - 首行 `: replay-mode=filtered|delta` 注释；空闲时每秒一行 `: keepalive` 注释。
 * - `Last-Event-ID: <user_seq>` 续读；非数字按 0 冷启。
 *
 * 生存策略（§3.3 + 架构 §13）：
 * - **30s 无任何字节 → 判死重连**（注释行也算字节；这是对抗 NAT/代理半开连接的唯一手段）。
 * - 正常 EOF → 短延迟重连；401/403 → 通知凭证失效后重连；其它错误指数退避 2s → 60s。
 * - `onFrame` 抛错 = 下游（sink/库）故障：**该帧不算消费**，断开后重连从游标重投，顺序不乱、不丢。
 *
 * 只用 Node 22 全局 `fetch` + `ReadableStream`，不引第三方 EventSource。
 */
import type { GatewayLogger } from '../../log.js';

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

export interface SseParser {
  feed(text: string): SseFrame[];
  flush(): SseFrame[];
}

const NUL = String.fromCharCode(0);

/** 增量行解析器：任意切分的字节块喂进来，完整帧吐出去。 */
export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let event = '';
  let id: string | null = null;
  let sawData = false;

  function dispatch(out: SseFrame[]): void {
    // 规范：data buffer 为空（没有 data 行）就丢弃这个块，不派发。
    if (sawData) out.push({ id, event: event.length > 0 ? event : 'message', data: dataLines.join('\n') });
    dataLines = [];
    event = '';
    id = null;
    sawData = false;
  }

  function handleLine(line: string, out: SseFrame[]): void {
    if (line.length === 0) {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // 注释行：keepalive / replay-mode

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        sawData = true;
        return;
      case 'event':
        event = value;
        return;
      case 'id':
        // 规范：含 NUL 的 id 忽略
        if (!value.includes(NUL)) id = value;
        return;
      default:
        return; // retry / 未知字段：忽略
    }
  }

  function consumeLine(line: string, out: SseFrame[]): void {
    handleLine(line.endsWith('\r') ? line.slice(0, -1) : line, out);
  }

  return {
    feed(text: string): SseFrame[] {
      const out: SseFrame[] = [];
      buffer += text;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line, out);
      }
      return out;
    },

    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (buffer.length > 0) {
        const line = buffer;
        buffer = '';
        consumeLine(line, out);
      }
      dispatch(out);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// 订阅
// ---------------------------------------------------------------------------

export type SseState = 'idle' | 'connecting' | 'open' | 'backoff' | 'stopped';

export interface SseStats {
  state: SseState;
  /** 首连之后的再连接次数（含失败的尝试）。 */
  reconnects: number;
  consecutiveFailures: number;
  lastEventAt: number | null;
  lastOpenAt: number | null;
  /** 只有分类码（`http_401` / `network:*` / `idle_timeout` …），永不含响应体。 */
  lastError: string | null;
}

export interface SseSubscriptionOptions {
  url: string;
  /** 每次连接现取：token 可能已经换过。 */
  headers(): Promise<Record<string, string>>;
  lastEventId(): string | null;
  /** 抛错 = 下游故障 → 该帧不算消费，断开重连重投。 */
  onFrame(frame: SseFrame): Promise<void> | void;
  /** 401/403：凭证失效，调用方 invalidate 后我们会重连。 */
  onAuthRejected(): void;
  onStateChange?(state: SseState): void;
  log: GatewayLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  idleTimeoutMs?: number;
  backoff?: { baseMs: number; maxMs: number };
  /** 正常 EOF 后的重连延迟。 */
  reconnectDelayMs?: number;
  label?: string;
}

export interface SseSubscription {
  start(): void;
  stop(): Promise<void>;
  stats(): SseStats;
}

export const SSE_IDLE_TIMEOUT_MS = 30_000;
export const SSE_BACKOFF = { baseMs: 2_000, maxMs: 60_000 } as const;
export const SSE_RECONNECT_DELAY_MS = 1_000;

type Outcome = 'eof' | 'idle' | 'auth' | 'http' | 'network' | 'sink' | 'credential' | 'stopped';

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return 'error';
}

export function createSseSubscription(options: SseSubscriptionOptions): SseSubscription {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const idleTimeoutMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  const backoff = options.backoff ?? SSE_BACKOFF;
  const reconnectDelayMs = options.reconnectDelayMs ?? SSE_RECONNECT_DELAY_MS;
  const label = options.label ?? 'sse';
  const { log } = options;

  let state: SseState = 'idle';
  let running = false;
  let attempts = 0;
  let reconnects = 0;
  let consecutiveFailures = 0;
  let lastEventAt: number | null = null;
  let lastOpenAt: number | null = null;
  let lastError: string | null = null;

  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;
  let sleepTimer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;

  function setState(next: SseState): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      wake = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        wake = null;
        resolve();
      }, ms);
    });
  }

  function cancelSleep(): void {
    if (sleepTimer !== null) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    const pending = wake;
    wake = null;
    pending?.();
  }

  function delayFor(failures: number): number {
    return Math.min(backoff.baseMs * 2 ** Math.max(0, failures - 1), backoff.maxMs);
  }

  async function connectOnce(): Promise<Outcome> {
    const abort = new AbortController();
    controller = abort;
    let idleTimer: NodeJS.Timeout | null = null;
    let idleTripped = false;

    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTripped = true;
        abort.abort();
      }, idleTimeoutMs);
    };
    const disarmIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    };

    try {
      let headers: Record<string, string>;
      try {
        headers = await options.headers();
      } catch (error) {
        lastError = `credential:${describe(error)}`;
        return 'credential';
      }
      if (!running) return 'stopped';

      const lastId = options.lastEventId();
      // 看门狗在 fetch 之前就上弦：连响应头都不给的半开连接也要能判死。
      armIdle();

      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: 'GET',
          headers: {
            ...headers,
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...(lastId === null ? {} : { 'Last-Event-ID': lastId }),
          },
          signal: abort.signal,
        });
      } catch (error) {
        if (!running) return 'stopped';
        if (idleTripped) {
          lastError = 'idle_timeout';
          return 'idle';
        }
        lastError = `network:${describe(error)}`;
        return 'network';
      }

      if (response.status === 401 || response.status === 403) {
        lastError = `http_${response.status}`;
        await response.body?.cancel().catch(() => undefined);
        options.onAuthRejected();
        return 'auth';
      }
      if (!response.ok || response.body === null) {
        lastError = `http_${response.status}`;
        await response.body?.cancel().catch(() => undefined);
        return 'http';
      }

      setState('open');
      lastOpenAt = now();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();

      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (!running) return 'stopped';
          if (idleTripped) {
            lastError = 'idle_timeout';
            return 'idle';
          }
          lastError = `network:${describe(error)}`;
          return 'network';
        }
        if (chunk.done) {
          lastError = null;
          return running ? 'eof' : 'stopped';
        }
        armIdle();

        const frames = parser.feed(decoder.decode(chunk.value, { stream: true }));
        for (const frame of frames) {
          // 下游处理期间不算「没字节」：sink 慢不是连接死。
          disarmIdle();
          try {
            await options.onFrame(frame);
          } catch (error) {
            lastError = `sink:${describe(error)}`;
            log.error(
              `${label} frame handler failed (event=${frame.event} id=${frame.id ?? '-'}): ${
                error instanceof Error ? error.message : String(error)
              }; reconnecting to replay it`,
            );
            return 'sink';
          }
          lastEventAt = now();
          consecutiveFailures = 0;
          armIdle();
        }
      }
    } finally {
      disarmIdle();
      abort.abort();
      if (controller === abort) controller = null;
    }
  }

  async function run(): Promise<void> {
    while (running) {
      attempts += 1;
      if (attempts > 1) reconnects += 1;
      setState('connecting');
      const outcome = await connectOnce();
      if (!running) break;

      switch (outcome) {
        case 'eof':
          log.info(`${label} stream ended cleanly, reconnecting in ${reconnectDelayMs}ms`);
          setState('backoff');
          await sleep(reconnectDelayMs);
          break;
        case 'idle':
          log.error(`${label} no bytes for ${idleTimeoutMs}ms, treating the connection as dead and reconnecting`);
          setState('backoff');
          break;
        case 'auth': {
          consecutiveFailures += 1;
          const delay = delayFor(consecutiveFailures);
          log.error(`${label} rejected (${lastError ?? 'auth'}); credentials invalidated, reconnecting in ${delay}ms`);
          setState('backoff');
          await sleep(delay);
          break;
        }
        case 'sink': {
          consecutiveFailures += 1;
          setState('backoff');
          await sleep(delayFor(consecutiveFailures));
          break;
        }
        case 'http':
        case 'network':
        case 'credential': {
          consecutiveFailures += 1;
          const delay = delayFor(consecutiveFailures);
          log.error(`${label} connect failed (${lastError ?? outcome}), retry in ${delay}ms (failures=${consecutiveFailures})`);
          setState('backoff');
          await sleep(delay);
          break;
        }
        case 'stopped':
          break;
      }
    }
    setState('stopped');
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      loop = run().catch((error: unknown) => {
        lastError = `loop:${describe(error)}`;
        log.error(`${label} loop crashed: ${error instanceof Error ? error.message : String(error)}`);
        setState('stopped');
      });
    },

    async stop(): Promise<void> {
      running = false;
      controller?.abort();
      cancelSleep();
      await loop;
      loop = null;
      setState('stopped');
    },

    stats(): SseStats {
      return { state, reconnects, consecutiveFailures, lastEventAt, lastOpenAt, lastError };
    },
  };
}
