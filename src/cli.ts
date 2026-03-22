#!/usr/bin/env node

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginWithQRWeb } from './auth.js';
import { saveAccount, getActiveAccount } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');

const command = process.argv[2];

function printUsage(): void {
  console.log(`
  🦞 wechat-claude — WeChat channel for Claude Code

  Usage:
    npx cc2wechat start       v2 Pipe Mode: listen & auto-reply via claude -p
    npx cc2wechat install     Setup: register MCP + scan QR login (v1 MCP mode)
    npx cc2wechat login       Re-login (scan QR code)
    npx cc2wechat status      Check connection status
    npx cc2wechat help        Show this help
`);
}

async function install(): Promise<void> {
  console.log('\n  🦞 wechat-claude installer\n');

  // Step 1: Register MCP server
  console.log('  [1/3] Registering MCP server...');
  try {
    execSync(
      `claude mcp add -s user wechat-channel node ${serverPath}`,
      { stdio: 'pipe' },
    );
    console.log('  ✅ MCP server registered (user-level)\n');
  } catch {
    // May already exist, try remove + add
    try {
      execSync(`claude mcp remove -s user wechat-channel`, { stdio: 'pipe' });
      execSync(
        `claude mcp add -s user wechat-channel node ${serverPath}`,
        { stdio: 'pipe' },
      );
      console.log('  ✅ MCP server updated (user-level)\n');
    } catch (err) {
      console.error('  ⚠️  Failed to register MCP server. You may need to add it manually:');
      console.log(`  claude mcp add -s user wechat-channel node ${serverPath}\n`);
    }
  }

  // Step 2: QR Login
  console.log('  [2/3] WeChat QR login...');
  const existing = getActiveAccount();
  if (existing) {
    console.log(`  ℹ️  Found existing account: ${existing.accountId}`);
    console.log('  Skipping login. Run "npx @aster110/wechat-claude login" to re-login.\n');
  } else {
    try {
      const result = await loginWithQRWeb();
      saveAccount({
        accountId: result.accountId.replace(/@/g, '-').replace(/\./g, '-'),
        token: result.token,
        baseUrl: result.baseUrl,
        savedAt: new Date().toISOString(),
      });
      console.log(`  ✅ Login successful! Account: ${result.accountId}\n`);
    } catch (err) {
      console.error(`  ❌ Login failed: ${err}`);
      console.log('  Run "npx @aster110/wechat-claude login" to retry.\n');
    }
  }

  // Step 3: Print next steps
  console.log('  [3/3] Setup complete!\n');
  console.log('  Next steps:');
  console.log('  1. Start Claude Code with WeChat channel:');
  console.log('     claude --dangerously-load-development-channels server:wechat-channel\n');
  console.log('  2. Send a message to your WeChat — Claude Code will auto-reply!\n');
}

async function login(): Promise<void> {
  console.log('\n  🦞 WeChat QR Login\n');
  try {
    const result = await loginWithQRWeb();
    saveAccount({
      accountId: result.accountId.replace(/@/g, '-').replace(/\./g, '-'),
      token: result.token,
      baseUrl: result.baseUrl,
      savedAt: new Date().toISOString(),
    });
    console.log(`\n  ✅ Login successful! Account: ${result.accountId}\n`);
  } catch (err) {
    console.error(`\n  ❌ Login failed: ${err}\n`);
    process.exit(1);
  }
}

function status(): void {
  const account = getActiveAccount();
  if (account) {
    console.log(`\n  🦞 WeChat Channel Status\n`);
    console.log(`  Account: ${account.accountId}`);
    console.log(`  Token: ${account.token.slice(0, 10)}...`);
    console.log(`  Base URL: ${account.baseUrl || 'https://ilinkai.weixin.qq.com'}`);
    console.log(`  Saved: ${account.savedAt}\n`);
  } else {
    console.log('\n  ⚠️  Not logged in. Run: npx @aster110/wechat-claude install\n');
  }
}

switch (command) {
  case 'start':
    import('./daemon.js');
    break;
  case 'install':
  case 'setup':
    install().catch(console.error);
    break;
  case 'login':
    login().catch(console.error);
    break;
  case 'status':
    status();
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
