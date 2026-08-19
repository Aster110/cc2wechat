/**
 * waku-codex-agent 的进程入口（架构 §12）。
 *
 * 跑法：`node dist/gateway/server.js`，配置全走 `WAKU_GATEWAY_*` 环境变量。
 * 刻意不注册 bin、不改 package.json scripts —— 这个 daemon 与 cc2wechat 的
 * 微信通道各活各的，共享一个 npm 入口只会让两边的部署互相牵连。
 *
 * 三件进程级职责：
 *
 * 1. **配置缺失要说人话**。缺 runtime.js 就在第一秒退出并说清楚缺什么，
 *    不留一个"起来了但每轮都 401"的僵尸。
 * 2. **健康/运维口只听回环**。它带着签发配对码的能力，绑到 0.0.0.0 等于把
 *    admin-bypass 的入口挂到公网上。
 * 3. **SIGTERM 排水**。停止收新消息 → 等在跑的 turn 收尾 → 冲 outbox → 关 Agent。
 *    直接 kill 会让"已经改过代码的那一轮"变成没人知道结局的悬案。
 */
import http from 'node:http';

import { isGatewayError } from './contracts/validation.js';
import { buildWakuGateway, loadGatewayConfig, type WakuGateway } from './bootstrap/waku.js';

const HEALTH_PATH = '/health';
const PAIR_GRANT_PATH = '/admin/pair-grant';

function log(message: string): void {
  process.stdout.write(`[waku-gateway ${new Date().toISOString()}] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[waku-gateway ${new Date().toISOString()}] ${message}\n`);
}

function respond(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

/** 运维口的请求体上限：这两个接口的入参就几十字节，超了一定是打错门了。 */
const MAX_BODY_BYTES = 4096;

type GrantRequest = NonNullable<Parameters<WakuGateway['issueGrant']>[0]>;

/** 只认这三个旋钮；多余字段一律无视（签发权已经由"能连上回环"这件事决定了）。 */
async function readJsonBody(request: http.IncomingMessage): Promise<GrantRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};

  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;

  const body: GrantRequest = {};
  if (typeof record.endpointId === 'string') body.endpointId = record.endpointId;
  if (typeof record.ttlMs === 'number') body.ttlMs = record.ttlMs;
  if (Array.isArray(record.scopes) && record.scopes.every((item) => typeof item === 'string')) {
    // 词表校验留给 PairingService：那里是唯一说了算的地方。
    body.scopes = record.scopes as GrantRequest['scopes'];
  }
  return body;
}

/**
 * 运维口。`/admin/pair-grant` 会**签发并当场打印**一次性配对码，
 * 所以它和 /health 一样只在 127.0.0.1 上听 —— 见 §12「health 不得暴露 token」的同源理由。
 */
export function createOpsServer(gateway: WakuGateway): http.Server {
  return http.createServer((request, response) => {
    const url = request.url ?? '/';
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.startsWith(HEALTH_PATH)) {
      gateway
        .health()
        .then((health) => respond(response, health.core.ok ? 200 : 503, health))
        .catch(() => respond(response, 500, { core: { ok: false }, error: 'health_failed' }));
      return;
    }

    if (method === 'POST' && url.startsWith(PAIR_GRANT_PATH)) {
      readJsonBody(request)
        .then((body) => gateway.issueGrant(body))
        .then((grant) => respond(response, 200, grant))
        .catch((error: unknown) =>
          respond(response, 400, {
            error: isGatewayError(error) ? error.code : 'grant_failed',
          }),
        );
      return;
    }

    respond(response, 404, { error: 'not_found' });
  });
}

async function main(): Promise<void> {
  const config = loadGatewayConfig(process.env);
  const gateway = buildWakuGateway({ config });

  // 凭证先探一次：runtime.js 不存在 / 过期 / 少 capability，都在这里明确报出来，
  // 而不是等第一条消息到了才发现收不进来。
  try {
    await gateway.credentials.current();
  } catch (error) {
    await gateway.stop().catch(() => undefined);
    throw error;
  }

  await gateway.start();

  const ops = createOpsServer(gateway);
  await new Promise<void>((resolve, reject) => {
    ops.once('error', reject);
    ops.listen(config.healthPort, config.healthHost, resolve);
  });

  log(
    `listening on http://${config.healthHost}:${config.healthPort}${HEALTH_PATH} ` +
      `(node=${config.nodeId}, endpoint=${config.endpoint.id}, state=${config.stateDir})`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, draining`);
    ops.close();
    gateway
      .stop()
      .then(() => {
        log('drained, exiting');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logError(`shutdown failed: ${isGatewayError(error) ? error.code : 'unknown'}`);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // 错误消息里可能带路径，但绝不带 token —— 各层的错误都只写字段名与 code。
  const detail = error instanceof Error ? error.message : String(error);
  const code = isGatewayError(error) ? `${error.code}: ` : '';
  logError(`startup failed — ${code}${detail}`);
  process.exit(1);
});
