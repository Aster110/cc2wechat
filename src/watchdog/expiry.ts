import fs from 'node:fs';

import type { ExpiryEntry, ExpiryFinding } from './types.js';

export const DAY_MS = 86_400_000;
/** 距到期少于这么多天就开始预警 */
export const WARN_DAYS = 3;

/**
 * 把 YYYY-MM-DD 当**本地**午夜解析。
 * `new Date('2026-09-20')` 是 UTC 午夜——东八区跑起来会差 8 小时，
 * 心跳小时数、"每天一次"去重也全都按本地算，这里必须跟着本地走。
 */
export function parseExpiryDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 读到期表。文件不存在 / 坏 JSON = 返回 []（跳过，不 crash——这条不是主链路） */
export function readExpiryFile(file: string, readFile = fs.readFileSync): ExpiryEntry[] {
  let raw: string;
  try {
    raw = String(readFile(file, 'utf-8'));
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ExpiryEntry => !!e && typeof e === 'object' && typeof e.name === 'string' && typeof e.expiresAt === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 挑出该喊的凭证：已过期 = 报警，距到期 < 3 天 = 预警。
 * 没到期的一条不返回——看门狗只在有事的时候说话。
 */
export function findExpiryIssues(entries: ExpiryEntry[], now: Date): ExpiryFinding[] {
  const out: ExpiryFinding[] = [];
  for (const e of entries) {
    const exp = parseExpiryDate(e.expiresAt);
    if (!exp) continue;
    const diff = exp.getTime() - now.getTime();
    const daysLeft = Math.floor(diff / DAY_MS);
    if (diff <= 0) out.push({ ...e, level: 'expired', daysLeft });
    else if (daysLeft < WARN_DAYS) out.push({ ...e, level: 'warn', daysLeft });
  }
  return out;
}
