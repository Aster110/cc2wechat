import type { Notifier } from './types.js';

export const NOTIFY_TIMEOUT_MS = 10_000;

export interface FeishuNotifierDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 飞书自定义机器人（带外通道）。
 *
 * 只发纯文本：报警要的是"在锁屏上一眼看完"，不是卡片好看。
 * 飞书对失败的处理很鸡贼——HTTP 200 但 body 里 code!=0（webhook 写错、被停用都是这样），
 * 所以两层都得判，否则会以为发出去了。
 */
export function createFeishuNotifier(webhook: string, deps: FeishuNotifierDeps = {}): Notifier {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? NOTIFY_TIMEOUT_MS;

  return {
    async send(text: string): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        const res = await fetchImpl(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg_type: 'text', content: { text } }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`飞书 webhook HTTP ${res.status}`);
        const body = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
        if (body && typeof body.code === 'number' && body.code !== 0) {
          throw new Error(`飞书 webhook code=${body.code} ${body.msg ?? ''}`.trim());
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
