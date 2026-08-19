/**
 * 本地 master key 与 secret wrapping（架构 §9 的"DB 里不许有明文长期密钥"）。
 *
 * 威胁模型很朴素：备份/同步/误传把 `gateway.db` 泄出去时，光有 DB 解不出 channelSecret。
 * master key 单独一个 0600 文件，权限不合格就 fail-closed —— 因为"能读到 key 文件的人"
 * 和"能读到 DB 的人"必须是同一层信任，权限一松这层隔离就白做了。
 *
 * 线格式：base64url(nonce(12B) || cipherbytes || authTag(16B))，AES-256-GCM。
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  AUTH_TAG_BYTES,
  NONCE_BYTES,
  aeadOpen,
  aeadSeal,
  randomNonce,
} from '../channels/waku/crypto.js';
import { decodeBase64Url, gatewayError } from '../contracts/validation.js';

export const MASTER_KEY_BYTES = 32;
export const MASTER_KEY_MODE = 0o600;

/** 固定 AAD：域分隔，避免 wrapped 凭据被挪去当 mailbox 密文用。 */
const CREDENTIAL_AAD = new Uint8Array(Buffer.from('waku-gateway-credential-v1', 'utf8'));

export interface CredentialStore {
  wrap(plaintext: Uint8Array): string;
  unwrap(wrapped: string): Uint8Array;
  close(): void;
}

export interface OpenCredentialStoreOptions {
  masterKeyPath: string;
}

export function openCredentialStore(options: OpenCredentialStoreOptions): CredentialStore {
  const key = loadOrCreateMasterKey(options.masterKeyPath);
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw gatewayError('credential_store_closed', 'credential store is already closed');
    }
  }

  return {
    wrap(plaintext: Uint8Array): string {
      assertOpen();
      const nonce = randomNonce();
      const blob = aeadSeal(key, nonce, CREDENTIAL_AAD, plaintext);
      return Buffer.concat([Buffer.from(nonce), Buffer.from(blob)]).toString('base64url');
    },

    unwrap(wrapped: string): Uint8Array {
      assertOpen();
      const decoded = decodeBase64Url(wrapped);
      if (decoded === null || decoded.length < NONCE_BYTES + AUTH_TAG_BYTES) {
        throw gatewayError('credential_auth_failed', 'wrapped credential is not authentic');
      }
      const nonce = decoded.subarray(0, NONCE_BYTES);
      const blob = decoded.subarray(NONCE_BYTES);
      const opened = aeadOpen(key, nonce, CREDENTIAL_AAD, blob);
      if (opened === null) {
        throw gatewayError('credential_auth_failed', 'wrapped credential is not authentic');
      }
      return opened;
    },

    close(): void {
      if (closed) return;
      closed = true;
      key.fill(0);
    },
  };
}

function loadOrCreateMasterKey(masterKeyPath: string): Uint8Array {
  if (!fs.existsSync(masterKeyPath)) {
    const created = randomBytes(MASTER_KEY_BYTES);
    fs.writeFileSync(masterKeyPath, created, { mode: MASTER_KEY_MODE });
    // writeFileSync 的 mode 会被 umask 削一刀，显式 chmod 才能保证真的是 0600。
    fs.chmodSync(masterKeyPath, MASTER_KEY_MODE);
    return new Uint8Array(created);
  }

  const stat = fs.statSync(masterKeyPath);
  if ((stat.mode & 0o777) !== MASTER_KEY_MODE) {
    throw gatewayError(
      'insecure_credential_permissions',
      'master key file must be mode 0600',
      'masterKeyPath',
    );
  }

  const loaded = fs.readFileSync(masterKeyPath);
  if (loaded.length !== MASTER_KEY_BYTES) {
    throw gatewayError('invalid_master_key', 'master key must be 32 bytes', 'masterKeyPath');
  }
  return new Uint8Array(loaded);
}
