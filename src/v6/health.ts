import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AccountData } from '../store.js';
import type { AgentAdapter, AgentHealth } from './contracts.js';
import type { TurnRing } from './poller.js';

/** agent.health() 的超时。/health 是给运维用的,不能因为后端卡住就一起卡住 */
const AGENT_HEALTH_TIMEOUT_MS = 1_000;

/** adapter 模式下每个通道的自报健康(legacy 路径没有这个概念) */
export interface ChannelHealthSnapshot {
  name: string;
  ok: boolean;
  detail?: string;
  lastOkAt?: number;
}

export interface V6HealthDeps {
  /**
   * 微信账号。**可以没有** —— web-only 形态跑在没有微信账号的机器上,
   * 这时输出里 account 为 null,而不是让 /health 崩掉。
   */
  account?: AccountData | null;
  agent: Pick<AgentAdapter, 'name' | 'persistent'> & Partial<Pick<AgentAdapter, 'health'>>;
  /** InMemoryScheduler 的汇总视图 */
  scheduler: { stats(): { running: number; queued: number } };
  turns: TurnRing;
  cwd: string;
  startedAt: string;
  /**
   * adapter 模式:每个通道的健康快照。
   * legacy 路径不传 → JSON 里根本不会出现 channels 这个键(输出一字不变)。
   */
  channels?: () => ChannelHealthSnapshot[];
}

/**
 * 后端健康快照。
 *
 * 常驻 agent 的"活着"不等于"能用"——app-server 可能已经降级成一次性 spawn,
 * 或者 CODEX_HOME 串到别的账号上。这些只有问 agent 自己才知道。
 * 超时一律当不健康:一个 1 秒都答不上来的后端,微信那头一样是在干等。
 */
export async function probeAgentHealth(
  agent: Pick<AgentAdapter, 'name'> & Partial<Pick<AgentAdapter, 'health'>>,
  timeoutMs = AGENT_HEALTH_TIMEOUT_MS,
): Promise<AgentHealth> {
  if (typeof agent.health !== 'function') return { ok: true, detail: 'agent 未实现 health()' };

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<AgentHealth>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, detail: 'timeout' }), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return await Promise.race([Promise.resolve(agent.health()), timeout]);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
      void (async () => {
        const agentHealth = await probeAgentHealth(deps.agent, AGENT_HEALTH_TIMEOUT_MS);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'running',
            version: packageVersion(),
            engine: 'v6',
            agent: deps.agent.name,
            persistent: deps.agent.persistent,
            agentHealth,
            account: deps.account?.accountId ?? null,
            cwd: deps.cwd,
            startedAt: deps.startedAt,
            uptime: process.uptime(),
            scheduler: deps.scheduler.stats(),
            turns: deps.turns.list(),
            // 没有 channels provider 时是 undefined,JSON.stringify 直接丢掉这个键
            channels: deps.channels?.(),
          }),
        );
      })();
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, '127.0.0.1');
  return server;
}
