import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { loadAccounts } from '../store.js';

/**
 * 回复上下文的读写。
 *
 * v5 的问题:每条消息把**微信 token** 明文写进 /tmp/cc2wechat-ctx-*.json ——
 * /tmp 是全机可读的,同机任何进程都能拿着这个 token 冒充你发消息。
 * v6 只往 ~/.cc2wechat/ctx/(0700)写路由信息,token 留在已经 0600 的 accounts-<port>.json 里。
 */

export interface ReplyRoute {
  userId: string;
  contextToken: string;
  port: number;
  accountId: string;
}

export interface ReplyContext {
  token: string;
  baseUrl?: string;
  userId: string;
  contextToken: string;
}

export function ctxDir(home = os.homedir()): string {
  return path.join(home, '.cc2wechat', 'ctx');
}

export function ctxPathForUser(userId: string, home = os.homedir()): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
  return path.join(ctxDir(home), `${hash}.json`);
}

/** 写路由信息(**不含 token / baseUrl**) */
export function writeReplyRoute(route: ReplyRoute, home = os.homedir()): string {
  const dir = ctxDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = ctxPathForUser(route.userId, home);
  fs.writeFileSync(filePath, JSON.stringify(route), { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

function newestJsonIn(dir: string, filter: (f: string) => boolean): string | null {
  try {
    const files = fs
      .readdirSync(dir)
      .filter(filter)
      .map((f) => ({ p: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0]!.p : null;
  } catch {
    return null;
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function fromRoute(route: ReplyRoute): ReplyContext | null {
  if (!route?.userId) return null;
  const accounts = loadAccounts(route.port);
  const account = accounts.find((a) => a.accountId === route.accountId) ?? accounts[accounts.length - 1];
  if (!account?.token) return null;
  return {
    token: account.token,
    baseUrl: account.baseUrl,
    userId: route.userId,
    contextToken: route.contextToken,
  };
}

/**
 * 查找顺序:
 * 1. CC2WECHAT_CONTEXT 指定的文件(显式覆盖,legacy 全量格式)
 * 2. ~/.cc2wechat/ctx/*.json(v6,取最新)—— token 现查 accounts-<port>.json
 * 3. /tmp/cc2wechat-ctx-*.json(v5 遗留,并存期兜底,自带 token)
 * 4. /tmp/cc2wechat-context.json(更早的单文件)
 */
export function resolveReplyContext(opts: { home?: string; env?: NodeJS.ProcessEnv; tmpDir?: string } = {}): ReplyContext | null {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const tmpDir = opts.tmpDir ?? '/tmp';

  const explicit = env.CC2WECHAT_CONTEXT;
  if (explicit && fs.existsSync(explicit)) {
    const direct = readJson<ReplyContext & Partial<ReplyRoute>>(explicit);
    if (direct?.token) return direct;
    if (direct?.userId) {
      const viaRoute = fromRoute(direct as ReplyRoute);
      if (viaRoute) return viaRoute;
    }
  }

  const newest = newestJsonIn(ctxDir(home), (f) => f.endsWith('.json'));
  if (newest) {
    const route = readJson<ReplyRoute>(newest);
    if (route) {
      const ctx = fromRoute(route);
      if (ctx) return ctx;
    }
  }

  const legacy = newestJsonIn(tmpDir, (f) => f.startsWith('cc2wechat-ctx-') && f.endsWith('.json'));
  if (legacy) {
    const ctx = readJson<ReplyContext>(legacy);
    if (ctx?.token) return ctx;
  }

  const oldest = path.join(tmpDir, 'cc2wechat-context.json');
  if (fs.existsSync(oldest)) {
    const ctx = readJson<ReplyContext>(oldest);
    if (ctx?.token) return ctx;
  }

  return null;
}
