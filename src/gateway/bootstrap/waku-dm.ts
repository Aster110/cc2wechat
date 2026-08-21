/**
 * waku-dm 通道的组装层（契约 §3.1 配置 / §3.6 Core 复用）。
 *
 * 与 V1 `bootstrap/waku.ts` 同构：**只接线，不做业务判断**。接线顺序：
 *
 *   BridgeTokenProvider ──→ WakuChatClient ─┐
 *                                            ├→ WakuDmAdapter（SSE 入站 / REST 出站 / 心跳）
 *   GatewayStore → ConversationService ─────┤   （sink 由 Core ingress 提供）
 *               → Registry ←─ LocalRunner ←─ v6 Agent（codex app-server / claude-sdk）
 *               → CoreDelivery → Orchestrator → Ingress(AclIdentityResolver)
 *
 * 三件 V1 没有、这里要做的：
 * 1. **凭证二选一**：`BRIDGE_CREDENTIAL_FILE`（马甲，推荐）或 `AUTH_PATH`（真账号 auth.json，备选）。
 * 2. **ACL 来自环境变量**：`OWNER_USER_IDS` → admin endpoint；其它 sender 默认 deny。
 *    给了 `DEFAULT_TIER` 就必须给 `GUEST_WORKSPACE_DIR`——陌生人绝不落进 owner 的工作区。
 * 3. **四件套日志接线**：`[turn] …` 由 orchestrator 的 onTurnFinished 钩子打出。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AgentAdapter } from '../../v6/contracts.js';
import type { AgentEndpoint, TrustTier } from '../contracts/runner.js';
import { isTrustTier } from '../contracts/pairing.js';
import { createStdLogger, type GatewayLogger } from '../log.js';
import { openGatewayStore, type GatewayStore } from '../state/sqlite-store.js';
import { createAgentEndpointRegistry, type AgentEndpointRegistry } from '../runners/registry.js';
import { createLocalRunnerAdapter } from '../runners/local-runner.js';
import { createConversationService } from '../core/conversation-service.js';
import { createCoreDelivery, type CoreDelivery } from '../core/delivery.js';
import { createGatewayOrchestrator, type GatewayHealth, type GatewayOrchestrator } from '../core/orchestrator.js';
import { createCoreIngress, type CoreIngress, type PairingSeam } from '../core/ingress.js';
import { createAclIdentityResolver } from '../core/identity.js';
import {
  createBridgeCredentialProvider,
  createSessionCredentialProvider,
  readAuthApiBase,
  type BridgeTokenProvider,
} from '../channels/waku-dm/credential-provider.js';
import { createWakuChatClient } from '../channels/waku-dm/chat-client.js';
import {
  createWakuDmAdapter,
  WAKU_DM_COLD_START_GRACE_MS,
  WAKU_DM_HEARTBEAT_INTERVAL_MS,
  WAKU_DM_SLOW_ACK_MS,
  type WakuDmAdapter,
  type WakuDmHealth,
} from '../channels/waku-dm/adapter.js';
import {
  createMediaStore,
  WAKU_DM_DOWNLOAD_TIMEOUT_MS,
  WAKU_DM_IMAGE_MAX_BYTES,
  WAKU_DM_MEDIA_MAX_BYTES,
  WAKU_DM_MEDIA_SWEEP_INTERVAL_MS,
  WAKU_DM_MEDIA_TTL_MS,
  type MediaStore,
} from '../channels/waku-dm/media-store.js';
import { createMediaProbe } from '../channels/waku-dm/media-probe.js';
import { ASSET_CACHE_TTL_MS, DEFAULT_MAX_UPLOAD_BYTES } from '../channels/waku-dm/attachment-sender.js';
import { mergeAttachments, parseAttachmentMarkers, type OutboundAttachment } from '../core/attachments.js';
import { DEFAULT_DM_STATE_DIR_NAME, HEALTH_PORT_FILE } from '../dm-paths.js';
import { SSE_IDLE_TIMEOUT_MS } from '../channels/waku-dm/sse-client.js';
import {
  DEFAULT_DM_HEALTH_PORT,
  DEFAULT_FLUSH_INTERVAL_MS,
  ENV_PREFIX,
  configError,
  createGatewayAgent,
  parseWorkspaces,
  readEnv,
  readInt,
  readList,
  uuidV7,
  type EndpointConfig,
} from './waku.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export type DmCredentialConfig =
  | { mode: 'bridge'; file: string }
  | { mode: 'session'; authPath: string };

export interface DmGatewayConfig {
  stateDir: string;
  dbPath: string;
  masterKeyPath: string;
  healthHost: string;
  healthPort: number;
  instanceId: string;
  nodeId: string;
  apiBase: string;
  credential: DmCredentialConfig;
  ownerUserIds: string[];
  /** `deny`（缺省）或一个 trust tier：非 owner 的落点。 */
  defaultTier: 'deny' | TrustTier;
  endpoint: EndpointConfig;
  guestEndpoint: EndpointConfig | null;
  /** workspacePolicyId → cwd。客户端够不到这张表，这是执行位置的唯一来源。 */
  workspaces: Record<string, string>;
  queueCap: number;
  outboxTtlMs: number;
  flushIntervalMs: number;
  heartbeatIntervalMs: number;
  sseIdleTimeoutMs: number;
  /** 0 = 关闭慢回执。来自 `CC2WECHAT_ACK_MS`（沿用 v6）。 */
  slowAckMs: number;
  coldStartGraceMs: number;
  /** 入站媒体落盘目录（缺省 `<stateDir>/media`）与三道闸。 */
  mediaDir: string;
  mediaImageMaxBytes: number;
  mediaMaxBytes: number;
  mediaTimeoutMs: number;
  mediaTtlMs: number;
  mediaSweepIntervalMs: number;
  /**
   * 发视频前转到 ≤720p H.264 + AAC + faststart 并截断到 `maxVideoSeconds`。
   * **默认开**（`WAKU_DM_VIDEO_TRANSCODE=0` 才关）：源已合规时会跳过转码，不白掉画质。
   */
  videoTranscode: boolean;
  maxVideoSeconds: number;
  /** 出站单文件上限（上传要整个读进内存）。 */
  maxUploadBytes: number;
  codexHome: string | null;
  codexEffort: string | null;
  agentBackend: string | null;
}

