import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AccountData } from '../store.js';
import type { AgentAdapter } from './contracts.js';
import type { TurnRing } from './poller.js';

export interface V6HealthDeps {
  account: AccountData;
  agent: Pick<AgentAdapter, 'name' | 'persistent'>;
  /** InMemoryScheduler 的汇总视图 */
  scheduler: { stats(): { running: number; queued: number } };
  turns: TurnRing;
  cwd: string;
  startedAt: string;
}

let cachedVersion: string | null = null;

/** 读真实的 package.json 版本,别再写死 'v5' 那种自欺欺人的字符串 */
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf-8')) as { version?: string };
    cachedVersion = pkg.version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

/**
 * 健康检查服务。
 *
 * **只听 127.0.0.1** —— v5 的 `server.listen(port)` 默认绑 0.0.0.0,
 * 那台 Linux 服务器没有防火墙,等于把 accountId / cwd / 运行状态挂公网上(已确认暴露)。
 * 需要远程看就自己开 SSH 隧道。
 */
export function startV6HealthServer(port: number, deps: V6HealthDeps): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'running',
          version: packageVersion(),
          engine: 'v6',
          agent: deps.agent.name,
          persistent: deps.agent.persistent,
          account: deps.account.accountId,
          cwd: deps.cwd,
          startedAt: deps.startedAt,
          uptime: process.uptime(),
          scheduler: deps.scheduler.stats(),
          turns: deps.turns.list(),
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, '127.0.0.1');
  return server;
}
