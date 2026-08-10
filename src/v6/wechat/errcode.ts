/**
 * 微信应用层错误码。
 *
 * v5 的坑:apiFetch 只看 HTTP 状态码,微信永远回 200,把 `errcode: -14`
 * 这类"其实没发出去"的响应当成成功 —— 用户那边一片安静,日志里一片祥和。
 * 发送路径(sendMessage / sendTyping / getConfig / 上传 / 下载)必须炸出来。
 *
 * 例外:getUpdates 绝对不能用这个 —— poller 靠 errcode 做 -14 暂停与退避,
 * 变成异常会毁掉那套语义(见 v5/core/poller.ts)。
 */
export class WeChatApiError extends Error {
  readonly code: number;
  readonly errmsg: string;
  readonly label: string;

  constructor(label: string, code: number, errmsg: string) {
    super(`${label} failed: errcode=${code}${errmsg ? ` errmsg=${errmsg}` : ''}`);
    this.name = 'WeChatApiError';
    this.label = label;
    this.code = code;
    this.errmsg = errmsg;
  }
}

/**
 * body 里 ret / errcode 存在且非 0 就抛。
 * body 不是 JSON 对象(空串、纯文本、数组)一律放过 —— 有些接口本来就不回 JSON。
 */
export function assertNoBodyError(label: string, rawText: string): void {
  if (!rawText) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

  const body = parsed as { ret?: unknown; errcode?: unknown; errmsg?: unknown };
  const errmsg = typeof body.errmsg === 'string' ? body.errmsg : '';

  for (const field of ['ret', 'errcode'] as const) {
    const value = body[field];
    if (typeof value === 'number' && value !== 0) {
      throw new WeChatApiError(label, value, errmsg);
    }
  }
}
