import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendLog, LOG_MAX_BYTES } from '../../src/watchdog/log.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-log-'));
});

describe('运行日志', () => {
  it('目录不存在也能写（第一次装机就是这情况）', () => {
    const f = path.join(dir, 'nested', 'watchdog.log');
    appendLog(f, 'hello');
    expect(fs.readFileSync(f, 'utf-8')).toBe('hello\n');
  });

  it('逐行追加', () => {
    const f = path.join(dir, 'watchdog.log');
    appendLog(f, 'a');
    appendLog(f, 'b');
    expect(fs.readFileSync(f, 'utf-8')).toBe('a\nb\n');
  });

  it('超过上限时截断保留尾部一半，最新一行还在', () => {
    const f = path.join(dir, 'watchdog.log');
    const line = 'x'.repeat(99);
    const bulk = `${line}\n`.repeat(200); // 20000 bytes
    fs.writeFileSync(f, bulk);
    const before = fs.statSync(f).size;

    appendLog(f, 'newest', 10_000);

    const after = fs.statSync(f).size;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(before / 4);
    const content = fs.readFileSync(f, 'utf-8');
    expect(content.endsWith('newest\n')).toBe(true);
    // 被切断的半行不留
    expect(content.split('\n').filter(Boolean).every((l) => l === line || l === 'newest')).toBe(true);
  });

  it('没超上限不动它', () => {
    const f = path.join(dir, 'watchdog.log');
    fs.writeFileSync(f, 'keep\n');
    appendLog(f, 'more', 10_000);
    expect(fs.readFileSync(f, 'utf-8')).toBe('keep\nmore\n');
  });

  it('默认上限是 1MB', () => {
    expect(LOG_MAX_BYTES).toBe(1024 * 1024);
  });
});
