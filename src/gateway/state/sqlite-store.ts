/**
 * Gateway 的持久化层（架构 §9）。
 *
 * 为什么是 SQLite 而不是继续扩 v6 的原子 JSON：多人配对 + 一次性 token +
 * inbox/outbox + 游标提交需要**真事务**。"标记 grant 已消费"和"创建 principal/device/pairing"
 * 之间崩一次就会留半条身份，JSON 文件给不了这个保证。
 *
 * 几条被测试钉死的语义：
 * - 重复 receipt 返回 `duplicate`，但**游标照常推进** —— 否则重放会把游标钉死在同一页。
 * - outbox 重试复用原 messageId，不产生第二条；重开只恢复 pending。
 * - running 的 turn 重开后标 `interrupted`，且 `recoverInterruptedTurns` 幂等 ——
 *   不自动重跑"可能已经改过代码"的任务。
 * - chunk assembly 到期即 fail-closed：块齐了也不产出，并原子清理。
 * - 用 `node:sqlite`（Node 内置）而不是 better-sqlite3：不给这个仓加原生依赖。
 */
import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AgentEndpoint, EndpointStatus } from '../contracts/runner.js';
import type { GrantStatus, PairingScope, PairingStatus } from '../contracts/pairing.js';
import { ENDPOINT_STATUSES } from '../contracts/runner.js';
import { gatewayError } from '../contracts/validation.js';
import { openCredentialStore, type CredentialStore } from './credential-store.js';

// ---------------------------------------------------------------------------
// 行契约
// ---------------------------------------------------------------------------

export interface CursorRow {
  lastCreatedAt: number;
  lastMessageId: string;
}

export type ReceiptStatus = 'received' | 'running' | 'completed' | 'rejected';

export interface ReceiptRow {
  pairingId: string;
  messageId: string;
  status: ReceiptStatus;
  receivedAt: number;
}

export interface OutboxRow {
  messageId: string;
  pairingId: string;
  routeId: string;
  kind: string;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  createdAt: number;
  externalDeliveryId?: string;
}

export interface ConversationRow {
  id: string;
  pairingId: string;
  principalId: string;
  generation: number;
}

export interface ProviderBindingRow {
  conversationId: string;
  agentType: string;
  providerSessionId: string;
  generation: number;
}

export interface RunnerAssignmentRow {
  endpointId: string;
  nodeId: string;
  leaseEpoch: number;
  leaseUntil: number;
}

export interface TurnRow {
  turnId: string;
  conversationId: string;
  pairingId: string;
  messageId: string;
  status: 'running' | 'completed' | 'interrupted';
  startedAt: number;
}

export interface StoredChunkRow {
  messageId: string;
  pairingId: string;
  routeId: string;
  chunkIndex: number;
  chunkCount: number;
  nonce: string;
  ciphertext: string;
  createdAt: number;
  expiresAt: number;
}

export interface GrantRow {
  id: string;
  tokenHash: string;
  endpointId: string;
  scopes: PairingScope[];
  status: GrantStatus;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}

export interface PairingRow {
  id: string;
  principalId: string;
  deviceId: string;
  endpointId: string;
  routeId: string;
  scopes: PairingScope[];
  secretCiphertext: string;
  keyVersion: number;
  status: PairingStatus;
  createdAt: number;
}

export interface NewPrincipal {
  id: string;
  displayName?: string;
  status: 'active' | 'disabled';
  createdAt: number;
}

export interface NewDevice {
  id: string;
  principalId: string;
  label?: string;
  createdAt: number;
}

export interface NewPairing {
  id: string;
  principalId: string;
  deviceId: string;
  endpointId: string;
  routeId: string;
  scopes: PairingScope[];
  channelSecret: Uint8Array;
  keyVersion: number;
  createdAt: number;
}

export interface NewGrant {
  id: string;
  tokenHash: string;
  endpointId: string;
  scopes: PairingScope[];
  createdAt: number;
  expiresAt: number;
}

export type NewOutbox = Omit<OutboxRow, 'status' | 'attempts' | 'externalDeliveryId'>;

/** 事务内可用的写操作全集。所有多步写入必须走这里，不许拆成多次 `transaction()`。 */
export interface GatewayTransaction {
  upsertEndpoint(endpoint: AgentEndpoint): void;
  getEndpoint(id: string): AgentEndpoint | null;

