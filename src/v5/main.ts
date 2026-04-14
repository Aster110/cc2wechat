#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loginWithQR, loginWithQRWeb } from '../auth.js';
import { getActiveAccount, saveAccount } from '../store.js';
import { log } from '../utils.js';

import { loadConfig } from './core/config.js';
import { selectDelivery } from './core/bootstrap.js';
import { Router } from './core/router.js';
import { createDefaultGateway } from './core/command-gateway.js';
import { startHealthServer } from './core/health-server.js';
import { pollLoop } from './core/poller.js';
import { Replier } from './sender/replier.js';
import { createWeChatSender } from './sender/wechat-sender.js';
import { ClaudeCodeBackend } from './backends/claude-code.js';
import { SDKDelivery } from './deliveries/sdk/sdk-delivery.js';
import { PipeDelivery } from './deliveries/pipe/pipe-delivery.js';
import { TmuxDelivery } from './deliveries/tmux/tmux-delivery.js';

const HEALTH_PORT = parseInt(process.env.CC2WECHAT_PORT ?? '18081', 10);

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
  } catch { /* no aliases */ }
  return null;
}

async function main(): Promise<void> {
  console.log('\n  cc2wechat v5 — Delivery x Backend Architecture\n');

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

  const backend = new ClaudeCodeBackend();
  const candidates = [new TmuxDelivery(), new SDKDelivery(), new PipeDelivery()];
  const delivery = await selectDelivery(candidates, config.delivery);
  await delivery.initialize(config as unknown as Record<string, unknown>);
  log(`Delivery: ${delivery.name}, Backend: ${backend.name}`);

  const sender = createWeChatSender(account);
  const replier = new Replier(sender, {
    maxChunkSize: config.reply?.maxChunkSize ?? 3900,
    stripMarkdown: config.reply?.stripMarkdown ?? true,
  });
  const router = new Router(delivery, backend, replier);
  const gateway = createDefaultGateway();
  const cwd = config.cwd ?? process.cwd();

  console.log(`  Health check: http://localhost:${HEALTH_PORT}/health`);
  console.log('  Listening for WeChat messages...\n');

  startHealthServer(HEALTH_PORT, {
    account,
    delivery,
    backend,
    startedAt: new Date().toISOString(),
    cwd,
  });
  log(`Health server on :${HEALTH_PORT}`);

  console.log(`  Working directory: ${cwd}`);
  await pollLoop(account, router, cwd, delivery, backend, gateway, accountName ?? undefined);
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
