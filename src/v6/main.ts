#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loginWithQR, loginWithQRWeb } from '../auth.js';
import { getActiveAccount, saveAccount } from '../store.js';
import { log, logError } from '../utils.js';
import { loadConfig } from '../v5/core/config.js';
import { Replier } from '../v5/sender/replier.js';
import { createWeChatSender } from '../v5/sender/wechat-sender.js';

import { selectAgent } from './agents/select.js';
import { FileSessionStore } from './session-store.js';
import { InMemoryScheduler } from './scheduler.js';
import { Orchestrator } from './orchestrator.js';
import { startV6HealthServer, packageVersion } from './health.js';
import { TurnRingBuffer, pollLoop, startIdleSweeper } from './poller.js';

const HEALTH_PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);

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

async function main(): Promise<void> {
  console.log(`\n  cc2wechat v6 — Channel → Core → Agent (${packageVersion()})\n`);

  const existingPid = await isPortInUse(HEALTH_PORT);
  if (existingPid) {
    console.log(`  ⚠️  cc2wechat 已在运行 (PID ${existingPid}, port ${HEALTH_PORT})`);
    console.log(`  用 cc2wechat stop 停止，或 cc2wechat restart 重启`);
    console.log(`  多账号？用 CC2WECHAT_PORT=18082 cc2wechat start\n`);
    process.exit(0);
  }

  let account = getActiveAccount(HEALTH_PORT);
  if (!account) {
    console.log('  No saved credentials. Starting login...');
    const isHeadless = !process.env.DISPLAY && !process.env.BROWSER && process.platform !== 'darwin';
    const result = isHeadless ? await loginWithQR() : await loginWithQRWeb();
    saveAccount({
      accountId: result.accountId.replace(/@/g, '-').replace(/\./g, '-'),
      token: result.token,
      baseUrl: result.baseUrl,
      savedAt: new Date().toISOString(),
      port: HEALTH_PORT,
    });
    account = getActiveAccount(HEALTH_PORT)!;
  }

  const accountName = getAccountName(HEALTH_PORT);
  console.log(`  Account: ${account.accountId}${accountName ? ` (${accountName})` : ''}`);

  const config = loadConfig();
  const cwd = config.cwd ?? process.cwd();

  const agent = selectAgent(process.env, config);
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

  startV6HealthServer(HEALTH_PORT, {
    account,
    agent,
    scheduler,
    turns,
    cwd,
    startedAt: new Date().toISOString(),
  });
  log(`Health server on 127.0.0.1:${HEALTH_PORT}`);

  const deps = { account, accountName: accountName ?? undefined, cwd, agent, scheduler, store, orchestrator, turns };
  startIdleSweeper(deps);
  await pollLoop(deps);
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
