import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { userIdToSessionUUID } from '../utils.js';
import type { SessionBinding, SessionStore } from './contracts.js';

/**
 * 会话身份 = 账号 + 用户。
 * v5 把会话钉在端口上(codex-threads-<port>.json),换端口 = 全员失忆;
 * v6 钉在 accountId 上,端口只是健康检查的门牌号。
 */
export function deriveConversationId(accountId: string, userId: string): string {
  return createHash('sha256').update(`${accountId}\n${userId}`).digest('hex').slice(0, 32);
}

export interface FileSessionStoreOptions {
  accountId: string;
  /** 数据目录,缺省 ~/.cc2wechat(测试注入临时目录,绝不碰真实 HOME) */
  dir?: string;
  /** legacy codex-threads-<port>.json 的端口,缺省读 env CC2WECHAT_PORT */
  legacyPort?: string;
}

interface StoreFile {
  version: number;
  accountId: string;
  bindings: Record<string, SessionBinding>;
}

const FILE_VERSION = 1;

function emptyFile(accountId: string): StoreFile {
  return { version: FILE_VERSION, accountId, bindings: {} };
}

export class FileSessionStore implements SessionStore {
  private readonly accountId: string;
  private readonly dir: string;
  private readonly legacyPort: string;

  private data: StoreFile;
  /** conversationId → userId,只为 legacy 迁移服务(legacy 的键是 userId 派生的) */
  private userIds = new Map<string, string>();
  /** 迁移只试一次:没命中就别每条消息都去读一遍盘 */
  private migrationTried = new Set<string>();

  constructor(opts: FileSessionStoreOptions) {
    this.accountId = opts.accountId;
    this.dir = opts.dir ?? path.join(os.homedir(), '.cc2wechat');
    this.legacyPort = opts.legacyPort ?? process.env.CC2WECHAT_PORT ?? '18081';
    this.data = this.load();
  }

  /**
   * 告诉 store 这个会话背后是哪个微信用户。
   * 契约里的 get() 只有 conversationId,而 legacy 表的键是 userIdToSessionUUID(userId) ——
   * 没有这层登记就没法迁移,而"生产用户升级后正在聊的会话不能丢"是硬要求。
   */
  noteUser(conversationId: string, userId: string): void {
    this.userIds.set(conversationId, userId);
  }

  get(conversationId: string): SessionBinding | null {
    const hit = this.data.bindings[conversationId];
    if (hit) return hit;
    return this.tryMigrateLegacy(conversationId);
  }

  saveProviderSession(conversationId: string, agentType: string, providerSessionId: string): void {
    const now = Date.now();
    const prev = this.data.bindings[conversationId];
    if (prev && prev.agentType === agentType && prev.providerSessionId === providerSessionId) {
      // id 没变就只刷时间,别为每轮对话写一次盘
      prev.updatedAt = now;
      this.persist();
      return;
    }
    this.data.bindings[conversationId] = {
      conversationId,
      agentType,
      providerSessionId,
      generation: prev?.generation ?? 1,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.persist();
  }

  touch(conversationId: string): void {
    const b = this.data.bindings[conversationId];
    if (!b) return;
    b.updatedAt = Date.now();
    this.persist();
  }

  bump(conversationId: string): void {
    const now = Date.now();
    const prev = this.data.bindings[conversationId];
    this.data.bindings[conversationId] = {
      conversationId,
      agentType: prev?.agentType ?? '',
      providerSessionId: '',
      generation: (prev?.generation ?? 0) + 1,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.persist();
  }

  drop(conversationId: string): void {
    delete this.data.bindings[conversationId];
    // 关了就是关了:别让 legacy 迁移在下一条消息把它复活
    this.migrationTried.add(conversationId);
    this.persist();
  }

  expireIdle(maxIdleMs: number): string[] {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) return [];
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, b] of Object.entries(this.data.bindings)) {
      if (now - b.updatedAt > maxIdleMs) expired.push(id);
    }
    if (expired.length === 0) return [];
    for (const id of expired) delete this.data.bindings[id];
    this.persist();
    return expired;
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  private filePath(): string {
    return path.join(this.dir, `sessions-${this.accountId}.json`);
  }

  private legacyFilePath(): string {
    return path.join(this.dir, `codex-threads-${this.legacyPort}.json`);
  }

  private load(): StoreFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8')) as Partial<StoreFile>;
      const bindings = parsed?.bindings;
      if (!bindings || typeof bindings !== 'object') return emptyFile(this.accountId);
      return { version: FILE_VERSION, accountId: this.accountId, bindings: bindings as Record<string, SessionBinding> };
    } catch {
      // 文件不存在 / JSON 坏了 —— 一律当空表。会话丢了能重开,进程起不来才是事故。
      return emptyFile(this.accountId);
    }
  }

  /** 临时文件 + rename:断电/并发写不会留下半截 JSON */
  private persist(): void {
    const target = this.filePath();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  private tryMigrateLegacy(conversationId: string): SessionBinding | null {
    if (this.migrationTried.has(conversationId)) return null;
    this.migrationTried.add(conversationId);

    const userId = this.userIds.get(conversationId);
    if (!userId) return null;

    let legacy: Record<string, string>;
    try {
      legacy = JSON.parse(fs.readFileSync(this.legacyFilePath(), 'utf-8')) as Record<string, string>;
    } catch {
      return null;
    }
    if (!legacy || typeof legacy !== 'object') return null;

    const threadId = legacy[userIdToSessionUUID(userId)];
    if (typeof threadId !== 'string' || !threadId) return null;

    this.saveProviderSession(conversationId, 'codex', threadId);
    return this.data.bindings[conversationId] ?? null;
  }
}
