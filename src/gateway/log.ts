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