  insertPrincipal(principal: NewPrincipal): void;
  insertDevice(device: NewDevice): void;
  insertPairing(pairing: NewPairing): void;
  getPairing(id: string): PairingRow | null;
  revokePairing(id: string, revokedAt: number): void;

  insertGrant(grant: NewGrant): void;
  getGrant(id: string): GrantRow | null;
  findGrantByTokenHash(tokenHash: string): GrantRow | null;
  markGrantConsumed(id: string, consumedAt: number): void;

  insertInboxReceipt(receipt: ReceiptRow): 'inserted' | 'duplicate';
  /** 收下之后才判出来的结论（授权失败 / 队列满）回写同一行，重放只会撞 duplicate。 */
  updateReceiptStatus(pairingId: string, messageId: string, status: ReceiptStatus): void;
  commitCursor(collection: string, cursor: CursorRow): void;

  insertOutbox(record: NewOutbox): 'inserted' | 'duplicate';
  markOutboxSent(messageId: string, externalDeliveryId: string, sentAt: number): void;
  /** 玩家自己说收到了：不再重投，也别伪造一个 externalDeliveryId。 */
  markOutboxAcknowledged(messageId: string, at: number): void;
  /** 平台永久拒绝：重试多少次都没用，别占着 pending 让每轮 flush 白跑。 */
  markOutboxFailed(messageId: string, failedAt: number): void;

  saveConversation(conversation: ConversationRow): void;
  bumpGeneration(conversationId: string): number;
  saveProviderBinding(binding: ProviderBindingRow): void;
  saveRunnerAssignment(assignment: RunnerAssignmentRow): void;

  startTurn(turn: Omit<TurnRow, 'status'>): void;
  /**
   * turn 的收尾写口。只从 running 迁出，所以"崩溃恢复已经标了 interrupted"之后
   * 迟到的收尾不会把它改回 completed。
   */
  finishTurn(turnId: string, status: 'completed' | 'interrupted', endedAt: number): void;
  saveChunk(chunk: StoredChunkRow): 'inserted' | 'duplicate' | 'conflict';
}

export interface GatewayStore {
  readonly schemaVersion: number;
  transaction<T>(fn: (tx: GatewayTransaction) => T): T;
  getEndpoint(id: string): AgentEndpoint | null;
  getGrant(id: string): GrantRow | null;
  getPairing(id: string): PairingRow | null;
  /** 入站只知道 routeId（公开面），身份要从这里翻回来。 */
  getPairingByRoute(routeId: string): PairingRow | null;
  /** 轮询要一次带上全部活跃路由（平台读额度按请求算，不是按路由算）。 */
  listActivePairings(): PairingRow[];
  getPairingSecret(id: string): Uint8Array | null;
  getReceipt(pairingId: string, messageId: string): ReceiptRow | null;
  getCursor(collection: string): CursorRow | null;
  getOutbox(messageId: string): OutboxRow | null;
  listPendingOutbox(): OutboxRow[];
  getConversation(id: string): ConversationRow | null;
  getProviderBinding(conversationId: string): ProviderBindingRow | null;
  getRunnerAssignment(endpointId: string): RunnerAssignmentRow | null;
  getTurn(turnId: string): TurnRow | null;
  recoverInterruptedTurns(now: number): TurnRow[];
  takeAssembly(messageId: string, now: number): StoredChunkRow[] | null;
  countChunks(messageId: string): number;
  countPrincipals(): number;
  countDevices(): number;
  countPairings(): number;
  close(): void;
}

