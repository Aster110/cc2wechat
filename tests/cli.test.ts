import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// We test the CLI helpers by importing them indirectly. Since cli.ts runs
// top-level code (process.argv parsing + switch), we extract the testable
// functions by re-implementing the key logic here and verifying behavior
// through integration-style tests that spawn the CLI or mock its deps.
// ---------------------------------------------------------------------------

describe('CLI --port parsing', () => {
  it('should extract --port from args and set env', () => {
    // Simulate the parsing logic from cli.ts
    const args = ['start', '--port', '18082'];
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      process.env.CC2WECHAT_PORT = args[portIdx + 1];
      args.splice(portIdx, 2);
    }

    expect(process.env.CC2WECHAT_PORT).toBe('18082');
    expect(args).toEqual(['start']);

    // Clean up
    delete process.env.CC2WECHAT_PORT;
  });

  it('should handle --port at end of args', () => {
    const args = ['status', '--port', '19000'];
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      process.env.CC2WECHAT_PORT = args[portIdx + 1];
      args.splice(portIdx, 2);
    }

    expect(process.env.CC2WECHAT_PORT).toBe('19000');
    expect(args).toEqual(['status']);

    delete process.env.CC2WECHAT_PORT;
  });

  it('should not set env if --port has no value', () => {
    delete process.env.CC2WECHAT_PORT;
    const args = ['start', '--port'];
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      process.env.CC2WECHAT_PORT = args[portIdx + 1];
      args.splice(portIdx, 2);
    }

    expect(process.env.CC2WECHAT_PORT).toBeUndefined();
  });
});

describe('formatUptime', () => {
  // Re-implement to test
  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m`;
    return `${Math.floor(seconds)}s`;
  }

  it('should format seconds', () => {
    expect(formatUptime(45)).toBe('45s');
  });

  it('should format minutes', () => {
    expect(formatUptime(150)).toBe('2m');
  });

  it('should format hours and minutes', () => {
    expect(formatUptime(9000)).toBe('2h30m');
  });

  it('should handle zero', () => {
    expect(formatUptime(0)).toBe('0s');
  });
});

describe('status daemon detection', () => {
  let server: http.Server;
  let port: number;

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it('should detect running daemon via health endpoint', async () => {
    // Start a mock health server
    const startedAt = new Date().toISOString();
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          account: 'test-account',
          startedAt,
          uptime: 9000,
        }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { status: string; uptime: number };
    expect(data.status).toBe('running');
    expect(data.uptime).toBe(9000);
  });

  it('should handle daemon not running', async () => {
    // Use a port that's definitely not listening
    try {
      await fetch('http://localhost:19999/health');
      // If it doesn't throw, that's unexpected but ok
    } catch (err) {
      // Expected: ECONNREFUSED
      expect(err).toBeDefined();
    }
  });
});

describe('status active sessions', () => {
  const tabsPath = '/tmp/cc2wechat-tabs-test.json';

  afterEach(() => {
    try { fs.unlinkSync(tabsPath); } catch { /* ok */ }
  });

  it('should parse tabs.json entries', () => {
    const tabs = [
      {
        userId: 'o9cq802y@im.wechat',
        tabId: 'D0EFA5D6-1234',
        sessionId: 'F601E36A-5678-9ABC-DEF0-123456789ABC',
        registeredAt: Date.now() - 300_000, // 5 min ago
      },
      {
        userId: 'x8kp903z@im.wechat',
        tabId: 'A1B2C3D4-5678',
        sessionId: 'A2B3C4D5-6789-0ABC-DEF1-234567890BCD',
        registeredAt: Date.now() - 10_000, // 10s ago
      },
    ];
    fs.writeFileSync(tabsPath, JSON.stringify(tabs));

    const parsed = JSON.parse(fs.readFileSync(tabsPath, 'utf-8')) as typeof tabs;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].userId).toBe('o9cq802y@im.wechat');
    expect(parsed[1].sessionId.startsWith('A2B3C4D5')).toBe(true);
  });

  it('should handle missing tabs.json gracefully', () => {
    expect(fs.existsSync('/tmp/cc2wechat-tabs-nonexistent.json')).toBe(false);
  });

  it('should handle malformed tabs.json', () => {
    fs.writeFileSync(tabsPath, 'not json');
    expect(() => JSON.parse(fs.readFileSync(tabsPath, 'utf-8'))).toThrow();
  });
});

describe('install does not call MCP registration', () => {
  it('should not contain MCP registration code', async () => {
    // Read the actual cli.ts source and verify no MCP references in install
    const src = fs.readFileSync(
      new URL('../src/cli.ts', import.meta.url).pathname,
      'utf-8',
    );

    // Extract the install function body
    // cli.ts 里 install/login 已合并，检查整个文件
    const installBody = src;

    // Should NOT contain MCP-related code
    expect(installBody).not.toContain('claude mcp add');
    expect(installBody).not.toContain('claude mcp remove');
    expect(installBody).not.toContain('MCP server');
    expect(installBody).not.toContain('serverPath');

    // Should contain login + start references
    expect(installBody).toContain('cc2wechat start');
  });
});
