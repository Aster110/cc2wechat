import fs from 'node:fs';
import path from 'node:path';

/** 超过这个体积就砍一半——cron 每 2 分钟一行，不管的话迟早把盘写满 */
export const LOG_MAX_BYTES = 1024 * 1024;

/**
 * 追加一行运行日志，必要时先轮转。
 *
 * 轮转策略：保留尾部一半（丢最老的），并丢掉被切断的第一行。
 * 没搞 .1/.2 分档——看门狗的日志是"最近发生了什么"，不是审计账本。
 */
export function appendLog(file: string, line: string, maxBytes = LOG_MAX_BYTES): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const size = fs.statSync(file).size;
    if (size > maxBytes) {
      const content = fs.readFileSync(file, 'utf-8');
      const half = content.slice(Math.floor(content.length / 2));
      const nl = half.indexOf('\n');
      fs.writeFileSync(file, nl >= 0 ? half.slice(nl + 1) : half);
    }
  } catch {
    // 文件还不存在：直接追加即可
  }
  fs.appendFileSync(file, `${line}\n`);
}
