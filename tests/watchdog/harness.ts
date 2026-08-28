import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

export interface MockServer {
  port: number;
  close(): Promise<void>;
}

export type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** 起一个本地 http mock，返回端口 + 关闭器（socket 一律记账，hang 场景也能干净关掉） */
export async function startMock(handler: MockHandler): Promise<MockServer> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** /health 返回固定 JSON */
export function healthMock(body: unknown, status = 200): MockHandler {
  return (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

/** 拿一个"确定没人监听"的端口：起了立刻关 */
export async function deadPort(): Promise<number> {
  const s = await startMock((_req, res) => res.end('x'));
  const p = s.port;
  await s.close();
  return p;
}

/** 收 POST body 的 mock（飞书 webhook 用） */
export function collectorMock(
  received: Array<{ url: string; body: string }>,
  respond: { status?: number; json?: unknown } = {},
): MockHandler {
  return (req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: data });
      res.writeHead(respond.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respond.json ?? { code: 0, msg: 'success' }));
    });
  };
}

/** 造一个 turns 数组（TurnTiming 的子集，probe 只看 outcome） */
export function turns(...outcomes: Array<'final' | 'error' | 'aborted'>) {
  return outcomes.map((outcome, i) => ({
    conversationId: `c${i}`,
    agent: 'codex',
    queueMs: 1,
    firstEventMs: 2,
    totalMs: 3,
    outcome,
    endedAt: 1000 + i,
  }));
}

export const okHealth = {
  status: 'running',
  version: '5.2.1',
  engine: 'v6',
  agent: 'codex',
  persistent: true,
  agentHealth: { ok: true, detail: 'app-server 常驻' },
  account: 'acc-1',
  cwd: '/work',
  startedAt: '2026-08-27T00:00:00.000Z',
  uptime: 3600,
  scheduler: { running: 0, queued: 0 },
  turns: turns('final', 'final'),
};
