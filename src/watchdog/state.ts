import fs from 'node:fs';
import path from 'node:path';

import type { WatchdogState } from './types.js';

export function emptyState(): WatchdogState {
  return { version: 1, daemons: {}, expiryNotified: {} };
}

/**
 * 读状态。坏文件 = 当空状态重来。
 *
 * 代价想清楚了：状态丢了最多是多发一条报警（收敛窗口重置），
 * 反过来"读不出状态就退出"会让看门狗自己变成哑巴——那是这套系统要治的病。
 */
export function loadState(file: string, readFile = fs.readFileSync): WatchdogState {
  let raw: string;
  try {
    raw = String(readFile(file, 'utf-8'));
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WatchdogState>;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      version: 1,
      daemons: parsed.daemons && typeof parsed.daemons === 'object' ? parsed.daemons : {},
      expiryNotified:
        parsed.expiryNotified && typeof parsed.expiryNotified === 'object' ? parsed.expiryNotified : {},
      lastHeartbeatDay: typeof parsed.lastHeartbeatDay === 'string' ? parsed.lastHeartbeatDay : undefined,
    };
  } catch {
    return emptyState();
  }
}

/** 原子落盘：先写 .tmp 再 rename，cron 撞车也不会读到半个 JSON */
export function saveState(file: string, state: WatchdogState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}
