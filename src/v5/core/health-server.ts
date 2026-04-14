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

  server.listen(port);
  return server;
}
