import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Config 读取测试
 * 验证文件读取、默认值、内存缓存
 */

// ---- Mock fs ----

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// ---- 内联接口 ----

interface AppConfig {
  delivery: string;
  backend: string;
  port: number;
  reply?: {
    maxChunkSize?: number;
    stripMarkdown?: boolean;
  };
  session?: {
    staleTimeoutMs?: number;
    maxConcurrent?: number;
  };
}

// ---- Config 简化实现 ----

const DEFAULT_CONFIG: AppConfig = {
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

function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  if ((fs.existsSync as ReturnType<typeof vi.fn>)(CONFIG_PATH)) {
    try {
      const raw = (fs.readFileSync as ReturnType<typeof vi.fn>)(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw as string);
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

function resetConfigCache(): void {
  cachedConfig = null;
}

// ---- Tests ----

describe('Config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigCache();
  });

  it('returns file content when config file exists', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        delivery: 'terminal',
        backend: 'claude-code',
        port: 9999,
      }),
    );

    const config = loadConfig();

    expect(config.delivery).toBe('terminal');
    expect(config.port).toBe(9999);
    expect(config.backend).toBe('claude-code');
  });

  it('returns default config when no file exists', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const config = loadConfig();

    expect(config.delivery).toBe('auto');
    expect(config.backend).toBe('claude-code');
    expect(config.port).toBe(18081);
  });

  it('uses defaults for missing fields in partial config file', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ delivery: 'sdk' }),
    );

    const config = loadConfig();

    expect(config.delivery).toBe('sdk');
    expect(config.backend).toBe('claude-code');
    expect(config.port).toBe(18081);
  });

  it('caches config — second call does not re-read file', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ delivery: 'pipe', port: 3000 }),
    );

    const first = loadConfig();
    const second = loadConfig();

    expect(first).toBe(second); // same reference
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns default config when file has invalid JSON', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('not valid json{{{');

    const config = loadConfig();

    expect(config.delivery).toBe('auto');
    expect(config.port).toBe(18081);
  });

  it('partial nested config merges correctly — preserves sub-field defaults', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ reply: { maxChunkSize: 2000 } }),
    );

    const config = loadConfig();

    expect(config.reply?.maxChunkSize).toBe(2000);
    expect(config.reply?.stripMarkdown).toBe(true); // default preserved
    expect(config.session?.staleTimeoutMs).toBe(86400000); // session defaults intact
    expect(config.session?.maxConcurrent).toBe(10);
  });

  it('default config has correct default values', () => {
    expect(DEFAULT_CONFIG.delivery).toBe('auto');
    expect(DEFAULT_CONFIG.backend).toBe('claude-code');
    expect(DEFAULT_CONFIG.port).toBe(18081);
    expect(DEFAULT_CONFIG.reply?.maxChunkSize).toBe(3900);
    expect(DEFAULT_CONFIG.reply?.stripMarkdown).toBe(true);
    expect(DEFAULT_CONFIG.session?.staleTimeoutMs).toBe(86400000);
    expect(DEFAULT_CONFIG.session?.maxConcurrent).toBe(10);
  });
});
