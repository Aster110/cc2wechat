/**
 * 身份、配对与权限词表（架构 §5、§5.1）。
 *
 * `TRUST_TIERS` 的**顺序有语义**：授权判定靠 index 比大小，不是靠字符串集合。
 * 往中间插一档 = 改语义，必须同步改所有比较点。
 */
export const PAIRING_SCOPES = [
  'chat.send',
  'conversation.new',
  'conversation.stop',
  'conversation.resume',
  'artifact.read',
] as const;
export type PairingScope = (typeof PAIRING_SCOPES)[number];

/** 权限从低到高。`admin-bypass` 是 aster 专用的最高档。 */
export const TRUST_TIERS = [
  'chat-only',
  'sandbox-workspace',
  'repo-pr',
  'admin-bypass',
] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const GRANT_STATUSES = ['pending', 'consumed', 'expired', 'revoked'] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const PAIRING_STATUSES = ['active', 'revoked'] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];

export const PRINCIPAL_STATUSES = ['active', 'disabled'] as const;
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

export interface Principal {
  id: string;
  displayName?: string;
  status: PrincipalStatus;
  createdAt: number;
}

export interface Device {
  id: string;
  principalId: string;
  label?: string;
  createdAt: number;
}

export interface PairingGrant {
  id: string;
  tokenHash: string;
  endpointId: string;
  scopes: PairingScope[];
  status: GrantStatus;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}

export interface Pairing {
  id: string;
  principalId: string;
  deviceId: string;
  endpointId: string;
  routeId: string;
  scopes: PairingScope[];
  secretCiphertext: string;
  keyVersion: number;
  status: PairingStatus;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export function isPairingScope(value: unknown): value is PairingScope {
  return typeof value === 'string' && (PAIRING_SCOPES as readonly string[]).includes(value);
}

export function isTrustTier(value: unknown): value is TrustTier {
  return typeof value === 'string' && (TRUST_TIERS as readonly string[]).includes(value);
}

/** 越大权限越高。用于"signer 只能签不高于自己上限的 endpoint"。 */
export function trustTierRank(tier: TrustTier): number {
  return TRUST_TIERS.indexOf(tier);
}
