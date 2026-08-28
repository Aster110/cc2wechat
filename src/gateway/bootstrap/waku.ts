/**
 * 组装层：把 M1/M2/M4 的零件接成一台能跑的 daemon（架构 §12 部署拓扑）。
 *
 * 这一层**只做接线**，不放业务判断 —— 任何"要不要拒绝""该走哪条路"的决定
 * 都属于 Core，写到这里就等于绕开了测试覆盖的那一层。
 *
 * 接线顺序（依赖从下往上）：
 *
 *   CredentialProvider → WakuDataClient → CursorStore ┐
 *                                                      ├→ MailboxAdapter
 *   GatewayStore → PairingService → PairingFlow ───────┤   （opener/sink 由 Core 提供）
 *                → ConversationService → Registry ─────┤
 *                → CoreDelivery → Orchestrator → Ingress ┘
 *   LocalRunnerAdapter → v6 CodexAppServerAgent（常驻 codex）
 *
 * 三件在这里做掉、别处做不了的事：
 *
 * 1. **分片重组与"已见"集合放内存**。M1 的 `chunk_assemblies` 表没有
 *    protocolVersion/direction/kind/keyVersion 四列，而这四个字段都进 AAD，
 *    从表里读回来的分片解不开。持久化靠另一条路兜底：游标不会越过没拼齐的消息，
 *    重启后回扫窗会把它们重新读回来，真正的幂等闸门是 `inbox_receipts`。
 * 2. **admin 名单是一份活文件**。principalId 是配对当场铸出来的，签发时还不存在，
 *    所以只能事后登记；文件每次判定都重读，加一个人不用重启。
 * 3. **一次性配对码只活在这个进程里**。它从不落库（库里只有 hash），
 *    所以 daemon 重启后未完成的配对必须重新签发 —— 这是设计，不是缺陷。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { CodexAppServerAgent } from '../../v6/agents/codex-app-server.js';
import { ClaudeSdkAgent } from '../../v6/agents/claude-sdk.js';
import type { AgentAdapter } from '../../v6/contracts.js';

import type { MailboxChunk } from '../contracts/envelope.js';
import type { AgentEndpoint, TrustTier } from '../contracts/runner.js';
import { isTrustTier, type PairingScope, PAIRING_SCOPES } from '../contracts/pairing.js';
import { gatewayError } from '../contracts/validation.js';
import { createStatusHeartbeat } from '../core/status-heartbeat.js';

import {
  createRuntimeCredentialProvider,
  type RuntimeCredentialProvider,
} from '../channels/waku/credential-provider.js';
import {
  createWakuDataClient,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
} from '../channels/waku/data-client.js';
import {
  createWakuCursorStore,
  type CursorPersistence,
  type SeenKey,
} from '../channels/waku/cursor-store.js';
import {
  createWakuMailboxAdapter,
  type ChunkAssemblyStore,
  type PollConfig,
  type WakuMailboxAdapter,
} from '../channels/waku/mailbox-adapter.js';

import { openGatewayStore, type GatewayStore } from '../state/sqlite-store.js';
import { createAgentEndpointRegistry, type AgentEndpointRegistry } from '../runners/registry.js';
import { createLocalRunnerAdapter } from '../runners/local-runner.js';
import {
  createPairingService,
  type IssuerContext,
  type PairingService,
} from '../core/pairing-service.js';
import { createPairingFlow, type PairingFlow } from '../core/pairing-flow.js';
import { createConversationService } from '../core/conversation-service.js';
import { createCoreDelivery, type CoreDelivery } from '../core/delivery.js';
import {
  createGatewayOrchestrator,
  type GatewayHealth,
  type GatewayOrchestrator,
} from '../core/orchestrator.js';
import { createCoreIngress, type CoreIngress } from '../core/ingress.js';
import { DEFAULT_DM_HEALTH_PORT } from '../dm-paths.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const ENV_PREFIX = 'WAKU_GATEWAY_';

export interface EndpointConfig {
  id: string;
  workspacePolicyId: string;
  trustTier: TrustTier;
  runnerProfileId: string;
}

export interface GatewayConfig {
  stateDir: string;
  dbPath: string;
  masterKeyPath: string;
  adminPrincipalsPath: string;
  healthHost: string;
  healthPort: number;
  runtimeJsPath: string;
  /** 重新 bootstrap runtime.js 的命令（走 sh -c）。没配就只能用现成的 token。 */
  mintCommand: string | null;
  instanceId: string;
  nodeId: string;
  endpoint: EndpointConfig;
  /** workspacePolicyId → cwd。客户端够不到这张表，这是执行位置的唯一来源。 */
  workspaces: Record<string, string>;
  /** 环境变量里显式列出的 admin principal（与活文件取并集）。 */
  adminPrincipals: string[];
  polling: Partial<PollConfig>;
  queueCap: number;
  outboxTtlMs: number;
  pairTtlMs: number;
  grantTtlMs: number;
  flushIntervalMs: number;
  codexHome: string | null;
  codexEffort: string | null;
  defaultScopes: PairingScope[];
}