export interface OpenGatewayStoreOptions {
  dbPath: string;
  masterKeyPath: string;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * `PRAGMA user_version` 是唯一的版本键。每条 migration 只前进一级，
 * 库里已经是 v1（手工建的 endpoints 表）时只补跑 v2，不重建、不清数据。
 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY,
        runner_profile_id TEXT NOT NULL,
        workspace_policy_id TEXT NOT NULL,
        trust_tier TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pairing_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        endpoint_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        route_id TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        key_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS inbox_receipts (
        pairing_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (pairing_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_cursors (
        collection TEXT PRIMARY KEY,
        last_created_at INTEGER NOT NULL,
        last_message_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox_records (
        message_id TEXT PRIMARY KEY,
        pairing_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        external_delivery_id TEXT
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        pairing_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        generation INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runner_session_bindings (
        conversation_id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runner_assignments (
        endpoint_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        lease_until INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        pairing_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS chunk_assemblies (
        message_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        pairing_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_records (status, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_status ON turns (status);
      CREATE INDEX IF NOT EXISTS idx_pairings_route ON pairings (route_id);
    `,
  },
];

export const GATEWAY_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const DB_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// 行值取用（node:sqlite 会把整数按大小给成 number 或 bigint）
// ---------------------------------------------------------------------------

type SqlValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SqlValue>;

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw gatewayError('store_corrupt', `column ${column} is not text`, column);
  }
  return value;
}

function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw gatewayError('store_corrupt', `column ${column} is not numeric`, column);
}

function optText(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function optNum(row: Row, column: string): number | undefined {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function parseScopes(raw: string): PairingScope[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw gatewayError('store_corrupt', 'scopes column is not a string array', 'scopes');
  }
  return parsed as PairingScope[];
}

function toEndpoint(row: Row): AgentEndpoint {
  const status = text(row, 'status');
  if (!(ENDPOINT_STATUSES as readonly string[]).includes(status)) {
    throw gatewayError('store_corrupt', 'endpoint status is outside the vocabulary', 'status');
  }
  return {
    id: text(row, 'id'),
    runnerProfileId: text(row, 'runner_profile_id'),
    workspacePolicyId: text(row, 'workspace_policy_id'),
    trustTier: text(row, 'trust_tier') as AgentEndpoint['trustTier'],
    status: status as EndpointStatus,
  };
}

function toGrant(row: Row): GrantRow {
  const consumedAt = optNum(row, 'consumed_at');
  const grant: GrantRow = {
    id: text(row, 'id'),
    tokenHash: text(row, 'token_hash'),
    endpointId: text(row, 'endpoint_id'),
    scopes: parseScopes(text(row, 'scopes')),
    status: text(row, 'status') as GrantStatus,
    createdAt: num(row, 'created_at'),
    expiresAt: num(row, 'expires_at'),
  };
  if (consumedAt !== undefined) grant.consumedAt = consumedAt;
  return grant;
}

function toPairing(row: Row): PairingRow {
  return {
    id: text(row, 'id'),
    principalId: text(row, 'principal_id'),
    deviceId: text(row, 'device_id'),
    endpointId: text(row, 'endpoint_id'),
    routeId: text(row, 'route_id'),
    scopes: parseScopes(text(row, 'scopes')),
    secretCiphertext: text(row, 'secret_ciphertext'),
    keyVersion: num(row, 'key_version'),
    status: text(row, 'status') as PairingStatus,
    createdAt: num(row, 'created_at'),
  };
}

function toOutbox(row: Row): OutboxRow {
  const externalDeliveryId = optText(row, 'external_delivery_id');
  const record: OutboxRow = {
    messageId: text(row, 'message_id'),
    pairingId: text(row, 'pairing_id'),
    routeId: text(row, 'route_id'),
    kind: text(row, 'kind'),
    payload: text(row, 'payload'),
    status: text(row, 'status') as OutboxRow['status'],
    attempts: num(row, 'attempts'),
    createdAt: num(row, 'created_at'),
  };
  if (externalDeliveryId !== undefined) record.externalDeliveryId = externalDeliveryId;
  return record;
}

function toTurn(row: Row): TurnRow {
  return {
    turnId: text(row, 'turn_id'),
    conversationId: text(row, 'conversation_id'),
    pairingId: text(row, 'pairing_id'),
    messageId: text(row, 'message_id'),
    status: text(row, 'status') as TurnRow['status'],
    startedAt: num(row, 'started_at'),
  };
}

function toChunk(row: Row): StoredChunkRow {
  return {
    messageId: text(row, 'message_id'),
    pairingId: text(row, 'pairing_id'),
    routeId: text(row, 'route_id'),
    chunkIndex: num(row, 'chunk_index'),
    chunkCount: num(row, 'chunk_count'),
    nonce: text(row, 'nonce'),
    ciphertext: text(row, 'ciphertext'),
    createdAt: num(row, 'created_at'),
    expiresAt: num(row, 'expires_at'),
  };
}

// ---------------------------------------------------------------------------

export function openGatewayStore(options: OpenGatewayStoreOptions): GatewayStore {
  // 凭据先开：master key 权限不合格时要在碰数据库之前就 fail-closed，
  // 免得留下一个半初始化的库文件和一个没关的句柄。
  const credentials: CredentialStore = openCredentialStore({
    masterKeyPath: options.masterKeyPath,
  });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.dbPath);
  } catch (error) {
    credentials.close();
    throw error;
  }

  try {
    migrate(db);
    if (fs.existsSync(options.dbPath)) {
      fs.chmodSync(options.dbPath, DB_FILE_MODE);
    }
  } catch (error) {
    db.close();
    credentials.close();
    throw error;
  }

  const statements = new Map<string, StatementSync>();
  function prep(sql: string): StatementSync {
    const cached = statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = db.prepare(sql);
    statements.set(sql, statement);
    return statement;
  }

  function one(sql: string, ...params: SqlValue[]): Row | null {
    const row = prep(sql).get(...params);
    return row === undefined ? null : (row as Row);
  }

  function many(sql: string, ...params: SqlValue[]): Row[] {
    return prep(sql).all(...params) as Row[];
  }

  function count(sql: string, ...params: SqlValue[]): number {
    const row = one(sql, ...params);
    return row === null ? 0 : num(row, 'n');
  }

  let depth = 0;
  function runInTransaction<T>(fn: () => T): T {
    const savepoint = `gw_sp_${depth}`;
    if (depth === 0) db.exec('BEGIN IMMEDIATE');
    else db.exec(`SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = fn();
      depth -= 1;
      if (depth === 0) db.exec('COMMIT');
      else db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      depth -= 1;
      try {
        if (depth === 0) db.exec('ROLLBACK');
        else db.exec(`ROLLBACK TO ${savepoint}`);
      } catch {
        /* SQLite 可能已经自行回滚；真正的失败原因是下面 rethrow 的那个 */
      }
      throw error;
    }
  }

  // ---- 读 ----------------------------------------------------------------

  function getEndpoint(id: string): AgentEndpoint | null {
    const row = one('SELECT * FROM endpoints WHERE id = ?', id);
    return row === null ? null : toEndpoint(row);
  }

  function getGrant(id: string): GrantRow | null {
    const row = one('SELECT * FROM pairing_grants WHERE id = ?', id);
    return row === null ? null : toGrant(row);
  }

  function findGrantByTokenHash(tokenHash: string): GrantRow | null {
    const row = one('SELECT * FROM pairing_grants WHERE token_hash = ?', tokenHash);
    return row === null ? null : toGrant(row);
  }

  function getPairing(id: string): PairingRow | null {
    const row = one('SELECT * FROM pairings WHERE id = ?', id);
    return row === null ? null : toPairing(row);
  }

  // ---- 写（事务内） -------------------------------------------------------

  const tx: GatewayTransaction = {
    upsertEndpoint(endpoint: AgentEndpoint): void {
      prep(
        `INSERT INTO endpoints (id, runner_profile_id, workspace_policy_id, trust_tier, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           runner_profile_id = excluded.runner_profile_id,
           workspace_policy_id = excluded.workspace_policy_id,
           trust_tier = excluded.trust_tier,
           status = excluded.status`,
      ).run(
        endpoint.id,
        endpoint.runnerProfileId,
        endpoint.workspacePolicyId,
        endpoint.trustTier,
        endpoint.status,
      );
    },

    getEndpoint,
    getPairing,
    getGrant,
    findGrantByTokenHash,

    insertPrincipal(principal: NewPrincipal): void {
      prep(
        'INSERT INTO principals (id, display_name, status, created_at) VALUES (?, ?, ?, ?)',
      ).run(principal.id, principal.displayName ?? null, principal.status, principal.createdAt);
    },

    insertDevice(device: NewDevice): void {
      prep('INSERT INTO devices (id, principal_id, label, created_at) VALUES (?, ?, ?, ?)').run(
        device.id,
        device.principalId,
        device.label ?? null,
        device.createdAt,
      );
    },

    insertPairing(pairing: NewPairing): void {
      // 长期密钥只以 master-key wrapping 后的形态落库。
      const secretCiphertext = credentials.wrap(pairing.channelSecret);
      prep(
        `INSERT INTO pairings
           (id, principal_id, device_id, endpoint_id, route_id, scopes,
            secret_ciphertext, key_version, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        pairing.id,
        pairing.principalId,
        pairing.deviceId,
        pairing.endpointId,
        pairing.routeId,
        JSON.stringify(pairing.scopes),
        secretCiphertext,
        pairing.keyVersion,
        pairing.createdAt,
      );
    },

    revokePairing(id: string, revokedAt: number): void {
      prep("UPDATE pairings SET status = 'revoked', revoked_at = ? WHERE id = ?").run(revokedAt, id);
    },

    insertGrant(grant: NewGrant): void {
      prep(
        `INSERT INTO pairing_grants
           (id, token_hash, endpoint_id, scopes, status, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      ).run(
        grant.id,
        grant.tokenHash,
        grant.endpointId,
        JSON.stringify(grant.scopes),
        grant.createdAt,
        grant.expiresAt,
      );
    },

    markGrantConsumed(id: string, consumedAt: number): void {
      prep(
        "UPDATE pairing_grants SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending'",
      ).run(consumedAt, id);
    },

    insertInboxReceipt(receipt: ReceiptRow): 'inserted' | 'duplicate' {
      const result = prep(
        `INSERT INTO inbox_receipts (pairing_id, message_id, status, received_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pairing_id, message_id) DO NOTHING`,
      ).run(receipt.pairingId, receipt.messageId, receipt.status, receipt.receivedAt);
      return result.changes > 0 ? 'inserted' : 'duplicate';
    },

    updateReceiptStatus(pairingId: string, messageId: string, status: ReceiptStatus): void {
      prep(
        'UPDATE inbox_receipts SET status = ? WHERE pairing_id = ? AND message_id = ?',
      ).run(status, pairingId, messageId);
    },

    commitCursor(collection: string, cursor: CursorRow): void {
      prep(
        `INSERT INTO mailbox_cursors (collection, last_created_at, last_message_id)
         VALUES (?, ?, ?)
         ON CONFLICT(collection) DO UPDATE SET
           last_created_at = excluded.last_created_at,
           last_message_id = excluded.last_message_id`,
      ).run(collection, cursor.lastCreatedAt, cursor.lastMessageId);
    },

    insertOutbox(record: NewOutbox): 'inserted' | 'duplicate' {
      const result = prep(
        `INSERT INTO outbox_records
           (message_id, pairing_id, route_id, kind, payload, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      ).run(
        record.messageId,
        record.pairingId,
        record.routeId,
        record.kind,
        record.payload,
        record.createdAt,
      );
      return result.changes > 0 ? 'inserted' : 'duplicate';
    },

    markOutboxSent(messageId: string, externalDeliveryId: string, sentAt: number): void {
      prep(
        `UPDATE outbox_records
            SET status = 'sent', external_delivery_id = ?, sent_at = ?, attempts = attempts + 1
          WHERE message_id = ?`,
      ).run(externalDeliveryId, sentAt, messageId);
    },

    markOutboxAcknowledged(messageId: string, at: number): void {
      prep("UPDATE outbox_records SET status = 'sent', sent_at = ? WHERE message_id = ?").run(
        at,
        messageId,
      );
    },

    markOutboxFailed(messageId: string, failedAt: number): void {
      prep(
        "UPDATE outbox_records SET status = 'failed', sent_at = ?, attempts = attempts + 1 WHERE message_id = ?",
      ).run(failedAt, messageId);
    },

    saveConversation(conversation: ConversationRow): void {
      prep(
        `INSERT INTO conversations (id, pairing_id, principal_id, generation)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           pairing_id = excluded.pairing_id,
           principal_id = excluded.principal_id,
           generation = excluded.generation`,
      ).run(
        conversation.id,
        conversation.pairingId,
        conversation.principalId,
        conversation.generation,
      );
    },

    bumpGeneration(conversationId: string): number {
      prep('UPDATE conversations SET generation = generation + 1 WHERE id = ?').run(conversationId);
      const row = one('SELECT generation FROM conversations WHERE id = ?', conversationId);
      if (row === null) {
        throw gatewayError('conversation_not_found', 'conversation does not exist', 'conversationId');
      }
      return num(row, 'generation');
    },

    saveProviderBinding(binding: ProviderBindingRow): void {
      prep(
        `INSERT INTO runner_session_bindings
           (conversation_id, agent_type, provider_session_id, generation)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           agent_type = excluded.agent_type,
           provider_session_id = excluded.provider_session_id,
           generation = excluded.generation`,
      ).run(
        binding.conversationId,
        binding.agentType,
        binding.providerSessionId,
        binding.generation,
      );
    },

    saveRunnerAssignment(assignment: RunnerAssignmentRow): void {
      prep(
        `INSERT INTO runner_assignments (endpoint_id, node_id, lease_epoch, lease_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint_id) DO UPDATE SET
           node_id = excluded.node_id,
           lease_epoch = excluded.lease_epoch,
           lease_until = excluded.lease_until`,
      ).run(assignment.endpointId, assignment.nodeId, assignment.leaseEpoch, assignment.leaseUntil);
    },

    startTurn(turn: Omit<TurnRow, 'status'>): void {
      prep(
        `INSERT INTO turns
           (turn_id, conversation_id, pairing_id, message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      ).run(turn.turnId, turn.conversationId, turn.pairingId, turn.messageId, turn.startedAt);
    },

    finishTurn(turnId: string, status: 'completed' | 'interrupted', endedAt: number): void {
      prep(
        "UPDATE turns SET status = ?, ended_at = ? WHERE turn_id = ? AND status = 'running'",
      ).run(status, endedAt, turnId);
    },

    saveChunk(chunk: StoredChunkRow): 'inserted' | 'duplicate' | 'conflict' {
      // 同一条消息的 chunkCount 必须全局一致 —— 否则伪造者可以用一个新 count 把 assembly 撑大。
      const head = one('SELECT chunk_count FROM chunk_assemblies WHERE message_id = ? LIMIT 1', chunk.messageId);
      if (head !== null && num(head, 'chunk_count') !== chunk.chunkCount) {
        return 'conflict';
      }

      const existing = one(
        'SELECT * FROM chunk_assemblies WHERE message_id = ? AND chunk_index = ?',
        chunk.messageId,
        chunk.chunkIndex,
      );
      if (existing !== null) {
        const previous = toChunk(existing);
        return sameStoredChunk(previous, chunk) ? 'duplicate' : 'conflict';
      }

      prep(
        `INSERT INTO chunk_assemblies
           (message_id, chunk_index, pairing_id, route_id, chunk_count,
            nonce, ciphertext, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        chunk.messageId,
        chunk.chunkIndex,
        chunk.pairingId,
        chunk.routeId,
        chunk.chunkCount,
        chunk.nonce,
        chunk.ciphertext,
        chunk.createdAt,
        chunk.expiresAt,
      );
      return 'inserted';
    },
  };

  let closed = false;

  const store: GatewayStore = {
    schemaVersion: GATEWAY_SCHEMA_VERSION,

    transaction<T>(fn: (transaction: GatewayTransaction) => T): T {
      return runInTransaction(() => fn(tx));
    },

    getEndpoint,
    getGrant,
    getPairing,

    getPairingByRoute(routeId: string): PairingRow | null {
      const row = one('SELECT * FROM pairings WHERE route_id = ?', routeId);
      return row === null ? null : toPairing(row);
    },

    listActivePairings(): PairingRow[] {
      return many("SELECT * FROM pairings WHERE status = 'active' ORDER BY created_at").map(
        toPairing,
      );
    },

    getPairingSecret(id: string): Uint8Array | null {
      const row = one('SELECT secret_ciphertext FROM pairings WHERE id = ?', id);
      if (row === null) return null;
      return credentials.unwrap(text(row, 'secret_ciphertext'));
    },

    getReceipt(pairingId: string, messageId: string): ReceiptRow | null {
      const row = one(
        'SELECT * FROM inbox_receipts WHERE pairing_id = ? AND message_id = ?',
        pairingId,
        messageId,
      );
      if (row === null) return null;
      return {
        pairingId: text(row, 'pairing_id'),
        messageId: text(row, 'message_id'),
        status: text(row, 'status') as ReceiptStatus,
        receivedAt: num(row, 'received_at'),
      };
    },

    getCursor(collection: string): CursorRow | null {
      const row = one('SELECT * FROM mailbox_cursors WHERE collection = ?', collection);
      if (row === null) return null;
      return {
        lastCreatedAt: num(row, 'last_created_at'),
        lastMessageId: text(row, 'last_message_id'),
      };
    },

    getOutbox(messageId: string): OutboxRow | null {
      const row = one('SELECT * FROM outbox_records WHERE message_id = ?', messageId);
      return row === null ? null : toOutbox(row);
    },

    listPendingOutbox(): OutboxRow[] {
      return many(
        "SELECT * FROM outbox_records WHERE status = 'pending' ORDER BY created_at, message_id",
      ).map(toOutbox);
    },

    getConversation(id: string): ConversationRow | null {
      const row = one('SELECT * FROM conversations WHERE id = ?', id);
      if (row === null) return null;
      return {
        id: text(row, 'id'),
        pairingId: text(row, 'pairing_id'),
        principalId: text(row, 'principal_id'),
        generation: num(row, 'generation'),
      };
    },

    getProviderBinding(conversationId: string): ProviderBindingRow | null {
      const row = one(
        'SELECT * FROM runner_session_bindings WHERE conversation_id = ?',
        conversationId,
      );
      if (row === null) return null;
      return {
        conversationId: text(row, 'conversation_id'),
        agentType: text(row, 'agent_type'),
        providerSessionId: text(row, 'provider_session_id'),
        generation: num(row, 'generation'),
      };
    },

    getRunnerAssignment(endpointId: string): RunnerAssignmentRow | null {
      const row = one('SELECT * FROM runner_assignments WHERE endpoint_id = ?', endpointId);
      if (row === null) return null;
      return {
        endpointId: text(row, 'endpoint_id'),
        nodeId: text(row, 'node_id'),
        leaseEpoch: num(row, 'lease_epoch'),
        leaseUntil: num(row, 'lease_until'),
      };
    },

    getTurn(turnId: string): TurnRow | null {
      const row = one('SELECT * FROM turns WHERE turn_id = ?', turnId);
      return row === null ? null : toTurn(row);
    },

    /**
     * 崩溃恢复：把仍是 running 的 turn 一次性标成 interrupted 并返回。
     * 幂等 —— 第二次调用返回空数组，避免"重启就重跑一遍可能已改过代码的任务"。
     */
    recoverInterruptedTurns(now: number): TurnRow[] {
      return runInTransaction(() => {
        const rows = many("SELECT * FROM turns WHERE status = 'running'").map(toTurn);
        if (rows.length === 0) return [];
        prep("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(now);
        return rows.map((turn) => ({ ...turn, status: 'interrupted' as const }));
      });
    },

    /**
     * 取走一条完整且未过期的 assembly。到期点即 fail-closed：块齐了也不产出，
     * 并把这条消息的持久残留一起清掉（同事务，不留半条）。
     */
    takeAssembly(messageId: string, now: number): StoredChunkRow[] | null {
      return runInTransaction(() => {
        const rows = many(
          'SELECT * FROM chunk_assemblies WHERE message_id = ? ORDER BY chunk_index',
          messageId,
        ).map(toChunk);
        if (rows.length === 0) return null;

        const expired = rows.some((chunk) => now >= chunk.expiresAt);
        if (expired) {
          prep('DELETE FROM chunk_assemblies WHERE message_id = ?').run(messageId);
          return null;
        }

        if (rows.length !== rows[0].chunkCount) return null;

        prep('DELETE FROM chunk_assemblies WHERE message_id = ?').run(messageId);
        return rows;
      });
    },

    countChunks(messageId: string): number {
      return count('SELECT COUNT(*) AS n FROM chunk_assemblies WHERE message_id = ?', messageId);
    },

    countPrincipals(): number {
      return count('SELECT COUNT(*) AS n FROM principals');
    },

    countDevices(): number {
      return count('SELECT COUNT(*) AS n FROM devices');
    },

    countPairings(): number {
      return count('SELECT COUNT(*) AS n FROM pairings');
    },

    close(): void {
      if (closed) return;
      closed = true;
      statements.clear();
      try {
        db.close();
      } finally {
        credentials.close();
      }
    },
  };

  return store;
}

function sameStoredChunk(a: StoredChunkRow, b: StoredChunkRow): boolean {
  return (
    a.messageId === b.messageId &&
    a.pairingId === b.pairingId &&
    a.routeId === b.routeId &&
    a.chunkIndex === b.chunkIndex &&
    a.chunkCount === b.chunkCount &&
    a.nonce === b.nonce &&
    a.ciphertext === b.ciphertext &&
    a.createdAt === b.createdAt &&
    a.expiresAt === b.expiresAt
  );
}

function migrate(db: DatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get();
  let current = versionRow === undefined ? 0 : num(versionRow as Row, 'user_version');

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败不该盖住真正的 migration 错误 */
      }
      throw error;
    }
    current = migration.version;
  }
}
