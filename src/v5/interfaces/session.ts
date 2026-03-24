export interface SessionEntry {
  userId: string;
  sessionId: string;
  platformData: Record<string, unknown>;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionOpts {
  sessionId: string;
  cwd: string;
  platformData?: Record<string, unknown>;
}

export interface SessionManager {
  findSession(userId: string): Promise<SessionEntry | null>;
  createSession(userId: string, opts: SessionOpts): Promise<SessionEntry>;
  destroySession(userId: string): Promise<void>;
  cleanupStale(maxAgeMs: number): Promise<void>;
}