/** 唯一定义在 `../dm-paths.js`（那个文件没有任何 import，CLI 拿常量不必拖进整条依赖链）。 */
export { DEFAULT_DM_STATE_DIR_NAME, HEALTH_PORT_FILE };
export const DEFAULT_GUEST_ENDPOINT_ID = 'guest';
export const DEFAULT_GUEST_WORKSPACE_POLICY_ID = 'guest-home';

/** `CC2WECHAT_ACK_MS=0` 是合法值（关闭），所以不能用 readInt（它拒 0）。 */
function readNonNegativeMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw configError(`${name} must be a non-negative number of milliseconds`);
  }
  return Math.floor(parsed);
}

export function loadDmGatewayConfig(env: NodeJS.ProcessEnv = process.env): DmGatewayConfig {
  const credentialFile = readEnv(env, 'BRIDGE_CREDENTIAL_FILE');
  const authPath = readEnv(env, 'AUTH_PATH');
  if (credentialFile !== null && authPath !== null) {
    throw configError(
      `set exactly one of ${ENV_PREFIX}BRIDGE_CREDENTIAL_FILE (bridge mode) or ${ENV_PREFIX}AUTH_PATH (session mode), not both（二选一）`,
    );
  }
  if (credentialFile === null && authPath === null) {
    throw configError(
      `waku-dm needs credentials: set ${ENV_PREFIX}BRIDGE_CREDENTIAL_FILE to the 0600 file written by ` +
        "'waku agent-friend credential issue --write <path>' (recommended), or " +
        `${ENV_PREFIX}AUTH_PATH to a logged-in waku auth.json (session mode).`,
    );
  }
  const credential: DmCredentialConfig =
    credentialFile !== null ? { mode: 'bridge', file: credentialFile } : { mode: 'session', authPath: authPath as string };

  let apiBase = readEnv(env, 'API_BASE');
  if (apiBase === null && credential.mode === 'session') apiBase = readAuthApiBase(credential.authPath);
  if (apiBase === null) {
    throw configError(
      `${ENV_PREFIX}API_BASE is required (e.g. https://waku-core-api-yyvdcgnhha-uc.a.run.app/api/v1)` +
        (credential.mode === 'session' ? ' — the auth.json had no usable api_base either' : ''),
    );
  }
  apiBase = apiBase.replace(/\/+$/, '');

  const defaultTierRaw = readEnv(env, 'DEFAULT_TIER') ?? 'deny';
  let defaultTier: 'deny' | TrustTier;
  if (defaultTierRaw === 'deny') {
    defaultTier = 'deny';
  } else if (isTrustTier(defaultTierRaw) && defaultTierRaw !== 'admin-bypass') {
    defaultTier = defaultTierRaw;
  } else {
    throw configError(`${ENV_PREFIX}DEFAULT_TIER must be 'deny' or a non-admin trust tier (chat-only / sandbox-workspace / repo-pr): ${defaultTierRaw}`);
  }

  const ownerUserIds = readList(env, 'OWNER_USER_IDS');
  if (ownerUserIds.length === 0 && defaultTier === 'deny') {
    throw configError(
      `${ENV_PREFIX}OWNER_USER_IDS is required (comma-separated Waku user ids allowed to talk to the agent); ` +
        'with the default deny tier nobody could reach it otherwise',
    );
  }

  const stateDir = readEnv(env, 'STATE_DIR') ?? path.join(os.homedir(), DEFAULT_DM_STATE_DIR_NAME);
  const nodeId = readEnv(env, 'NODE_ID') ?? os.hostname();
  const endpointId = readEnv(env, 'ENDPOINT_ID') ?? 'aster-admin';
  const workspacePolicyId = readEnv(env, 'WORKSPACE_POLICY_ID') ?? 'admin-home';
  const trustTierRaw = readEnv(env, 'TRUST_TIER') ?? 'admin-bypass';
  if (!isTrustTier(trustTierRaw)) {
    throw configError(`${ENV_PREFIX}TRUST_TIER is not a known trust tier: ${trustTierRaw}`);
  }
  const runnerProfileId = readEnv(env, 'RUNNER_PROFILE_ID') ?? `local-${nodeId}`;
  const workspaces = parseWorkspaces(env, workspacePolicyId);

  let guestEndpoint: EndpointConfig | null = null;
  if (defaultTier !== 'deny') {
    const guestDir = readEnv(env, 'GUEST_WORKSPACE_DIR');
    if (guestDir === null) {
      throw configError(
        `${ENV_PREFIX}GUEST_WORKSPACE_DIR is required when ${ENV_PREFIX}DEFAULT_TIER is not 'deny': ` +
          'strangers must never run inside the owner workspace',
      );
    }
    if (!path.isAbsolute(guestDir)) throw configError(`${ENV_PREFIX}GUEST_WORKSPACE_DIR must be an absolute path`);
    workspaces[DEFAULT_GUEST_WORKSPACE_POLICY_ID] = guestDir;
    guestEndpoint = {
      id: readEnv(env, 'GUEST_ENDPOINT_ID') ?? DEFAULT_GUEST_ENDPOINT_ID,
      workspacePolicyId: DEFAULT_GUEST_WORKSPACE_POLICY_ID,
      trustTier: defaultTier,
      runnerProfileId,
    };
  }

  return {
    stateDir,
    dbPath: readEnv(env, 'DB_PATH') ?? path.join(stateDir, 'gateway.db'),
    masterKeyPath: readEnv(env, 'MASTER_KEY_PATH') ?? path.join(stateDir, 'master.key'),
    // 运维面只听回环。
    healthHost: '127.0.0.1',
    healthPort: readInt(env, 'HEALTH_PORT', DEFAULT_DM_HEALTH_PORT),
    instanceId: readEnv(env, 'INSTANCE_ID') ?? `waku-dm-${nodeId}`,
    nodeId,
    apiBase,
    credential,
    ownerUserIds,
    defaultTier,
    endpoint: { id: endpointId, workspacePolicyId, trustTier: trustTierRaw, runnerProfileId },
    guestEndpoint,
    workspaces,
    queueCap: readInt(env, 'QUEUE_CAP', 5),
    outboxTtlMs: readInt(env, 'OUTBOX_TTL_MS', 5 * 60 * 1000),
    flushIntervalMs: readInt(env, 'FLUSH_INTERVAL_MS', DEFAULT_FLUSH_INTERVAL_MS),
    heartbeatIntervalMs: readInt(env, 'HEARTBEAT_INTERVAL_MS', WAKU_DM_HEARTBEAT_INTERVAL_MS),
    sseIdleTimeoutMs: readInt(env, 'SSE_IDLE_TIMEOUT_MS', SSE_IDLE_TIMEOUT_MS),
    slowAckMs: readNonNegativeMs(env, 'CC2WECHAT_ACK_MS', WAKU_DM_SLOW_ACK_MS),
    coldStartGraceMs: readInt(env, 'COLD_START_GRACE_MS', WAKU_DM_COLD_START_GRACE_MS),
    mediaDir: readEnv(env, 'MEDIA_DIR') ?? path.join(stateDir, 'media'),
    mediaImageMaxBytes: readInt(env, 'MEDIA_IMAGE_MAX_BYTES', WAKU_DM_IMAGE_MAX_BYTES),
    mediaMaxBytes: readInt(env, 'MEDIA_MAX_BYTES', WAKU_DM_MEDIA_MAX_BYTES),
    mediaTimeoutMs: readInt(env, 'MEDIA_TIMEOUT_MS', WAKU_DM_DOWNLOAD_TIMEOUT_MS),
    mediaTtlMs: readInt(env, 'MEDIA_TTL_MS', WAKU_DM_MEDIA_TTL_MS),
    mediaSweepIntervalMs: readInt(env, 'MEDIA_SWEEP_INTERVAL_MS', WAKU_DM_MEDIA_SWEEP_INTERVAL_MS),
    // **默认开**：客户端只保证能播 ≤60s/≤720p/h264+aac 的 mp4，而平台后端不转码。
    // 显式 `0`（或 `false` / `off`）才关——不认识的值一律按开处理，别让一个笔误静默关掉它。
    videoTranscode: !['0', 'false', 'off', 'no'].includes((env['WAKU_DM_VIDEO_TRANSCODE'] ?? '').trim().toLowerCase()),
    maxVideoSeconds: readInt(env, 'MAX_VIDEO_SECONDS', 60),
    maxUploadBytes: readInt(env, 'MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES),
    codexHome: readEnv(env, 'CODEX_HOME'),
    codexEffort: readEnv(env, 'CODEX_EFFORT'),
    agentBackend: readEnv(env, 'AGENT_BACKEND'),
  };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface WakuDmGatewayHealth extends GatewayHealth {
  channel: WakuDmHealth & { type: 'waku-dm' };
  credential: { mode: 'bridge' | 'session'; ok: boolean; state: string; expiresInSec: number };
  outbox: { pending: number };
}

/** 回环回复口的入参（`waku-dm-reply` CLI → `POST /admin/reply`）。 */
export interface DmReplyInput {
  /** 不给就用"当前唯一正在跑的 turn 的会话"；0 条或多于 1 条 → 报错要求显式指定。 */
  conversationId?: string;
  text?: string;
  attachments?: OutboundAttachment[];
}

export interface DmReplyResult {
  conversationId: string;
  messageId: string;
  status: string;
  attachments: number;
}

export interface WakuDmGateway {
  readonly config: DmGatewayConfig;
  readonly store: GatewayStore;
  readonly registry: AgentEndpointRegistry;
  readonly delivery: CoreDelivery;
  readonly orchestrator: GatewayOrchestrator;
  readonly ingress: CoreIngress;
  readonly adapter: WakuDmAdapter;
  readonly credentials: BridgeTokenProvider;
  readonly media: MediaStore;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<WakuDmGatewayHealth>;
  /** 中途发图/发卡：与 Agent 的 final 走同一条 outbox → adapter.send 的路。 */
  reply(input: DmReplyInput): Promise<DmReplyResult>;
}

export interface BuildDmOptions {
  config: DmGatewayConfig;
  now?: () => number;
  /** 允许 server/测试换掉 Agent（默认按 AGENT_BACKEND 造常驻 codex app-server）。 */
  agent?: AgentAdapter;
  /** 测试用的传输接缝：默认走全局 fetch。 */
  fetchImpl?: typeof fetch;
  log?: GatewayLogger;
}

/** waku-dm 没有握手路由：PairingFlow 接缝全部空实现。 */
const noPairing: PairingSeam = {
  routes: () => [],
  openPairChunks: async () => {
    throw configError('waku-dm has no pairing routes');
  },
  sealPairChunks: async () => {
    throw configError('waku-dm has no pairing routes');
  },
  handle: async () => ({ status: 'rejected', code: 'unknown_route' }),
};

export function createBridgeTokenProvider(config: DmGatewayConfig, fetchImpl?: typeof fetch, now?: () => number): BridgeTokenProvider {
  const shared = {
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(now === undefined ? {} : { now }),
  };
  return config.credential.mode === 'bridge'
    ? createBridgeCredentialProvider({ credentialFile: config.credential.file, apiBase: config.apiBase, ...shared })
    : createSessionCredentialProvider({ authPath: config.credential.authPath, apiBase: config.apiBase, ...shared });
}

export function buildWakuDmGateway(options: BuildDmOptions): WakuDmGateway {
  const { config } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? createStdLogger('waku-dm');

  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const store = openGatewayStore({ dbPath: config.dbPath, masterKeyPath: config.masterKeyPath });

  // endpoint 目录来自配置，落库后由 registry 实时读 status（运维可以直接改库 disable）。
  const endpointIds: string[] = [];
  for (const entry of [config.endpoint, config.guestEndpoint]) {
    if (entry === null) continue;
    const endpoint: AgentEndpoint = {
      id: entry.id,
      runnerProfileId: entry.runnerProfileId,
      workspacePolicyId: entry.workspacePolicyId,
      trustTier: entry.trustTier,
      status: 'active',
    };
    const existing = store.getEndpoint(endpoint.id);
    // 已存在就只对齐执行策略，不动 status —— 别把运维手动 disable 的 endpoint 一重启就打开。
    store.transaction((tx) => tx.upsertEndpoint(existing === null ? endpoint : { ...endpoint, status: existing.status }));
    endpointIds.push(endpoint.id);
  }

  const owners = new Set(config.ownerUserIds);
  const isOwner = (userId: string): boolean => owners.has(userId);

  const credentials = createBridgeTokenProvider(config, options.fetchImpl, now);
  const chat = createWakuChatClient({
    apiBase: config.apiBase,
    tokens: credentials,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const conversations = createConversationService({ store, now });

  const agent =
    options.agent ??
    createGatewayAgent({
      backend: config.agentBackend,
      codexHome: config.codexHome,
      codexEffort: config.codexEffort,
      port: config.healthPort,
      // pid 文件放自己的 state dir：不往 ~/.cc2wechat 里写，别和微信 daemon 的孤儿清理互相误伤。
      pidFilePath: path.join(config.stateDir, 'appserver.pid'),
    });

  const runner = createLocalRunnerAdapter({
    runnerId: config.endpoint.runnerProfileId,
    nodeId: config.nodeId,
    agent,
    // cwd 的唯一来源：endpoint 策略 → 配置里的映射。客户端在任何字段里都够不到。
    resolveWorkspace: (policyId) => {
      const dir = config.workspaces[policyId];
      if (dir === undefined) throw configError(`no workspace is mapped for policy ${policyId}`);
      return dir;
    },
    getBinding: (conversationId) => conversations.binding(conversationId),
  });

  const registry = createAgentEndpointRegistry({
    store,
    runners: [{ runnerProfileId: config.endpoint.runnerProfileId, runner }],
    endpointIds,
  });

  // delivery 与 adapter 互相需要：delivery 要 channel.send，adapter 的构造要 chat/tokens（不依赖 delivery），
  // 但 adapter 在 delivery 之后才建——用一个后填的间接层打破这个环。
  let adapterRef: WakuDmAdapter | null = null;
  const channel = {
    send: async (envelope: Parameters<WakuDmAdapter['send']>[0]) => {
      if (adapterRef === null) throw configError('the waku-dm adapter has not been built yet');
      return adapterRef.send(envelope);
    },
  };

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
    onTurnFinished: (timing) => {
      log.info(
        `[turn] conv=${timing.conversationId.slice(0, 9)} agent=${timing.agentType} queue=${timing.queueMs}ms ` +
          `first=${timing.firstEventMs}ms total=${timing.totalMs}ms outcome=${timing.outcome}`,
      );
    },
  });

  const ingress = createCoreIngress({
    store,
    resolveRoute: () => null,
    identity: createAclIdentityResolver({
      isOwner,
      ownerEndpointId: config.endpoint.id,
      guestEndpointId: config.guestEndpoint?.id ?? null,
    }),
    conversations,
    registry,
    dispatcher: orchestrator,
    delivery,
    pairing: noPairing,
    now,
    // admin-bypass endpoint 只认 owner 名单：与 identity 策略是两道独立的闸。
    isAdminPrincipal: isOwner,
  });

  const media = createMediaStore({
    rootDir: config.mediaDir,
    log,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    now,
    limits: {
      imageMaxBytes: config.mediaImageMaxBytes,
      mediaMaxBytes: config.mediaMaxBytes,
      timeoutMs: config.mediaTimeoutMs,
      ttlMs: config.mediaTtlMs,
      sweepIntervalMs: config.mediaSweepIntervalMs,
    },
  });

  const attachments = {
    probe: createMediaProbe({ log }),
    // 上传缓存活在 SQLite：重启也不会让一个已经传上去的视频再传一次。
    cache: {
      get: (key: string) => store.getAssetUpload(key, now(), ASSET_CACHE_TTL_MS),
      set: (key: string, value: { assetId: string; publicUrl: string | null }) => {
        store.transaction((tx) => tx.saveAssetUpload(key, value, now()));
      },
    },
    // 转码 / 封面产物落在**媒体目录之下**（`<state>/media/out`），于是 MediaStore 的 TTL 清理
    // 顺手就把它们收了；放在 `<state>/outbound` 的话没有任何东西会去删，盘只会单调涨。
    tmpDir: path.join(config.mediaDir, 'out'),
    transcodeVideo: config.videoTranscode,
    maxVideoSeconds: config.maxVideoSeconds,
    maxUploadBytes: config.maxUploadBytes,
  };

  const adapter = createWakuDmAdapter({
    instanceId: config.instanceId,
    apiBase: config.apiBase,
    tokens: credentials,
    chat,
    store,
    now,
    log,
    media,
    attachments,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    heartbeat: {
      // 心跳是 bridge 身份专属（session 模式的真账号打 /agent-bridges/me/* 会 403）。
      enabled: config.credential.mode === 'bridge',
      intervalMs: config.heartbeatIntervalMs,
      agentName: agent.name,
      queues: () => orchestratorQueues(),
    },
    sse: { idleTimeoutMs: config.sseIdleTimeoutMs },
    slowAckMs: config.slowAckMs,
    coldStartGraceMs: config.coldStartGraceMs,
  });
  adapterRef = adapter;

  let queuesSnapshot = { running: 0, queued: 0 };
  function orchestratorQueues(): { running: number; queued: number } {
    // health() 是异步的（要问 runner），心跳要同步值：用最近一次快照，每次心跳后刷新。
    void orchestrator.health().then((health) => {
      queuesSnapshot = health.queues;
    }).catch(() => undefined);
    return queuesSnapshot;
  }

  let flushTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  return {
    config,
    store,
    registry,
    delivery,
    orchestrator,
    ingress,
    adapter,
    credentials,
    media,

    async start(): Promise<void> {
      // 崩溃遗留的 running turn 先结账，再开始收新消息。
      orchestrator.recover();
      media.start();
      await delivery.flushPending();
      await adapter.start((envelope) => ingress.sink(envelope));

      flushTimer = setInterval(() => {
        void delivery.flushPending().catch(() => undefined);
      }, config.flushIntervalMs);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (flushTimer !== null) clearInterval(flushTimer);
      // 先停入站（不再收新消息），等在跑的 turn 收尾，把最后的 final 发出去，再真正停掉出站。
      await adapter.stopIntake();
      await orchestrator.drain();
      await delivery.flushPending().catch(() => undefined);
      await adapter.stop();
      media.stop();
      await agent.shutdown().catch(() => undefined);
      store.close();
    },

    async reply(input: DmReplyInput): Promise<DmReplyResult> {
      const parsed = parseAttachmentMarkers(input.text ?? '');
      const merged = mergeAttachments([], [...parsed.attachments, ...(input.attachments ?? [])]);

      // 会话推断：**只认"当前正在跑的 turn"**，不猜文件 mtime。
      // mtime 式的"最近活跃会话"在两个人同时聊天时会把 A 的图发给 B——宁可让调用方多打一个参数。
      let conversationId = input.conversationId ?? null;
      if (conversationId === null) {
        const running = [...new Set(orchestrator.runningTurns().map((turn) => turn.conversationId))];
        if (running.length === 1) conversationId = running[0];
        else if (running.length === 0) {
          throw configError('no turn is running right now: pass --conversation <conversation_id> (it is in the prompt prefix)');
        } else {
          throw configError(`${running.length} turns are running: pass --conversation <conversation_id> to say which one`);
        }
      }

      const conversation = store.getConversation(conversationId);
      const running = orchestrator.runningTurns().find((turn) => turn.conversationId === conversationId) ?? null;
      const pairingId = conversation?.pairingId ?? running?.pairingId ?? null;
      if (pairingId === null) {
        throw configError(`unknown conversation ${conversationId}: nobody has talked in it on this daemon yet`);
      }
      if (parsed.text.length === 0 && merged.length === 0) {
        throw configError('nothing to send: give --text and/or one of --image/--video/--audio/--card');
      }

      const result = await delivery.publish({
        pairingId,
        routeId: conversationId,
        keyVersion: running?.keyVersion ?? 1,
        kind: 'final',
        // 与 Agent 的 final 同一条路：先落 outbox 再发，失败按同一套回执重投。
        messageId: `reply:${randomUUID()}`,
        payload: {
          type: 'final',
          conversationId,
          replyTo: 'loopback',
          text: parsed.text,
          ...(merged.length === 0 ? {} : { attachments: merged }),
        },
      });
      return {
        conversationId,
        messageId: result.messageId,
        status: result.receipt.status,
        attachments: merged.length,
      };
    },

    async health(): Promise<WakuDmGatewayHealth> {
      const core = await orchestrator.health();
      queuesSnapshot = core.queues;
      const channelHealth = await adapter.health();
      const credential = credentials.health();
      return {
        ...core,
        channel: { type: 'waku-dm', ...channelHealth },
        credential: {
          mode: credential.mode,
          ok: credential.ok,
          state: credential.state,
          expiresInSec: credential.expiresInSec,
        },
        outbox: { pending: delivery.pendingCount() },
      };
    },
  };
}
