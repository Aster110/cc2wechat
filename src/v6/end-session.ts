import { resolveReplyContext, type ReplyContext } from './reply-context.js';

/**
 * `cc2wechat --end` 的落地逻辑。
 *
 * v5 的 daemon 有个 `/close-session` 端点(关 iTerm 里那个 tmux 会话);
 * v6 根本没有这个端点,于是 `--end` 变成了一次 404 + `.catch(() => {})` ——
 * 命令看着"成功"了,其实什么都没发生,agent 还以为自己已经跟用户道过别了。
 *
 * 现在的行为:
 * 1. 先照打 v5 端点(并存期还有人跑 v5 引擎,兼容不能丢)
 * 2. 打不通 → 读 reply-context 确认到底有没有活跃会话
 * 3. 连 ctx 都没有 → 明说"没有活跃会话",退出码非 0,别再假装成功
 */

export type EndSessionVia = 'v5-endpoint' | 'v6-no-server-session' | 'none';

export interface EndSessionResult {
  ok: boolean;
  via: EndSessionVia;
  message: string;
}

export interface EndSessionDeps {
  /** 要试的端口(按顺序试,第一个通的算数) */
  ports: number[];
  /** v5 端点要的 contextPath */
  contextPath: string;
  fetchImpl?: typeof fetch;
  resolveCtx?: () => ReplyContext | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1_500;

export async function endSession(deps: EndSessionDeps): Promise<EndSessionResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (const port of deps.ports) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/close-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextPath: deps.contextPath }),
        signal: controller.signal,
      });
      // v6 的 health server 对未知路径回 404 —— 那不算"关成功",继续往下走
      if (res.ok) {
        return { ok: true, via: 'v5-endpoint', message: 'Session closed.' };
      }
    } catch {
      /* 端口没人听 / 超时,试下一个 */
    } finally {
      clearTimeout(timer);
    }
  }

  const ctx = (deps.resolveCtx ?? (() => resolveReplyContext()))();
  if (!ctx) {
    return { ok: false, via: 'none', message: '没有活跃会话（找不到回复上下文，daemon 可能没在跑）' };
  }

  return {
    ok: true,
    via: 'v6-no-server-session',
    message:
      '当前引擎没有服务端会话可关（v6 不再有 /close-session）。\n' +
      `微信上下文仍然有效（user=${ctx.userId.slice(0, 10)}…）；要清空对话上下文，请在微信里发 /new 或 /exit。`,
  };
}
