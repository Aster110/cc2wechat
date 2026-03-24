import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHANNEL_DIR = path.join(os.homedir(), '.claude', 'channels', 'wechat-channel');

function dataDir(): string {
  return path.join(os.homedir(), '.cc2wechat');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Account credentials
// ---------------------------------------------------------------------------

export interface AccountData {
  accountId: string;
  token: string;
  baseUrl?: string;
  savedAt: string;
  port?: number;
}

function accountsFilePath(): string {
  return path.join(CHANNEL_DIR, 'accounts.json');
}

function accountsFileForPort(port: number): string {
  return path.join(dataDir(), `accounts-${port}.json`);
}

export function loadAccounts(port?: number): AccountData[] {
  const filePath = port != null ? accountsFileForPort(port) : accountsFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveAccount(account: AccountData & { port?: number }): void {
  if (account.port != null) {
    const dir = dataDir();
    ensureDir(dir);
    const accounts = loadAccounts(account.port).filter((a) => a.accountId !== account.accountId);
    accounts.push(account);
    const filePath = accountsFileForPort(account.port);
    fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2), 'utf-8');
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // best-effort
    }
  } else {
    ensureDir(CHANNEL_DIR);
    const accounts = loadAccounts().filter((a) => a.accountId !== account.accountId);
    accounts.push(account);
    const filePath = accountsFilePath();
    fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2), 'utf-8');
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // best-effort
    }
  }
}

export function getActiveAccount(port?: number): AccountData | null {
  const accounts = loadAccounts(port);
  return accounts.length > 0 ? accounts[accounts.length - 1]! : null;
}

export function removeAccount(accountId: string): void {
  const accounts = loadAccounts().filter((a) => a.accountId !== accountId);
  ensureDir(CHANNEL_DIR);
  fs.writeFileSync(accountsFilePath(), JSON.stringify(accounts, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Sync buf (long-poll cursor)
// ---------------------------------------------------------------------------

function syncBufFilePath(accountId: string): string {
  return path.join(CHANNEL_DIR, `sync-buf-${accountId}.txt`);
}

export function loadSyncBuf(accountId: string): string {
  try {
    return fs.readFileSync(syncBufFilePath(accountId), 'utf-8');
  } catch {
    return '';
  }
}

export function saveSyncBuf(accountId: string, buf: string): void {
  ensureDir(CHANNEL_DIR);
  fs.writeFileSync(syncBufFilePath(accountId), buf, 'utf-8');
}
