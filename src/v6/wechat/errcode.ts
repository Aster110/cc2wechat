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
  /** 已知错误码的下一步动作。没把握就别填 —— 乱指路比不指路更贵。 */
  readonly hint?: string;

  constructor(label: string, code: number, errmsg: string, hint?: string) {
    super(
      `${label} failed: errcode=${code}${errmsg ? ` errmsg=${errmsg}` : ''}` +
      (hint ? `\n  ↳ ${hint}` : ''),
    );
    this.name = 'WeChatApiError';
    this.label = label;
    this.code = code;
    this.errmsg = errmsg;
    this.hint = hint;
  }
}

/**
 * errmsg → 行动提示。**按 errmsg 精确匹配,不按错误码**——
 * `-2` 是 iLink 的通用"参数/状态不对",同一个码下 errmsg 可能是
 * `ilink_user_id required`(真的少传了字段)也可能是 `prepare failed`(会话没了),
 * 按码套提示会把人往沟里带。
 */
const ERRMSG_HINTS: Record<string, string> = {
  // 2026-08-27 f13-47:这条把"图片发不出去"查成了一整轮媒体协议排查。
  // 实测(同一账号同一分钟):getconfig / sendtyping / getuploadurl / CDN 上传全部 ret=0,
  // 只有 sendmessage 回 -2,而且**文字和图片一样被挡** —— 不是媒体故障。
  // 另一台桥同期一切正常,唯一差别是那边刚有用户消息进来、对话是活的。
  // 对照实验钉死语义:活对话里连伪造的 context_token 都能发成功;
  // 而把 to_user_id 换成"格式对但本 bot 没跟他聊过"的人,立刻复现 -2 prepare failed。
  // (真写错收件人格式是 -3 invalid arguments,跟这条不是一回事。)
  'prepare failed':
    '这只 bot 跟这个 user 之间没有活跃对话了(通常是最后一条用户消息太久之前,会话已 idle 过期)。' +
    '这不是媒体故障——同一对话下发纯文字一样会被挡,别去查图片链路。' +
    'iLink bot 不能主动开新对话:让对方先在微信里发一条消息把对话唤醒,daemon 会刷新 ~/.cc2wechat/ctx/,再重发。' +
    '(已证伪的岔路:context_token 换不换都一样,活对话里假 token 照样发得出去。)',
};

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
      throw new WeChatApiError(label, value, errmsg, ERRMSG_HINTS[errmsg]);
    }
  }
}

/**
 * CDN(novac2c)错误。
 *
 * 它跟 ilink CGI 不是一套:body 恒为空(content-length: 0),
 * 真正的原因写在响应头 `x-error-code` / `x-error-message` 里。
 * 只报 "CDN upload failed: 500" 等于把唯一的线索扔了 —— 星尘桥那条 500 就是这么变成悬案的。
 */
export class CdnError extends Error {
  readonly label: string;
  readonly status: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;

  constructor(label: string, status: number, errorCode: string | null, errorMessage: string | null, body?: string) {
    const parts = [`${label} failed: HTTP ${status}`];
    if (errorCode) parts.push(`x-error-code=${errorCode}`);
    if (errorMessage) parts.push(`x-error-message=${errorMessage}`);
    if (body) parts.push(`body=${body.slice(0, 300)}`);
    super(parts.join(' '));
    this.name = 'CdnError';
    this.label = label;
    this.status = status;
    this.errorCode = errorCode;
    this.errorMessage = errorMessage;
  }
}

interface CdnResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
}

/** 非 2xx 抛;HTTP 200 但头里带非 0 的 x-error-code 也抛(CDN 会这么干)。 */
export function assertNoCdnError(label: string, res: CdnResponseLike, body?: string): void {
  const header = (name: string): string | null => {
    try {
      return res.headers?.get(name) ?? null;
    } catch {
      return null;
    }
  };
  const code = header('x-error-code');
  const message = header('x-error-message');
  const codedFailure = code !== null && code !== '' && code !== '0';
  if (res.ok && !codedFailure) return;
  throw new CdnError(label, res.status, code, message, body);
}
