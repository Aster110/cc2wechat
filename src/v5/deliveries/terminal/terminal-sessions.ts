import fs from 'node:fs';
import type { SessionManager, SessionEntry, SessionOpts } from '../../interfaces/index.js';

export class TerminalSessions implements SessionManager {
  private store = new Map<string, SessionEntry>();
  readonly filePath: string;

  constructor(port?: number) {
    this.filePath = port != null ? `/tmp/cc2wechat-tabs-${port}.json` : '/tmp/cc2wechat-tabs.json';
    this.loadFromDisk();
  }

  async findSession(userId: string): Promise<SessionEntry | null> {
    return this.store.get(userId) ?? null;
  }

  async createSession(userId: string, opts: SessionOpts): Promise<SessionEntry> {
    const entry: SessionEntry = {
      userId,
      sessionId: opts.sessionId,
      platformData: opts.platformData ?? {},
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.store.set(userId, entry);
    this.saveToDisk();
    return entry;
  }

  async destroySession(userId: string): Promise<void> {
    this.store.delete(userId);
    this.saveToDisk();
  }

  async cleanupStale(maxAgeMs: number): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [userId, entry] of this.store) {
      if (now - entry.lastActiveAt > maxAgeMs) {
        this.store.delete(userId);
        changed = true;
      }
    }
    if (changed) this.saveToDisk();
  }

  async touch(userId: string): Promise<void> {
    const entry = this.store.get(userId);
    if (entry) {
      entry.lastActiveAt = Date.now();
      this.saveToDisk();
    }
  }

  private saveToDisk(): void {
    const obj: Record<string, SessionEntry> = {};
    for (const [key, entry] of this.store) obj[key] = entry;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch { /* best-effort */ }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const [key, val] of Object.entries(data)) {
          const entry = val as SessionEntry;
          if (entry?.userId && entry?.platformData) {
            this.store.set(key, entry);
          }
        }
      }
    } catch { /* corrupt file — start fresh */ }
  }
}
