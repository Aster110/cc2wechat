import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WatchdogConfig } from './types.js';

export const DEFAULT_CONFIG_PATH = '~/.cc2wechat/watchdog.json';
export const DEFAULT_STATE_PATH = '~/.cc2wechat/watchdog-state.json';
export const DEFAULT_LOG_PATH = '~/.cc2wechat/watchdog.log';
export const DEFAULT_EXPIRY_PATH = '~/.cc2wechat/credentials-expiry.json';
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_HOUR = 9;

/** `~` 展开。配置里手写路径的人不会记得 os.homedir() */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 每条路径都可被 env 覆盖——多机部署 + 测试临时目录都靠它 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.CC2WECHAT_WATCHDOG_CONFIG || DEFAULT_CONFIG_PATH);
}

export function resolveStatePath(cfg: WatchdogConfig, env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.CC2WECHAT_WATCHDOG_STATE || cfg.stateFile || DEFAULT_STATE_PATH);
}

export function resolveLogPath(cfg: WatchdogConfig, env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.CC2WECHAT_WATCHDOG_LOG || cfg.logFile || DEFAULT_LOG_PATH);
}

export function resolveExpiryPath(cfg: WatchdogConfig, env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.CC2WECHAT_WATCHDOG_EXPIRY || cfg.expiryFile || DEFAULT_EXPIRY_PATH);
}

export class ConfigError extends Error {}

/**
 * 读配置。坏配置一律抛 ConfigError——看门狗宁可在 cron 日志里死得明明白白，
 * 也不要"读不到配置就当没事发生"地静默活着（那正是它要治的病）。
 */
export function loadConfig(configPath: string, readFile = fs.readFileSync): WatchdogConfig {
  let raw: string;
  try {
    raw = String(readFile(configPath, 'utf-8'));
  } catch {
    throw new ConfigError(`配置不存在: ${configPath}（跑 scripts/install-watchdog.sh 生成样例）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`配置不是合法 JSON: ${configPath} (${err instanceof Error ? err.message : String(err)})`);
  }

  return normalizeConfig(parsed, configPath);
}

export function normalizeConfig(input: unknown, source = '<inline>'): WatchdogConfig {
  if (!input || typeof input !== 'object') throw new ConfigError(`配置必须是 JSON 对象: ${source}`);
  const cfg = input as Partial<WatchdogConfig>;

  if (!cfg.machine || typeof cfg.machine !== 'string') throw new ConfigError(`配置缺 machine: ${source}`);
  if (!cfg.webhook || typeof cfg.webhook !== 'string') throw new ConfigError(`配置缺 webhook: ${source}`);
  if (!Array.isArray(cfg.daemons) || cfg.daemons.length === 0) {
    throw new ConfigError(`配置缺 daemons（至少一个）: ${source}`);
  }

  const daemons = cfg.daemons.map((d, i) => {
    if (!d || typeof d !== 'object') throw new ConfigError(`daemons[${i}] 不是对象: ${source}`);
    if (!d.name || typeof d.name !== 'string') throw new ConfigError(`daemons[${i}] 缺 name: ${source}`);
    if (typeof d.port !== 'number' || !Number.isInteger(d.port)) {
      throw new ConfigError(`daemons[${i}] 缺合法 port: ${source}`);
    }
    return { name: d.name, port: d.port, host: d.host ?? '127.0.0.1' };
  });

  const heartbeatHour =
    typeof cfg.heartbeatHour === 'number' && cfg.heartbeatHour >= 0 && cfg.heartbeatHour <= 23
      ? cfg.heartbeatHour
      : DEFAULT_HEARTBEAT_HOUR;

  return {
    machine: cfg.machine,
    webhook: cfg.webhook,
    daemons,
    expiryFile: cfg.expiryFile,
    heartbeatHour,
    stateFile: cfg.stateFile,
    logFile: cfg.logFile,
    timeoutMs: typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}
