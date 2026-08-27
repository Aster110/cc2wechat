import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 收件箱台账。
 *
 * 为什么不复用 SessionStore:那张表存的是「会话 → 后端会话 id」,由 Core 写;
 * 这张表存的是「人工播种出来的收件箱 → 微信会话」的**认领关系**,由 agent 写,
 * 而且比一次绑定活得久(收件箱终身,绑定可以 /exit 解开再给别人)。
 *
 * 关键约束(预研 10 §3):零人工确认地**创建** app 会话五路全封死,
 * 所以收件箱只能"人工播种一次",daemon 永远只能认领已有的,不能偷偷造一个。
 * claim() 返回 null 就是"没货了,去 seed",不是 bug。
 */

export interface InboxRecord {
  /** 人可读的收件箱名(= 目录名后缀,也进注入信封) */
  name: string;
  /** 收件箱独占的 cwd:路由键 + 权限沙箱边界 + transcript slug 隔离 */
  cwd: string;
  /** 认领它的微信会话;null = 空闲 */
  conversationId: string | null;
  /** app 侧稳定句柄 local_<uuid>;null = 待解析 */
  localId: string | null;
  /** /new 一次 +1 */
  generation: number;
  /** 下一条注入要带"新话题"标记 */
  resetPending: boolean;
  seededAt: number;
  updatedAt: number;
}

export interface InboxRegistryOptions {
  accountId: string;
  /** 缺省 ~/.cc2wechat(测试注入临时目录,绝不碰真实 HOME) */
  dir?: string;
  now?: () => number;
}

interface StoreFile {
  version: number;
  accountId: string;
  inboxes: InboxRecord[];
}

const FILE_VERSION = 1;

function samePath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return a === b;
  }
}

export class InboxRegistry {
  private readonly accountId: string;
  private readonly dir: string;
  private readonly now: () => number;
  private data: StoreFile;

  constructor(opts: InboxRegistryOptions) {
    this.accountId = opts.accountId;
    this.dir = opts.dir ?? path.join(os.homedir(), '.cc2wechat');
    this.now = opts.now ?? (() => Date.now());
    this.data = this.load();
  }

  filePath(): string {
    return path.join(this.dir, `claude-app-inboxes-${this.accountId}.json`);
  }

  list(): InboxRecord[] {
    return this.data.inboxes;
  }

  /** 播种登记(幂等:同名只更 cwd,不重开一条) */
  seed(name: string, cwd: string): InboxRecord {
    const hit = this.byName(name);
    if (hit) {
      hit.cwd = cwd;
      hit.updatedAt = this.now();
      this.persist();
      return hit;
    }
    const rec: InboxRecord = {
      name,
      cwd,
      conversationId: null,
      localId: null,
      generation: 1,
      resetPending: false,
      seededAt: this.now(),
      updatedAt: this.now(),
    };
    this.data.inboxes.push(rec);
    this.persist();
    return rec;
  }

  byName(name: string): InboxRecord | null {
    return this.data.inboxes.find((i) => i.name === name) ?? null;
  }

  byCwd(cwd: string): InboxRecord | null {
    return this.data.inboxes.find((i) => samePath(i.cwd, cwd)) ?? null;
  }

  forConversation(conversationId: string): InboxRecord | null {
    return this.data.inboxes.find((i) => i.conversationId === conversationId) ?? null;
  }

  /** 已绑就返回原来那个;否则按播种顺序领一个空的;没货返回 null */
  claim(conversationId: string): InboxRecord | null {
    const mine = this.forConversation(conversationId);
    if (mine) return mine;
    const free = this.data.inboxes.find((i) => i.conversationId == null);
    if (!free) return null;
    free.conversationId = conversationId;
    free.updatedAt = this.now();
    this.persist();
    return free;
  }

  release(conversationId: string): void {
    const hit = this.forConversation(conversationId);
    if (!hit) return;
    hit.conversationId = null;
    hit.localId = null;
    hit.resetPending = false;
    hit.updatedAt = this.now();
    this.persist();
  }

  needResolve(name: string): boolean {
    const hit = this.byName(name);
    return hit ? hit.localId == null : false;
  }

  bindLocalId(name: string, localId: string): void {
    const hit = this.byName(name);
    if (!hit || hit.localId === localId) {
      if (hit) {
        hit.updatedAt = this.now();
        this.persist();
      }
      return;
    }
    hit.localId = localId;
    hit.updatedAt = this.now();
    this.persist();
  }

  clearLocalId(name: string): void {
    const hit = this.byName(name);
    if (!hit || hit.localId == null) return;
    hit.localId = null;
    hit.updatedAt = this.now();
    this.persist();
  }

  /** /new:收件箱不换,只挂一个"下一条带重置标记"的旗子 */
  bumpGeneration(conversationId: string): void {
    const hit = this.forConversation(conversationId);
    if (!hit) return;
    hit.generation += 1;
    hit.resetPending = true;
    hit.updatedAt = this.now();
    this.persist();
  }

  takeReset(name: string): boolean {
    const hit = this.byName(name);
    if (!hit || !hit.resetPending) return false;
    hit.resetPending = false;
    hit.updatedAt = this.now();
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------------

  private load(): StoreFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath(), 'utf-8')) as Partial<StoreFile>;
      if (!Array.isArray(parsed?.inboxes)) return { version: FILE_VERSION, accountId: this.accountId, inboxes: [] };
      return {
        version: FILE_VERSION,
        accountId: this.accountId,
        inboxes: (parsed.inboxes as InboxRecord[]).filter((i) => i && typeof i.name === 'string'),
      };
    } catch {
      // 文件不存在 / JSON 坏了一律当空表:绑定丢了能重绑,进程起不来才是事故
      return { version: FILE_VERSION, accountId: this.accountId, inboxes: [] };
    }
  }

  /** 临时文件 + rename,与 v6 session-store 同口径 */
  private persist(): void {
    const target = this.filePath();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, target);
  }
}
