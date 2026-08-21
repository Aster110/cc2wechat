/**
 * waku gateway daemon 的进程入口（架构 §12）。
 *
 * 跑法：`node dist/gateway/server.js`，配置全走 `WAKU_GATEWAY_*` 环境变量；
 * `WAKU_GATEWAY_CHANNEL` 选通道：`waku-mailbox`（缺省，V1 加密信箱）| `waku-dm`（马甲私聊）。
 * 刻意不注册 bin、不改 package.json scripts —— 这个 daemon 与 cc2wechat 的
 * 微信通道各活各的，共享一个 npm 入口只会让两边的部署互相牵连。
 *
 * 三件进程级职责：
 *
 * 1. **配置缺失要说人话**。缺 runtime.js / 凭证就在第一秒退出并说清楚缺什么，
 *    不留一个"起来了但每轮都 401"的僵尸。
 * 2. **健康/运维口只听回环**。它带着签发配对码的能力，绑到 0.0.0.0 等于把
 *    admin-bypass 的入口挂到公网上。
 * 3. **SIGTERM 排水**。停止收新消息 → 等在跑的 turn 收尾 → 冲 outbox → 关 Agent。
 *    直接 kill 会让"已经改过代码的那一轮"变成没人知道结局的悬案。
 *
 * 另有一个只读诊断开关：`--sse-smoke <秒>`——用配置里的凭证订阅 `/users/me/events` N 秒，
 * 只打印事件名与 seq（不打印 token、不打印正文），用真后端验证帧解析与鉴权链路。
 */
import http from 'node:http';

import { isGatewayError } from './contracts/validation.js';
import { buildWakuGateway, loadGatewayConfig, readEnv, type IssuedGrant, type WakuGateway } from './bootstrap/waku.js';
import { buildWakuDmGateway, createBridgeTokenProvider, loadDmGatewayConfig } from './bootstrap/waku-dm.js';
import { createSseSubscription } from './channels/waku-dm/sse-client.js';
import { createStdLogger } from './log.js';

const HEALTH_PATH = '/health';
const PAIR_GRANT_PATH = '/admin/pair-grant';

const stdLog = createStdLogger('waku-gateway');

function log(message: string): void {
  stdLog.info(message);
}