export const DEFAULT_HEALTH_PORT = 18091;
/** waku-dm 通道的缺省运维端口：与 V1 信箱 daemon 可以同机并跑。唯一定义在 `../dm-paths.js`。 */
export { DEFAULT_DM_HEALTH_PORT };
export const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
export const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;

export function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[`${ENV_PREFIX}${key}`];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readEnv(env, key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw configError(`${ENV_PREFIX}${key} must be a positive integer`);
  }
  return parsed;
}

export function readList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = readEnv(env, key);
  if (raw === null) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function configError(message: string): Error & { code: string } {
  return gatewayError('invalid_config', message);
}

/** `policy=/path,other=/path2`。留空则用 WORKSPACE_DIR 兜底给主 policy。 */
export function parseWorkspaces(
  env: NodeJS.ProcessEnv,
  policyId: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of readList(env, 'WORKSPACE_MAP')) {
    const at = entry.indexOf('=');
    if (at <= 0) {
      throw configError(`${ENV_PREFIX}WORKSPACE_MAP entries must look like policyId=/abs/path`);
    }
    map[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  const fallback = readEnv(env, 'WORKSPACE_DIR');
  if (fallback !== null) map[policyId] = fallback;
  if (map[policyId] === undefined) map[policyId] = process.cwd();

  for (const [policy, dir] of Object.entries(map)) {
    if (!path.isAbsolute(dir)) {
      throw configError(`workspace for ${policy} must be an absolute path`);
    }
  }
  return map;
}

function parseScopes(env: NodeJS.ProcessEnv): PairingScope[] {
  const listed = readList(env, 'DEFAULT_SCOPES');
  if (listed.length === 0) return [...PAIRING_SCOPES];
  for (const scope of listed) {
    if (!(PAIRING_SCOPES as readonly string[]).includes(scope)) {
      throw configError(`${ENV_PREFIX}DEFAULT_SCOPES contains an unknown scope: ${scope}`);
    }
  }
  return listed as PairingScope[];
}

/**
 * 读全部 `WAKU_GATEWAY_*`。**缺 runtime.js 就直接报错**：没有它连一条消息都收不到，
 * 与其起一个假装健康、每轮都 401 的进程，不如在第一秒说清楚。
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const runtimeJsPath = readEnv(env, 'RUNTIME_JS');
  if (runtimeJsPath === null) {
    throw configError(
      `${ENV_PREFIX}RUNTIME_JS is required: it points at the runtime.js produced by ` +
        '`waku bootstrap`, which carries the Waku runtime credentials.',
    );
  }

  const stateDir = readEnv(env, 'STATE_DIR') ?? path.join(os.homedir(), '.waku-gateway');
  const nodeId = readEnv(env, 'NODE_ID') ?? os.hostname();
  const endpointId = readEnv(env, 'ENDPOINT_ID') ?? 'aster-admin';
  const workspacePolicyId = readEnv(env, 'WORKSPACE_POLICY_ID') ?? 'admin-home';
  const trustTierRaw = readEnv(env, 'TRUST_TIER') ?? 'admin-bypass';
  if (!isTrustTier(trustTierRaw)) {
    throw configError(`${ENV_PREFIX}TRUST_TIER is not a known trust tier: ${trustTierRaw}`);
  }

  const polling: Partial<PollConfig> = {};
  const activeMin = readEnv(env, 'POLL_ACTIVE_MIN_MS');
  if (activeMin !== null) polling.activeMinMs = readInt(env, 'POLL_ACTIVE_MIN_MS', 0);
  const activeMax = readEnv(env, 'POLL_ACTIVE_MAX_MS');
  if (activeMax !== null) polling.activeMaxMs = readInt(env, 'POLL_ACTIVE_MAX_MS', 0);
  const idleMin = readEnv(env, 'POLL_IDLE_MIN_MS');
  if (idleMin !== null) polling.idleMinMs = readInt(env, 'POLL_IDLE_MIN_MS', 0);
  const idleMax = readEnv(env, 'POLL_IDLE_MAX_MS');
  if (idleMax !== null) polling.idleMaxMs = readInt(env, 'POLL_IDLE_MAX_MS', 0);
  const idleAfter = readEnv(env, 'POLL_IDLE_AFTER_EMPTY');
  if (idleAfter !== null) polling.idleAfterEmptyPolls = readInt(env, 'POLL_IDLE_AFTER_EMPTY', 0);

  return {
    stateDir,
    dbPath: readEnv(env, 'DB_PATH') ?? path.join(stateDir, 'gateway.db'),
    masterKeyPath: readEnv(env, 'MASTER_KEY_PATH') ?? path.join(stateDir, 'master.key'),
    adminPrincipalsPath:
      readEnv(env, 'ADMIN_PRINCIPALS_PATH') ?? path.join(stateDir, 'admin-principals'),
    // 健康/运维面只听回环：它带着签发配对码的能力，绝不能对外。
    healthHost: '127.0.0.1',
    healthPort: readInt(env, 'HEALTH_PORT', DEFAULT_HEALTH_PORT),
    runtimeJsPath,
    mintCommand: readEnv(env, 'MINT_COMMAND'),
    instanceId: readEnv(env, 'INSTANCE_ID') ?? `waku-${nodeId}`,
    nodeId,
    endpoint: {
      id: endpointId,
      workspacePolicyId,
      trustTier: trustTierRaw,
      runnerProfileId: readEnv(env, 'RUNNER_PROFILE_ID') ?? `local-${nodeId}`,
    },
    workspaces: parseWorkspaces(env, workspacePolicyId),
    adminPrincipals: readList(env, 'ADMIN_PRINCIPALS'),
    polling,
    queueCap: readInt(env, 'QUEUE_CAP', 5),
    outboxTtlMs: readInt(env, 'OUTBOX_TTL_MS', 5 * 60 * 1000),
    pairTtlMs: readInt(env, 'PAIR_TTL_MS', 3 * 60 * 1000),
    grantTtlMs: readInt(env, 'GRANT_TTL_MS', DEFAULT_GRANT_TTL_MS),
    flushIntervalMs: readInt(env, 'FLUSH_INTERVAL_MS', DEFAULT_FLUSH_INTERVAL_MS),
    codexHome: readEnv(env, 'CODEX_HOME'),
    codexEffort: readEnv(env, 'CODEX_EFFORT'),
    defaultScopes: parseScopes(env),
  };
}

// ---------------------------------------------------------------------------
// 小零件
// ---------------------------------------------------------------------------

/** UUIDv7（时间前缀 + 随机尾巴），满足契约层冻结的正则。 */
export function uuidV7(now: number): string {
  const hex = now.toString(16).padStart(12, '0').slice(-12);
  const tail = randomUUID().slice(14);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(1)}`;
}

const defaultFetch: FetchLike = async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: { get: (name: string) => response.headers.get(name) },
    text: () => response.text(),
  };
};

/**
 * 内存分片仓。见文件头第 1 条：M1 的表存不下 AAD 需要的头字段，
 * 重启丢失由"游标不越过未拼齐消息 + 回扫窗"补回来。
 */
function createMemoryAssemblies(now: () => number): ChunkAssemblyStore {
  const byMessage = new Map<string, Map<number, MailboxChunk>>();

  return {
    save(chunk: MailboxChunk): 'inserted' | 'duplicate' | 'conflict' {
      const existing = byMessage.get(chunk.messageId);
      if (existing === undefined) {
        byMessage.set(chunk.messageId, new Map([[chunk.chunkIndex, chunk]]));
        return 'inserted';
      }
      const head = existing.values().next().value;
      if (head !== undefined && head.chunkCount !== chunk.chunkCount) return 'conflict';
      const seen = existing.get(chunk.chunkIndex);
      if (seen !== undefined) {
        return seen.payload.ciphertext === chunk.payload.ciphertext && seen.nonce === chunk.nonce
          ? 'duplicate'
          : 'conflict';
      }
      existing.set(chunk.chunkIndex, chunk);
      return 'inserted';
    },

    take(messageId: string, at: number): MailboxChunk[] | null {
      const held = byMessage.get(messageId);
      if (held === undefined) return null;
      const chunks = [...held.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
      // 到期即 fail-closed：块齐了也不产出，并原子清掉残留。
      if (chunks.some((chunk) => at >= chunk.expiresAt)) {
        byMessage.delete(messageId);
        return null;
      }
      if (chunks.length !== chunks[0].chunkCount) return null;
      byMessage.delete(messageId);
      return chunks;
    },

    drop(messageId: string): void {
      byMessage.delete(messageId);
    },
  };
}

/**
 * 游标持久化：位置落 SQLite（跨重启有效），"已见"集合放内存。
 * 后者只是省一次重复解密 —— 真正防重放的是 `inbox_receipts` 那张表。
 */
function createCursorPersistence(store: GatewayStore, now: () => number): CursorPersistence {
  const seen = new Map<string, number>();
  const RETENTION_MS = 30 * 60 * 1000;

  function key(input: SeenKey): string {
    return `${input.collection} ${input.messageId} ${input.chunkIndex}`;
  }

  function prune(at: number): void {
    for (const [id, createdAt] of seen) {
      if (at - createdAt > RETENTION_MS) seen.delete(id);
    }
  }

  return {
    getCursor: (collection) => store.getCursor(collection),
    commitCursor: (collection, cursor) =>
      store.transaction((tx) => tx.commitCursor(collection, cursor)),
    hasSeen: (input) => seen.has(key(input)),
    markSeen: (input) => {
      const at = now();
      prune(at);
      seen.set(key(input), input.createdAt);
    },
  };
}

/** admin 名单 = 环境变量 ∪ 活文件。每次判定都重读文件，加人不用重启。 */
function createAdminRoster(config: GatewayConfig): {
  has(principalId: string): boolean;
  add(principalId: string): void;
} {
  const fromEnv = new Set(config.adminPrincipals);

  function fromFile(): Set<string> {
    try {
      const text = fs.readFileSync(config.adminPrincipalsPath, 'utf8');
      return new Set(
        text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#')),
      );
    } catch {
      return new Set();
    }
  }

  return {
    has: (principalId) => fromEnv.has(principalId) || fromFile().has(principalId),
    add: (principalId) => {
      if (fromEnv.has(principalId) || fromFile().has(principalId)) return;
      fs.mkdirSync(path.dirname(config.adminPrincipalsPath), { recursive: true });
      fs.appendFileSync(config.adminPrincipalsPath, `${principalId}\n`, { mode: 0o600 });
    },
  };
}

function createMint(config: GatewayConfig): () => Promise<void> {
  return async () => {
    if (config.mintCommand === null) {
      throw gatewayError(
        'mint_not_configured',
        `${ENV_PREFIX}MINT_COMMAND is not set, so runtime credentials cannot be refreshed`,
      );
    }
    const command = config.mintCommand;
    await new Promise<void>((resolve, reject) => {
      execFile('sh', ['-c', command], { timeout: 120_000 }, (error) => {
        if (error) reject(gatewayError('mint_failed', 'the mint command failed'));
        else resolve();
      });
    });
  };
}

/**
 * 运维 CLI 只需要知道 daemon 在哪听：按通道给缺省端口，不要求 V1 的 RUNTIME_JS 等全量配置。
 */
export function loadOpsEndpoint(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const channel = readEnv(env, 'CHANNEL') ?? 'waku-mailbox';
  const fallback = channel === 'waku-dm' ? DEFAULT_DM_HEALTH_PORT : DEFAULT_HEALTH_PORT;
  return { host: '127.0.0.1', port: readInt(env, 'HEALTH_PORT', fallback) };
}

export interface GatewayAgentOptions {
  /** `codex`（缺省，常驻 app-server）| `claude-sdk` / `claude`。 */
  backend: string | null;
  codexHome: string | null;
  codexEffort: string | null;
  /** 健康检查端口：只用来给 app-server 的 pid 文件命名。 */
  port: number;
  /** 给定则 pid 文件落这里（waku-dm 放进自己的 state dir，不碰 ~/.cc2wechat）。 */
  pidFilePath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Agent 后端可切（WAKU_GATEWAY_AGENT_BACKEND=codex|claude-sdk，缺省 codex）。
 * 节点上没有 codex 二进制/登录态时（如 air2），用 claude-sdk 走本机 Claude Code 登录态。
 */
export function createGatewayAgent(options: GatewayAgentOptions): AgentAdapter {
  const backend = (options.backend ?? 'codex').trim().toLowerCase();
  if (backend === 'claude-sdk' || backend === 'claude') return new ClaudeSdkAgent();
  const baseEnv = options.env ?? process.env;
  return new CodexAppServerAgent({
    env: {
      ...baseEnv,
      ...(options.codexHome === null ? {} : { CODEX_HOME: options.codexHome }),
      ...(options.codexEffort === null ? {} : { CC2WECHAT_CODEX_EFFORT: options.codexEffort }),
    },
    port: options.port,
    ...(options.pidFilePath === undefined ? {} : { pidFilePath: options.pidFilePath }),
  });
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/** 本进程 = 已认证的签发者。能跑到这行就已经握有本机 shell 权限。 */
export const SERVER_SESSION: IssuerContext = { kind: 'server-session' };

export interface IssuedGrant {
  grantId: string;
  /** 明文只在这里出现一次。 */
  token: string;
  pairRouteId: string;
  endpointId: string;
  scopes: PairingScope[];
  expiresAt: number;
}

export interface WakuGatewayHealth extends GatewayHealth {
  mailbox: { ok: boolean; state: string; cursorLagMs: number; pendingOutbox: number };
  credential: { ok: boolean; state: string; expiresInSec: number };
  outbox: { pending: number };
  /** 排障用：拍到哪了、上一拍什么结果。不含 routeId，符合 health 不外泄红线。 */
  heartbeat: { lastBeatAt: number | null; lastResult: string | null };
}

export interface WakuGateway {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  readonly registry: AgentEndpointRegistry;
  readonly pairings: PairingService;
  readonly pairingFlow: PairingFlow;
  readonly delivery: CoreDelivery;
  readonly orchestrator: GatewayOrchestrator;
  readonly ingress: CoreIngress;
  readonly adapter: WakuMailboxAdapter;
  readonly credentials: RuntimeCredentialProvider;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<WakuGatewayHealth>;
  issueGrant(input?: { endpointId?: string; scopes?: PairingScope[]; ttlMs?: number }): Promise<IssuedGrant>;
}

export interface BuildOptions {
  config: GatewayConfig;
  now?: () => number;
  /** 允许 server/测试换掉 Agent（默认常驻 codex app-server）。 */
  agent?: AgentAdapter;
  /** E2E 用的传输接缝：默认走全局 fetch。 */
  fetchImpl?: FetchLike;
}

export function buildWakuGateway(options: BuildOptions): WakuGateway {
  const { config } = options;
  const now = options.now ?? Date.now;

  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const store = openGatewayStore({
    dbPath: config.dbPath,
    masterKeyPath: config.masterKeyPath,
  });

  // endpoint 目录来自配置，落库后由 registry 实时读 status（运维可以直接改库 disable）。
  const endpoint: AgentEndpoint = {
    id: config.endpoint.id,
    runnerProfileId: config.endpoint.runnerProfileId,
    workspacePolicyId: config.endpoint.workspacePolicyId,
    trustTier: config.endpoint.trustTier,
    status: 'active',
  };
  const existing = store.getEndpoint(endpoint.id);
  if (existing === null) {
    store.transaction((tx) => tx.upsertEndpoint(endpoint));
  } else {
    // 已存在就只对齐执行策略，不动 status —— 别把运维手动 disable 的 endpoint 一重启就打开。
    store.transaction((tx) => tx.upsertEndpoint({ ...endpoint, status: existing.status }));
  }

  const admins = createAdminRoster(config);

  const credentials = createRuntimeCredentialProvider({
    runtimeJsPath: config.runtimeJsPath,
    mint: createMint(config),
    now,
  });

  const dataClient = createWakuDataClient({
    credentials,
    fetchImpl: options.fetchImpl ?? defaultFetch,
    now,
  });
  const cursorStore = createWakuCursorStore({
    persistence: createCursorPersistence(store, now),
  });

  const conversations = createConversationService({ store, now });

  const agent =
    options.agent ??
    createGatewayAgent({
      backend: process.env['WAKU_GATEWAY_AGENT_BACKEND'] ?? null,
      codexHome: config.codexHome,
      codexEffort: config.codexEffort,
      port: config.healthPort,
    });

  const runner = createLocalRunnerAdapter({
    runnerId: config.endpoint.runnerProfileId,
    nodeId: config.nodeId,
    agent,
    // cwd 的唯一来源：endpoint 策略 → 配置里的映射。客户端在任何字段里都够不到。
    resolveWorkspace: (policyId) => {
      const dir = config.workspaces[policyId];
      if (dir === undefined) {
        throw gatewayError('workspace_not_configured', 'no workspace is mapped for this policy');
      }
      return dir;
    },
    getBinding: (conversationId) => conversations.binding(conversationId),
  });

  const registry = createAgentEndpointRegistry({
    store,
    runners: [{ runnerProfileId: config.endpoint.runnerProfileId, runner }],
    endpointIds: [config.endpoint.id],
  });

  const pairings = createPairingService({
    store,
    now,
    authorizeIssuer: async (context) =>
      context === SERVER_SESSION
        ? { allowed: true, maxTrustTier: config.endpoint.trustTier }
        : { allowed: false, code: 'issuer_not_authorized' },
  });

  // adapter 与 flow 互相需要：flow 要 channel.send，adapter 要 flow 的 opener/routes。
  // 用一个后填的间接层打破这个环，而不是把两者揉成一个模块。
  let adapterRef: WakuMailboxAdapter | null = null;
  const channel = {
    send: async (envelope: Parameters<WakuMailboxAdapter['send']>[0]) => {
      if (adapterRef === null) {
        throw gatewayError('channel_not_ready', 'the mailbox adapter has not been built yet');
      }
      return adapterRef.send(envelope);
    },
  };

  const pairingFlow = createPairingFlow({
    store,
    pairings,
    channel,
    now,
    newMessageId: () => uuidV7(now()),
    ttlMs: config.pairTtlMs,
    onPaired: (notice) => {
      // 配对码是从回环运维口签出来的（= 本机 shell 权限），所以由它带出来的
      // principal 就是这台机器的管理员。写进活文件，之后由文件说了算。
      if (notice.endpointId === config.endpoint.id && config.endpoint.trustTier === 'admin-bypass') {
        admins.add(notice.principalId);
      }
    },
  });

  const delivery = createCoreDelivery({
    store,
    channel,
    now,
    newMessageId: () => uuidV7(now()),
    ttlMs: config.outboxTtlMs,
  });

  const orchestrator = createGatewayOrchestrator({
    store,
    registry,
    conversations,
    delivery,
    now,
    newTurnId: () => uuidV7(now()),
    queueCap: config.queueCap,
  });

  const ingress = createCoreIngress({
    store,
    resolveRoute: (routeId) => {
      const pairing = store.getPairingByRoute(routeId);
      return pairing === null ? null : { pairingId: pairing.id };
    },
    conversations,
    registry,
    dispatcher: orchestrator,
    delivery,
    pairing: pairingFlow,
    now,
    isAdminPrincipal: (principalId) => admins.has(principalId),
  });

  const adapter = createWakuMailboxAdapter({
    instanceId: config.instanceId,
    dataClient,
    cursorStore,
    assemblies: createMemoryAssemblies(now),
    opener: ingress.opener,
    now,
    timer: {
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
    },
    // 活跃 pairing 的长期路由 + 还在等握手的 pr_ 路由，一次查询全带上。
    routes: () => [
      ...store.listActivePairings().map((pairing) => pairing.routeId),
      ...pairingFlow.routes(),
    ],
    polling: config.polling,
  });
  adapterRef = adapter;

  // 在线心跳：adapter 早就有 heartbeat() 原语，缺的是打拍子的人。
  // 只给已配对的长期路由写——握手中的 pr_ 路由客户端根本不读 status，写了纯浪费。
  const heartbeat = createStatusHeartbeat({
    routes: () =>
      store
        .listActivePairings()
        .map((pairing) => ({ routeId: pairing.routeId, keyVersion: pairing.keyVersion })),
    beat: (input) => adapter.heartbeat(input),
    snapshot: async () => {
      const core = await orchestrator.health();
      const mailbox = await adapter.health();
      const credential = credentials.health();
      // 只交原始事实，`degraded/busy/online` 怎么推是 Core 的事（本文件只接线）。
      return {
        queuesRunning: core.queues.running,
        queuesQueued: core.queues.queued,
        credentialOk: credential.ok,
        mailboxDegraded: mailbox.state === 'degraded',
        endpointsAllOk: core.endpoints.every((endpoint) => endpoint.ok),
      };
    },
    now,
    timer: {
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
    },
    log: (line) => console.log(`[waku-gateway ${new Date(now()).toISOString()}] ${line}`),
  });

  let flushTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  return {
    config,
    store,
    registry,
    pairings,
    pairingFlow,
    delivery,
    orchestrator,
    ingress,
    adapter,
    credentials,

    async start(): Promise<void> {
      // 崩溃遗留的 running turn 先结账，再开始收新消息 ——
      // 顺序反了会让恢复动作把刚起跑的 turn 也标成 interrupted。
      orchestrator.recover();
      await delivery.flushPending();
      await adapter.start((envelope) => ingress.sink(envelope));

      flushTimer = setInterval(() => {
        void delivery.flushPending().catch(() => undefined);
      }, config.flushIntervalMs);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();

      heartbeat.start();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (flushTimer !== null) clearInterval(flushTimer);
      // 墓碑必须写在 adapter.stop() 之前：adapter 一停，heartbeat() 就只回
      // waku_mailbox_stopped，这一拍 offline 会变成空转，徽章得干等 180s 陈旧化。
      await heartbeat.stop({ tombstone: true });
      await adapter.stop();
      await orchestrator.drain();
      // 排水之后再冲一次：最后那条 final 也要落到 Waku 上。
      await delivery.flushPending().catch(() => undefined);
      await agent.shutdown().catch(() => undefined);
      store.close();
    },

    async health(): Promise<WakuGatewayHealth> {
      const core = await orchestrator.health();
      const mailbox = await adapter.health();
      const credential = credentials.health();
      return {
        ...core,
        mailbox: {
          ok: mailbox.ok,
          state: mailbox.state,
          cursorLagMs: mailbox.cursorLagMs,
          pendingOutbox: mailbox.pendingOutbox,
        },
        credential: {
          ok: credential.ok,
          state: credential.state,
          expiresInSec: credential.expiresInSec,
        },
        outbox: { pending: delivery.pendingCount() },
        heartbeat: heartbeat.health(),
      };
    },

    async issueGrant(input = {}): Promise<IssuedGrant> {
      const endpointId = input.endpointId ?? config.endpoint.id;
      const scopes = input.scopes ?? config.defaultScopes;
      const expiresAt = now() + (input.ttlMs ?? config.grantTtlMs);

      const grant = await pairings.createGrant({ endpointId, scopes, expiresAt }, SERVER_SESSION);
      const registered = await pairingFlow.registerGrant({
        grantId: grant.grantId,
        token: grant.token,
        expiresAt,
      });
      return {
        grantId: grant.grantId,
        token: grant.token,
        pairRouteId: registered.pairRouteId,
        endpointId,
        scopes: [...scopes],
        expiresAt,
      };
    },
  };
}
