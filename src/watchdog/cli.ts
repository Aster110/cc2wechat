#!/usr/bin/env node
// cc2wechat 带外看门狗 —— cron / launchd 每 2 分钟拉起一次，跑完即退。
//
// 用法:
//   cc2wechat-watchdog              正常跑一轮（该报警就报警）
//   cc2wechat-watchdog --dry-run    只算不发、不落状态（演练/装完自检用）
//   cc2wechat-watchdog --test-alert 往 webhook 发一条测试消息，验带外通道通不通
//   cc2wechat-watchdog --status     打印当前状态文件，不做任何探测

import fs from 'node:fs';

import { appendLog } from './log.js';
import { createFeishuNotifier } from './notify.js';
import { formatLocal } from './alerts.js';
import { ConfigError, loadConfig, resolveConfigPath, resolveExpiryPath, resolveLogPath, resolveStatePath } from './paths.js';
import { readExpiryFile } from './expiry.js';
import { runOnce } from './run.js';
import { loadState, saveState } from './state.js';

export interface CliOptions {
  dryRun: boolean;
  testAlert: boolean;
  status: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  return {
    dryRun: argv.includes('--dry-run'),
    testAlert: argv.includes('--test-alert'),
    status: argv.includes('--status'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

const HELP = `cc2wechat-watchdog —— 进程外带外看门狗

  (无参数)       跑一轮：探 /health、查凭证到期、该报警就打飞书
  --dry-run      只算不发、不落状态
  --test-alert   往 webhook 发一条测试消息
  --status       打印状态文件
  --help         本帮助

配置: $CC2WECHAT_WATCHDOG_CONFIG 或 ~/.cc2wechat/watchdog.json
状态: $CC2WECHAT_WATCHDOG_STATE  或 ~/.cc2wechat/watchdog-state.json
日志: $CC2WECHAT_WATCHDOG_LOG    或 ~/.cc2wechat/watchdog.log
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const configPath = resolveConfigPath();
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[watchdog] ${err.message}`);
      return 1;
    }
    throw err;
  }

  const statePath = resolveStatePath(config);
  const logPath = resolveLogPath(config);
  const expiryPath = resolveExpiryPath(config);

  if (opts.status) {
    console.log(JSON.stringify(loadState(statePath), null, 2));
    return 0;
  }

  const notifier = createFeishuNotifier(config.webhook);

  if (opts.testAlert) {
    const text = `🧪 [${config.machine}] watchdog 测试消息 —— 收到这条说明带外通道通了\n时间: ${formatLocal(new Date())}`;
    try {
      await notifier.send(text);
      console.log('[watchdog] 测试消息已发出');
      return 0;
    } catch (err) {
      console.error(`[watchdog] 测试消息发送失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const summary = await runOnce({
    config,
    notifier,
    dryRun: opts.dryRun,
    readExpiry: () => readExpiryFile(expiryPath),
    state: {
      load: () => loadState(statePath),
      save: (s) => saveState(statePath, s),
    },
    log: (line) => {
      try {
        appendLog(logPath, line);
      } catch {
        // 日志写不进去（盘满 / 权限）不该让看门狗静默退出，探测和报警已经跑完了
      }
    },
  });

  console.log(summary.logLine);
  if (opts.dryRun && summary.sent.length > 0) {
    console.log('--- dry-run 本来要发的消息 ---');
    for (const t of summary.sent) console.log(`${t}\n`);
  }
  return 0;
}

// 直接执行时才跑 main（被测试 import 时不跑）
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[watchdog] 未捕获错误: ${err instanceof Error ? err.stack : String(err)}`);
      process.exitCode = 1;
    },
  );
}
