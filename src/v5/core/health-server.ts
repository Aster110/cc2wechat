import http from 'node:http';
import fs from 'node:fs';
import type { AccountData } from '../../store.js';
import type { Delivery, AIBackend } from '../interfaces/index.js';

export interface HealthServerDeps {
  account: AccountData;
  delivery: Delivery;
  backend: AIBackend;
  startedAt: string;
  cwd: string;
}

export function startHealthServer(port: number, deps: HealthServerDeps): http.Server {
  const { account, delivery, backend, startedAt, cwd } = deps;

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        version: 'v5',
        account: account.accountId,
        delivery: delivery.name,
        backend: backend.name,
        startedAt,
        uptime: process.uptime(),
        cwd,
      }));
    } else if (req.url === '/close-session' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        let parsed: { contextPath?: string };
        try {
          parsed = JSON.parse(body) as { contextPath?: string };
        } catch {
          res.writeHead(400);
          res.end('bad request');
          return;
        }
        if (!parsed.contextPath) {
          res.writeHead(400);
          res.end('bad request');
          return;
        }
        if (!fs.existsSync(parsed.contextPath)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        try {
          const ctx = JSON.parse(fs.readFileSync(parsed.contextPath, 'utf-8')) as { userId?: string };
          if (ctx.userId) {
            delivery.closeSession(ctx.userId).catch(() => {});
          }
          res.writeHead(200);
          res.end('ok');
        } catch {
          res.writeHead(400);
          res.end('bad request');
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  // 只听 127.0.0.1（2026-08-27 对齐 v6）：v5 老行为 listen(port) 绑 0.0.0.0，
  // 而 /close-session 无鉴权——公网口全靠云安全组挡是裸奔。健康检查/CLI 全在本机，回环够用。
  server.listen(port, '127.0.0.1');
  return server;
}