function logError(message: string): void {
  stdLog.error(message);
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

/** 运维口看得到的 gateway 投影：两种通道都有 health；只有 V1 信箱能签配对码。 */
export interface OpsGateway {
  health(): Promise<{ core: { ok: boolean } }>;
  issueGrant?(input?: GrantRequest): Promise<IssuedGrant>;
}

/**
 * 运维口。`/admin/pair-grant` 会**签发并当场打印**一次性配对码，
 * 所以它和 /health 一样只在 127.0.0.1 上听 —— 见 §12「health 不得暴露 token」的同源理由。
 */
export function createOpsServer(gateway: OpsGateway): http.Server {
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
      const issueGrant = gateway.issueGrant;
      if (issueGrant === undefined) {
        respond(response, 404, { error: 'pairing_not_supported_on_this_channel' });
        return;
      }
      readJsonBody(request)
        .then((body) => issueGrant.call(gateway, body))
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

interface RunningDaemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  ops: OpsGateway;
  healthHost: string;
  healthPort: number;
  summary: string;
}

async function buildMailboxDaemon(): Promise<RunningDaemon> {
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

  return {
    start: () => gateway.start(),
    stop: () => gateway.stop(),
    ops: gateway,
    healthHost: config.healthHost,
    healthPort: config.healthPort,
    summary: `channel=waku-mailbox node=${config.nodeId} endpoint=${config.endpoint.id} state=${config.stateDir}`,
  };
}

async function buildDmDaemon(): Promise<RunningDaemon> {
  const config = loadDmGatewayConfig(process.env);
  const gateway = buildWakuDmGateway({ config });

  // 凭证先探一次：凭证文件缺失 / 权限不对 / 已吊销 / auth.json 过期且刷不出来，都在第一秒说清楚。
  try {
    const who = await gateway.credentials.identity();
    log(`credentials ok (mode=${config.credential.mode}, self=${who.userId.slice(0, 12)}…${who.bridgeId === undefined ? '' : `, bridge=${who.bridgeId}`})`);
  } catch (error) {
    await gateway.stop().catch(() => undefined);
    throw error;
  }

  return {
    start: () => gateway.start(),
    stop: () => gateway.stop(),
    ops: gateway,
    healthHost: config.healthHost,
    healthPort: config.healthPort,
    summary:
      `channel=waku-dm mode=${config.credential.mode} node=${config.nodeId} endpoint=${config.endpoint.id} ` +
      `owners=${config.ownerUserIds.length} defaultTier=${config.defaultTier} state=${config.stateDir}`,
  };
}

/**
 * 只读 smoke：订阅 N 秒，打印事件名与 seq。绝不打印 token / 正文。
 * 退出码 0 = 至少成功连上过一次；1 = 一次都没连上（鉴权 / 地址 / 网络问题）。
 */
async function runSseSmoke(seconds: number): Promise<void> {
  const config = loadDmGatewayConfig(process.env);
  const credentials = createBridgeTokenProvider(config);
  const who = await credentials.identity();
  log(`sse-smoke: mode=${config.credential.mode} self=${who.userId.slice(0, 12)}… api=${config.apiBase} seconds=${seconds}`);

  const counts = new Map<string, number>();
  let frames = 0;
  let firstSeq: string | null = null;
  let lastSeq: string | null = null;
  let connectedOnce = false;

  const sub = createSseSubscription({
    url: `${config.apiBase}/users/me/events`,
    headers: async () => ({ Authorization: `Bearer ${await credentials.current()}` }),
    lastEventId: () => null,
    onFrame: (frame) => {
      frames += 1;
      counts.set(frame.event, (counts.get(frame.event) ?? 0) + 1);
      if (firstSeq === null) firstSeq = frame.id;
      lastSeq = frame.id;
      // 只记事件名与 seq；data 是用户正文，不打印。
      log(`  event=${frame.event} seq=${frame.id ?? '-'} bytes=${Buffer.byteLength(frame.data)}`);
    },
    onAuthRejected: () => credentials.invalidate(),
    onStateChange: (state) => {
      if (state === 'open') connectedOnce = true;
      log(`  sse state=${state}`);
    },
    log: stdLog,
    label: 'sse-smoke',
    idleTimeoutMs: config.sseIdleTimeoutMs,
  });
  sub.start();
  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
  await sub.stop();

  const stats = sub.stats();
  const byEvent = [...counts.entries()].map(([event, count]) => `${event}=${count}`).join(' ') || '(none)';
  log(`sse-smoke done: frames=${frames} seq=${firstSeq ?? '-'}..${lastSeq ?? '-'} reconnects=${stats.reconnects} lastError=${stats.lastError ?? '-'} events: ${byEvent}`);
  log(`sse-smoke credential state=${credentials.health().state}`);
  process.exit(connectedOnce ? 0 : 1);
}

function parseSmokeSeconds(argv: readonly string[]): number | null {
  const index = argv.indexOf('--sse-smoke');
  if (index === -1) return null;
  const raw = argv[index + 1];
  const seconds = raw === undefined ? 15 : Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--sse-smoke expects a positive number of seconds');
  return seconds;
}

async function main(): Promise<void> {
  const smoke = parseSmokeSeconds(process.argv.slice(2));
  if (smoke !== null) {
    await runSseSmoke(smoke);
    return;
  }

  const channel = readEnv(process.env, 'CHANNEL') ?? 'waku-mailbox';
  let daemon: RunningDaemon;
  if (channel === 'waku-dm') daemon = await buildDmDaemon();
  else if (channel === 'waku-mailbox' || channel === 'waku') daemon = await buildMailboxDaemon();
  else throw new Error(`WAKU_GATEWAY_CHANNEL must be 'waku-mailbox' (default) or 'waku-dm', got '${channel}'`);

  await daemon.start();

  const ops = createOpsServer(daemon.ops);
  await new Promise<void>((resolve, reject) => {
    ops.once('error', reject);
    ops.listen(daemon.healthPort, daemon.healthHost, resolve);
  });

  log(`listening on http://${daemon.healthHost}:${daemon.healthPort}${HEALTH_PATH} (${daemon.summary})`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, draining`);
    ops.close();
    daemon
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
