#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loginWithQRWeb } from './auth.js';
import { saveAccount, getActiveAccount } from './store.js';
import { sendMessage, uploadAndSendMedia } from './wechat-api.js';

// ---------------------------------------------------------------------------
// Aliases: ~/.cc2wechat/aliases.json — maps friendly names to ports
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(os.homedir(), '.cc2wechat');
const ALIASES_FILE = path.join(DATA_DIR, 'aliases.json');
const BASE_PORT = 18081;

function loadAliases(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAliases(aliases: Record<string, number>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2));
}

function resolvePort(nameOrPort?: string): number {
  if (!nameOrPort) return parseInt(process.env.CC2WECHAT_PORT ?? String(BASE_PORT), 10);
  // 纯数字 → 当端口用
  if (/^\d+$/.test(nameOrPort)) return parseInt(nameOrPort, 10);
  // 名字 → 查 aliases
  const aliases = loadAliases();
  const port = aliases[nameOrPort];
  if (!port) {
    console.error(`  Unknown account name: "${nameOrPort}"`);
    console.log('  Available:', Object.keys(aliases).join(', ') || '(none)');
    process.exit(1);
  }
  return port;
}

function nextAvailablePort(): number {
  const aliases = loadAliases();
  const usedPorts = new Set(Object.values(aliases));
  let port = BASE_PORT;
  while (usedPorts.has(port)) port++;
  return port;
}

function reverseAlias(port: number): string | null {
  const aliases = loadAliases();
  for (const [name, p] of Object.entries(aliases)) {
    if (p === port) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Args parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

// Parse --port from args (legacy support)
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  process.env.CC2WECHAT_PORT = args[portIdx + 1];
  args.splice(portIdx, 2);
}

// Parse --name from args
let loginName: string | undefined;
const nameIdx = args.indexOf('--name');
if (nameIdx !== -1 && args[nameIdx + 1]) {
  loginName = args[nameIdx + 1];
  args.splice(nameIdx, 2);
}

const command = args[0];
// args[1] could be a name for start/stop/restart
const targetName = args[1];

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
  🦞 cc2wechat — WeChat channel for Claude Code

  Daemon:
    cc2wechat start [name]       Start daemon (or start all if no name)
    cc2wechat stop [name]        Stop daemon (or stop all if no name)
    cc2wechat restart [name]     Restart daemon

  Account:
    cc2wechat login [--name X]   Scan QR to login (auto-assign port, save as name)
    cc2wechat rename old new     Rename an account
    cc2wechat status             Show all accounts & daemons

  Reply (requires running daemon):
    cc2wechat --text "你好"       Send text to current WeChat context
    cc2wechat --image /tmp/s.png  Send image
    cc2wechat --file /tmp/f.pdf   Send file

  Examples:
    cc2wechat login --name aster     # First account
    cc2wechat login --name wife      # Second account (auto port 18082)
    cc2wechat start aster            # Start one
    cc2wechat start                  # Start all
    cc2wechat status                 # Show all

  cc2wechat help                 Show this help
`);
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

function findContextPath(): string {
  if (process.env.CC2WECHAT_CONTEXT && fs.existsSync(process.env.CC2WECHAT_CONTEXT)) {
    return process.env.CC2WECHAT_CONTEXT;
  }
  try {
    const files = fs.readdirSync('/tmp')
      .filter(f => f.startsWith('cc2wechat-ctx-') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(`/tmp/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) return `/tmp/${files[0].name}`;
  } catch { /* ignore */ }
  return '/tmp/cc2wechat-context.json';
}

const contextPath = findContextPath();

