/**
 * Waku 轮询游标（架构 §9）。
 *
 * 两条规矩：
 * - 「游标只能在对应行已持久为 receipt 后推进」→ `advance()` 是投递成功后才调的，
 *   而且**先落盘再更新内存**：持久化失败时内存不许领先磁盘，否则重启后凭空跳过消息。
 * - 「游标丢失或失效时从 `lastCreatedAt - overlapWindow` 回扫，靠
 *   `(collection,messageId,chunkIndex)` 去重」→ 回扫窗是常态开着的，不是灾备开关：
 *   服务端 createdAt 同毫秒批量 + 时钟偏移下，严格从 lastCreatedAt 起扫必漏。
 *
 * **持久游标不是平台的 keyset cursor**。平台 cursor 把 filter/sort 编进了 spec hash，
 * 路由集合一变（新配对上线）旧 cursor 立刻 `datastore_invalid_cursor`，而且不带业务时间语义。
 * 所以落库的是 `(lastCreatedAt, lastMessageId)`，平台 nextCursor 只在单轮翻页里用。
 */

export interface MailboxCursor {
  lastCreatedAt: number;
  lastMessageId: string;
}

export interface SeenKey {
  collection: string;
  messageId: string;
  chunkIndex: number;
}

export interface ObservedRow {
  createdAt: number;
  messageId: string;
  chunkIndex: number;
}

/**
 * 注入的持久化接缝：M1 `GatewayStore` 的一个窄子集，
 * 窄到可以在同一个事务里与 receipt 一起提交（游标不许领先 receipt）。
 */
export interface CursorPersistence {
  getCursor(collection: string): MailboxCursor | null;
  commitCursor(collection: string, cursor: MailboxCursor): void;
  hasSeen(key: SeenKey): boolean;
  markSeen(key: SeenKey & { createdAt: number }): void;
}

export interface WakuCursorStore {
  /** 本轮扫描的 createdAt 下界（含回扫窗）；从未见过任何行时返回 null = 全量首扫。 */
  scanFloor(collection: string): number | null;
  isDuplicate(key: SeenKey): boolean;
  /** 只允许在对应 receipt 已持久之后调用；单调不回退。 */
  advance(collection: string, row: ObservedRow): void;
  /** 游标失效/丢失（如 datastore_invalid_cursor）：额外回退一个 overlap，累计封顶。 */
  reset(collection: string, reason: string): void;
  current(collection: string): MailboxCursor | null;
  lagMs(collection: string, now: number): number;
}

export interface WakuCursorStoreOptions {
  persistence: CursorPersistence;
  overlapWindowMs?: number;
  maxRewindMs?: number;
}

/** 回扫窗 = M1 的时钟偏移容忍窗（架构 §6 MAX_CLOCK_SKEW_MS），两边同一个物理理由。 */
export const WAKU_CURSOR_OVERLAP_WINDOW_MS = 30_000;

/** 连续失效时累计回退的上限——再怎么失效也不许一路回扫到创世。 */
export const WAKU_CURSOR_MAX_REWIND_MS = 10 * 60 * 1000;

export function createWakuCursorStore(options: WakuCursorStoreOptions): WakuCursorStore {
  const persistence = options.persistence;
  const overlapWindowMs = positive(options.overlapWindowMs, WAKU_CURSOR_OVERLAP_WINDOW_MS);
  const maxRewindMs = Math.max(
    overlapWindowMs,
    positive(options.maxRewindMs, WAKU_CURSOR_MAX_REWIND_MS),
  );

  /** 内存镜像：只在落盘成功后写，永远不领先磁盘。 */
  const cursors = new Map<string, MailboxCursor>();
  /** reset 累计出来的额外回退量（不含常态 overlap），一次成功 advance 即归零。 */
  const extraRewind = new Map<string, number>();

  function load(collection: string): MailboxCursor | null {
    const cached = cursors.get(collection);
    if (cached) return cached;
    const stored = persistence.getCursor(collection);
    if (!stored) return null;
    const restored: MailboxCursor = {
      lastCreatedAt: stored.lastCreatedAt,
      lastMessageId: stored.lastMessageId,
    };
    cursors.set(collection, restored);
    return restored;
  }

  function rewindOf(collection: string): number {
    return Math.min(overlapWindowMs + (extraRewind.get(collection) ?? 0), maxRewindMs);
  }

  return {
    scanFloor(collection: string): number | null {
      const cursor = load(collection);
      if (!cursor) return null; // 没有游标就别造假下界，老实全量首扫。
      return cursor.lastCreatedAt - rewindOf(collection);
    },

    isDuplicate(key: SeenKey): boolean {
      return persistence.hasSeen(key);
    },

    advance(collection: string, row: ObservedRow): void {
      persistence.markSeen({
        collection,
        messageId: row.messageId,
        chunkIndex: row.chunkIndex,
        createdAt: row.createdAt,
      });

      const cursor = load(collection);
      if (isAhead(row, cursor)) {
        const next: MailboxCursor = { lastCreatedAt: row.createdAt, lastMessageId: row.messageId };
        // 先落盘：commit 抛错时内存保持旧值，重启后不会凭空跳过这一段。
        persistence.commitCursor(collection, next);
        cursors.set(collection, next);
      }
      extraRewind.delete(collection);
    },

    reset(collection: string, reason: string): void {
      void reason; // 调用方负责记日志；这里只负责把回扫窗放大一格。
      const current = extraRewind.get(collection) ?? 0;
      extraRewind.set(collection, Math.min(current + overlapWindowMs, maxRewindMs));
    },

    current(collection: string): MailboxCursor | null {
      const cursor = load(collection);
      return cursor ? { ...cursor } : null;
    },

    lagMs(collection: string, now: number): number {
      const cursor = load(collection);
      // 还没有游标时不报假 lag——health 用 state 区分"没跑起来"和"落后了"。
      return cursor ? now - cursor.lastCreatedAt : 0;
    },
  };
}

/** 对齐平台 keyset 的 `(sortValue, id)` tie-break：同毫秒时按 messageId 前进。 */
function isAhead(row: ObservedRow, cursor: MailboxCursor | null): boolean {
  if (!cursor) return true;
  if (row.createdAt > cursor.lastCreatedAt) return true;
  return row.createdAt === cursor.lastCreatedAt && row.messageId > cursor.lastMessageId;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
