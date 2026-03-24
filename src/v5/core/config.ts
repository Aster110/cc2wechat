import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AppConfig {
  delivery: string;
  backend: string;
  port: number;
  cwd?: string;
  reply?: {
    maxChunkSize?: number;
    stripMarkdown?: boolean;
  };
  session?: {
    staleTimeoutMs?: number;
    maxConcurrent?: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  delivery: 'auto',
  backend: 'claude-code',
  port: 18081,
  reply: {
    maxChunkSize: 3900,
    stripMarkdown: true,
  },
  session: {
    staleTimeoutMs: 86400000,
    maxConcurrent: 10,
  },
};

const CONFIG_PATH = path.join(
  process.env.HOME ?? '~',
  '.claude/channels/wechat-channel/config.json',
);

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      cachedConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        reply: { ...DEFAULT_CONFIG.reply, ...parsed.reply },
        session: { ...DEFAULT_CONFIG.session, ...parsed.session },
      };
    } catch {
      cachedConfig = { ...DEFAULT_CONFIG };
    }
  } else {
    cachedConfig = { ...DEFAULT_CONFIG };
  }

  return cachedConfig!;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}