async function reply(): Promise<void> {
  if (!fs.existsSync(contextPath)) {
    console.error('No active WeChat context. cc2wechat daemon must be running.');
    process.exit(1);
  }

  const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf-8')) as {
    token: string;
    baseUrl?: string;
    userId: string;
    contextToken: string;
  };

  if (command === '--image' || command === '--file') {
    const filePath = args[1];
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    await uploadAndSendMedia({
      token: ctx.token,
      toUser: ctx.userId,
      contextToken: ctx.contextToken,
      filePath,
      baseUrl: ctx.baseUrl,
    });
    console.log(`Sent: ${filePath}`);
  } else if (command === '--text') {
    const text = args.slice(1).join(' ');
    await sendMessage(ctx.token, ctx.userId, text, ctx.contextToken, ctx.baseUrl);
    console.log(`Sent: ${text.slice(0, 50)}...`);
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function login(): Promise<void> {
  const name = loginName ?? 'default';
  const aliases = loadAliases();

  // 已有这个名字 → 用原端口；新名字 → 分配新端口
  let port: number;
  if (aliases[name] != null) {
    port = aliases[name];
  } else {
    port = nextAvailablePort();
    aliases[name] = port;
    saveAliases(aliases);
  }

  process.env.CC2WECHAT_PORT = String(port);
  console.log(`\n  🦞 WeChat QR Login — "${name}" (port ${port})\n`);
  try {
    const result = await loginWithQRWeb();
    saveAccount({
      accountId: result.accountId.replace(/@/g, '-').replace(/\./g, '-'),
      token: result.token,
      baseUrl: result.baseUrl,
      savedAt: new Date().toISOString(),
      port,
    });
    console.log(`\n  ✅ Login successful! "${name}" → ${result.accountId}`);
    console.log(`  Starting daemon...\n`);
    // login 成功后直接进入 daemon 模式
    startOne(port);
  } catch (err) {
    console.error(`\n  ❌ Login failed: ${err}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Start / Stop / Restart
// ---------------------------------------------------------------------------

function startOne(port: number): void {
  process.env.CC2WECHAT_PORT = String(port);
  import('./v5/main.js');
}

function stopOne(port: number): boolean {
  try {
    const pid = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pid) {
      process.kill(parseInt(pid, 10), 'SIGTERM');
      const name = reverseAlias(port);
      console.log(`  ✅ stopped ${name ? `"${name}"` : ''} (PID ${pid}, port ${port})`);
      return true;
    }
  } catch { /* not running */ }
  return false;
}

function getAllPorts(): number[] {
  const aliases = loadAliases();
  const ports = Object.values(aliases);
  if (ports.length === 0) {
    // fallback: scan files
    try {
      const files = fs.readdirSync(DATA_DIR);
      for (const f of files) {
        const m = f.match(/^accounts-(\d+)\.json$/);
        if (m) ports.push(parseInt(m[1], 10));
      }
    } catch { /* no dir */ }
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

function rename(oldName: string, newName: string): void {
  const aliases = loadAliases();
  if (aliases[oldName] == null) {
    console.error(`  Unknown account: "${oldName}"`);
    console.log('  Available:', Object.keys(aliases).join(', ') || '(none)');
    process.exit(1);
  }
  if (aliases[newName] != null) {
    console.error(`  Name "${newName}" already taken (port ${aliases[newName]})`);
    process.exit(1);
  }
  aliases[newName] = aliases[oldName];
  delete aliases[oldName];
  saveAliases(aliases);
  console.log(`  ✅ "${oldName}" → "${newName}"`);
}

async function status(): Promise<void> {
  console.log('\n  🦞 cc2wechat status\n');

  const aliases = loadAliases();
  const ports = getAllPorts();

  if (ports.length === 0) {
    console.log('  No accounts found.');
    console.log('  Run: cc2wechat login --name myname\n');
    return;
  }

  for (const port of ports) {
    const name = reverseAlias(port);
    const account = getActiveAccount(port);
    console.log(`  ── ${name ?? 'unnamed'} (port ${port}) ──`);
    if (account) {
      console.log(`  Account: ${account.accountId}`);
    }

    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        const data = await res.json() as { status: string; uptime: number; cwd?: string };
        console.log(`  Daemon: ✅ running (uptime ${formatUptime(data.uptime)})`);
        if (data.cwd) {
          console.log(`  CWD: ${data.cwd}`);
        }

        const tabsPath = `/tmp/cc2wechat-tabs-${port}.json`;
        if (fs.existsSync(tabsPath)) {
          try {
            const tabsData = JSON.parse(fs.readFileSync(tabsPath, 'utf-8'));
            const entries = Object.values(tabsData);
            if (entries.length > 0) {
              console.log(`  Sessions: ${entries.length} active`);
            }
          } catch { /* skip */ }
        }
      } else {
        console.log('  Daemon: ⏹ stopped');
      }
    } catch {
      console.log('  Daemon: ⏹ stopped');
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

switch (command) {
  case '--text':
  case '--image':
  case '--file':
    reply().catch((err) => { console.error(String(err)); process.exit(1); });
    break;

  case '--end': {
    // CC 调这个命令关闭自己的 iTerm session
    const cp = findContextPath();
    const port = parseInt(process.env.CC2WECHAT_PORT ?? String(BASE_PORT), 10);
    fetch(`http://localhost:${port}/close-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextPath: cp }),
    }).then(() => {
      console.log('Session closed.');
    }).catch(() => {
      // fallback: 尝试所有端口
      const ports = getAllPorts();
      Promise.all(ports.map(p =>
        fetch(`http://localhost:${p}/close-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contextPath: cp }),
        }).catch(() => {})
      )).then(() => console.log('Session closed.'));
    });
    break;
  }

  case 'start': {
    if (targetName) {
      // cc2wechat start wife → 启动指定账号
      const port = resolvePort(targetName);
      startOne(port);
    } else {
      // cc2wechat start → 无参数，启动默认（第一个）
      const port = parseInt(process.env.CC2WECHAT_PORT ?? String(BASE_PORT), 10);
      startOne(port);
    }
    break;
  }

  case 'stop': {
    if (targetName) {
      const port = resolvePort(targetName);
      if (!stopOne(port)) {
        const name = reverseAlias(port);
        console.log(`  ℹ️  ${name ? `"${name}"` : `port ${port}`} is not running`);
      }
    } else {
      // cc2wechat stop → 停全部
      const ports = getAllPorts();
      let stopped = 0;
      for (const p of ports) { if (stopOne(p)) stopped++; }
      if (stopped === 0) console.log('  ℹ️  No running daemons');
    }
    break;
  }

  case 'restart': {
    const port = resolvePort(targetName);
    stopOne(port);
    await new Promise(r => setTimeout(r, 1000));
    startOne(port);
    break;
  }

  case 'rename': {
    const oldN = args[1];
    const newN = args[2];
    if (!oldN || !newN) {
      console.error('  Usage: cc2wechat rename <old> <new>');
      process.exit(1);
    }
    rename(oldN, newN);
    break;
  }

  case 'install':
  case 'setup':
  case 'login':
    login().catch(console.error);
    break;

  case 'status':
    status().catch(console.error);
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printUsage();
    break;

  default:
    console.error(`  Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
