/**
 * Gateway 的日志接缝。
 *
 * 只有两个动词是刻意的：观测日志「四件套」（入站 / `[turn]` / 传输重连与错误 / 发送失败）
 * 必须能被测试录下来断言有产出，所以所有通道代码都通过注入的 logger 写，
 * 不直接 `console.*`。默认实现的格式与 `server.ts` 一致：`[waku-gateway <iso>] <msg>`。
 *
 * 纪律：token / 凭证 / 用户正文全文永远不进日志；入站只记 `<sender8>: <text50>`。
 */
export interface GatewayLogger {
  info(message: string): void;
  error(message: string): void;
}

export function createStdLogger(prefix = 'waku-gateway'): GatewayLogger {
  return {
    info(message: string): void {
      process.stdout.write(`[${prefix} ${new Date().toISOString()}] ${message}\n`);
    },
    error(message: string): void {
      process.stderr.write(`[${prefix} ${new Date().toISOString()}] ${message}\n`);
    },
  };
}

/** 什么都不写：给只关心返回值的测试 / 工具用。 */
export const silentLogger: GatewayLogger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * 内部错误 message 进日志/回执前的截断长度：留够定位，又不至于把一整篇 stack 灌进来。
 */
export const INTERNAL_ERROR_DETAIL_MAX = 300;

/**
 * 本机内部错误（DB / fs / 解码…）→ 一行可读的日志素材。
 *
 * 为什么需要它：以前这类错误只留一个 code —— 附件那条路径连 code 都没有，一律 `send_failed`，
 * `no such table: asset_uploads` 这种一眼定位的 message 被彻底吃掉，线上只能看着
 * 每 30s 一次的重投猜。现在 code 与 message 都留，并压成一行、截断到 300 字。
 *
 * 纪律不变：这里只描述**错误**，永远不要把用户正文或凭据塞进来。
 */
export function describeInternalError(error: unknown, maxChars = INTERNAL_ERROR_DETAIL_MAX): string {
  if (error instanceof Error) {
    const raw = (error as Error & { code?: unknown }).code;
    const code = typeof raw === 'string' && raw.length > 0 ? raw : null;
    const message = flatten(error.message, maxChars);
    if (message.length === 0) return code ?? error.name;
    return code === null ? message : `${code}: ${message}`;
  }
  return flatten(String(error), maxChars);
}

function flatten(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}…`;
}
