#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { log, logError } from '../utils.js';
import { loadConfig } from '../v5/core/config.js';
import { Replier } from '../v5/sender/replier.js';
import { createWeChatSender } from '../v5/sender/wechat-sender.js';

import { selectAgent } from './agents/select.js';
import { bootstrapChannelCore, channelCoreEnabled, ensureAccount } from './channels/bootstrap.js';
import { isHttpAttachable } from './claude-app/gateway-bus.js';
import { FileSessionStore } from './session-store.js';
import { InMemoryScheduler } from './scheduler.js';
import { Orchestrator } from './orchestrator.js';
import { startV6HealthServer, packageVersion } from './health.js';
import { TurnRingBuffer, pollLoop, startIdleSweeper } from './poller.js';

const HEALTH_PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);
/** 停机时最多等在跑的那几轮 10 秒;等不完也得走,systemd 的耐心是有限的 */
const DRAIN_TIMEOUT_MS = 10_000;

// 下面两个小工具与 v5/main.ts 同源。没有直接 import 是因为 v5/main.ts
// 在模块顶层就跑 main() —— 引它一下就会顺手把 v5 daemon 也拉起来。
async function isPortInUse(port: number): Promise<number | null> {
  try {
    const { execSync } = await import('node:child_process');
    const pid = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return pid ? parseInt(pid, 10) : null;
  } catch {
    return null;
  }
}

function getAccountName(port: number): string | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.cc2wechat', 'aliases.json'), 'utf-8');
    const aliases = JSON.parse(raw) as Record<string, number>;
    for (const [name, p] of Object.entries(aliases)) {
      if (p === port) return name;
    }
  } catch {
    /* no aliases */
  }
  return null;
}

/**
 * adapter 模式的 daemon:壳(N 个)→ Core → Agent。
 *
 * 与 legacy 的区别只有"谁在收发消息":Core 不再认识微信,
 * 通道从 CC2WECHAT_CHANNELS 选(缺省仍只有 wechat)。
 * 后端选择、会话表、调度器、/health 全部复用同一套东西。
 */
async function startChannelCoreDaemon(): Promise<void> {
  const handle = await bootstrapChannelCore({ port: HEALTH_PORT });

  console.log(`  Health check: http://127.0.0.1:${handle.port}/health`);
  console.log(`  Channels: ${handle.channels.map((c) => c.name).join(', ') || '(none)'}`);
  console.log('  Listening...\n');

  // 常驻后端是子进程,SIGTERM 收不住就会留下抓着 thread 写锁的孤儿(见 legacy 分支同款注释)
  let stopped = false;
  const gracefulStop = async (sig: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log(`收到 ${sig}，优雅停机中…`);
    await handle.stop();
    log('停机完成');
    process.exit(0);
  };
  process.on('SIGTERM', () => void gracefulStop('SIGTERM'));
  process.on('SIGINT', () => void gracefulStop('SIGINT'));
}

async function main(): Promise<void> {
  console.log(`\n  cc2wechat v6 — Channel → Core → Agent (${packageVersion()})\n`);

  const existingPid = await isPortInUse(HEALTH_PORT);
  if (existingPid) {
    console.log(`  ⚠️  cc2wechat 已在运行 (PID ${existingPid}, port ${HEALTH_PORT})`);
    console.log(`  用 cc2wechat stop 停止，或 cc2wechat restart 重启`);
    console.log(`  多账号？用 CC2WECHAT_PORT=18082 cc2wechat start\n`);
    process.exit(0);
  }

  // ---- adapter 模式(Channel 轴)-----------------------------------------
  // 必须在**碰账号之前**分叉:web-only 侧车跑在没有 ~/.cc2wechat 的机器上,
  // 那里不该冒出扫码登录。缺省不进这个分支,下面的 legacy 路径一字未动。
  if (channelCoreEnabled(process.env)) {
    await startChannelCoreDaemon();
    return;
  }

  const account = await ensureAccount(HEALTH_PORT);

  const accountName = getAccountName(HEALTH_PORT);
  console.log(`  Account: ${account.accountId}${accountName ? ` (${accountName})` : ''}`);

  const config = loadConfig();
  const cwd = config.cwd ?? process.cwd();

  const agent = selectAgent(process.env, config, { accountId: account.accountId });
  // 会话表按 accountId 命名;legacyPort 只用于把 v5 的 codex-threads-<port>.json 迁过来
  const store = new FileSessionStore({ accountId: account.accountId, legacyPort: String(HEALTH_PORT) });
  const scheduler = new InMemoryScheduler({
    onError: (err) => logError(`scheduler task failed: ${err instanceof Error ? err.message : String(err)}`),
  });
  const turns = new TurnRingBuffer(20);

  const replier = new Replier(createWeChatSender(account), {
    maxChunkSize: config.reply?.maxChunkSize ?? 3900,
    stripMarkdown: config.reply?.stripMarkdown ?? true,
  });
  const orchestrator = new Orchestrator({ account, agent, store, replier, cwd, accountName: accountName ?? undefined });

  log(`Agent: ${agent.name} (persistent=${agent.persistent}), concurrency=${scheduler.maxConcurrent}, queueCap=${scheduler.queueCap}`);
  console.log(`  Health check: http://127.0.0.1:${HEALTH_PORT}/health`);
  console.log(`  Working directory: ${cwd}`);
  console.log('  Listening for WeChat messages...\n');

  const healthServer = startV6HealthServer(HEALTH_PORT, {
    account,
    agent,
    scheduler,
    turns,
    cwd,
    startedAt: new Date().toISOString(),
  });
  log(`Health server on 127.0.0.1:${HEALTH_PORT}`);

  // claude-app 后端要在同一个端口上开网关总线(SSE /claude-app/events + 回执端点)。
  // 鸭子类型判断而不是 instanceof:哪个后端想挂 HTTP 就自己实现 attachHttp,
  // main 不必认识具体是谁。其余后端这里什么都不发生。
  if (isHttpAttachable(agent)) {
    agent.attachHttp(healthServer);
    log(`claude-app 网关总线已挂上:GET http://127.0.0.1:${HEALTH_PORT}/claude-app/events`);
  }

  // ---- 优雅停机 --------------------------------------------------------
  // 常驻后端(codex app-server / claude SDK 池)是**子进程**。
  // 进程被 SIGKILL 时它们不会跟着走,留下的孤儿会抓着 thread 写锁,
  // 下一次启动 resume 同一条 thread 就撞锁。systemd/launchd 重启走的是 SIGTERM,
  // 只要这里收得住,就永远不会走到"靠 pid 文件收尸"那条兜底路径上。
  const stopping = new AbortController();
  let stopped = false;
  const gracefulStop = async (sig: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log(`收到 ${sig}，优雅停机中…`);
    stopping.abort();
    healthServer.close();
    try {
      await Promise.race([scheduler.drain(), new Promise((r) => setTimeout(r, DRAIN_TIMEOUT_MS))]);
    } catch (err) {
      logError(`drain failed: ${String(err)}`);
    }
    try {
      await agent.shutdown();
    } catch (err) {
      logError(`agent shutdown failed: ${String(err)}`);
    }
    log('停机完成');
    process.exit(0);
  };
  process.on('SIGTERM', () => void gracefulStop('SIGTERM'));
  process.on('SIGINT', () => void gracefulStop('SIGINT'));

  const deps = { account, accountName: accountName ?? undefined, cwd, agent, scheduler, store, orchestrator, turns };
  startIdleSweeper(deps);
  await pollLoop({ ...deps, stopSignal: stopping.signal });
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
