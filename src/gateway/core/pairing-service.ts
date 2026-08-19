/**
 * 配对签发 / 消费 / 授权判定（架构 §5、§5.1）。
 *
 * 安全模型的三根柱子：
 *
 * 1. **admin 授权只来自服务端注入的 `authorizeIssuer`。**
 *    调用方自报的 `issuerTrustTier` 一律是攻击输入 —— 它根本不是入参，出现即拒。
 *    可信身份用对象 identity 表示：字段可以抄，身份抄不走。
 *
 * 2. **一次性 token 高熵，本地只留 hash。** 明文只在 `createGrant` 的返回值里出现一次，
 *    之后 DB 里、日志里、异常消息里都没有。禁止 6 位数字码：公共 mailbox 的观察者
 *    可以离线爆破。
 *
 * 3. **消费整体原子。** 标记 consumed 与创建 principal/device/pairing 必须同生共死，
 *    中途炸掉不许留半条身份 —— 半条身份等于一个没人认领、却能收消息的 routeId。
 *
 * 时间一律 fail-closed，且共用信封那层的时钟不确定窗口：剩余寿命短于 `MAX_CLOCK_SKEW_MS`
 * 的 grant 无法安全判定"到底过没过期"，所以直接拒绝签发。
 */
import { createHash, randomBytes } from 'node:crypto';
import { CHANNEL_SECRET_BYTES } from '../channels/waku/crypto.js';
import { MAX_CLOCK_SKEW_MS } from '../contracts/envelope.js';
import { isPairingScope, trustTierRank, type PairingScope, type TrustTier } from '../contracts/pairing.js';
import type { AgentEndpoint } from '../contracts/runner.js';
import type { GatewayStore } from '../state/sqlite-store.js';
import {
  asRecord,
  gatewayError,
  optionalString,
  requireInteger,
  requireString,
  rejectUnknownKeys,
} from '../contracts/validation.js';

/** 一次性 token 的熵：24 字节 = 192 bit，远高于架构要求的 128 bit 下限。 */
export const GRANT_TOKEN_BYTES = 24;
export const INITIAL_KEY_VERSION = 1;

/** 已认证的签发者身份。判等靠对象 identity，不靠字段。 */
export interface IssuerContext {
  readonly kind: string;
}

export type IssuerDecision =
  | { allowed: true; maxTrustTier: TrustTier }
  | { allowed: false; code: string };

export interface CreateGrantInput {
  endpointId: string;
  scopes: PairingScope[];
  expiresAt: number;
}

export interface CreateGrantResult {
  grantId: string;
  /** 明文只在这里出现一次，之后只剩 tokenHash */
  token: string;
  tokenHash: string;
  endpointId: string;
  scopes: PairingScope[];
  expiresAt: number;
}

export interface ConsumeGrantInput {
  token: string;
  deviceLabel?: string;
}

export interface ConsumeGrantResult {
  pairingId: string;
  principalId: string;
  deviceId: string;
  endpointId: string;
  routeId: string;
  channelSecret: Uint8Array;
  keyVersion: number;
  scopes: PairingScope[];
}

export interface AuthorizeInput {
  pairingId: string;
  principalId: string;
  endpointId: string;
  scope: PairingScope;
}

export type AuthorizeDecision =
  | { allowed: true; endpoint: AgentEndpoint; trustTier: TrustTier }
  | { allowed: false; code: string; message: string };

export interface PairingService {
  createGrant(input: CreateGrantInput, context: IssuerContext): Promise<CreateGrantResult>;
  consumeGrant(input: ConsumeGrantInput): Promise<ConsumeGrantResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeDecision>;
  revokePairing(pairingId: string): Promise<void>;
}

export interface PairingServiceOptions {
  store: GatewayStore;
  now(): number;
  authorizeIssuer(context: IssuerContext): Promise<IssuerDecision>;
}

const CREATE_GRANT_KEYS = ['endpointId', 'scopes', 'expiresAt'] as const;
const CONSUME_GRANT_KEYS = ['token', 'deviceLabel'] as const;

export function createPairingService(options: PairingServiceOptions): PairingService {
  const { store } = options;

  return {
    async createGrant(input: CreateGrantInput, context: IssuerContext): Promise<CreateGrantResult> {
      // 身份先判：未认证的调用方连字段校验的反馈都不该拿到。
      const decision = await options.authorizeIssuer(context);
      if (!decision.allowed) {
        throw gatewayError(decision.code, 'issuer is not authorized to create pairing grants');
      }

      const record = asRecord(input, 'grant');
      rejectUnknownKeys(record, CREATE_GRANT_KEYS);
      const endpointId = requireString(record, 'endpointId', 'endpointId');
      const scopes = parseScopes(record.scopes);
      const expiresAt = requireInteger(record, 'expiresAt', 'expiresAt', 0);

      const now = options.now();
      if (expiresAt - now <= MAX_CLOCK_SKEW_MS) {
        throw gatewayError(
          'invalid_expiry',
          'grant lifetime must exceed the clock uncertainty window',
          'expiresAt',
        );
      }

      const endpoint = store.getEndpoint(endpointId);
      if (endpoint === null) {
        throw gatewayError('endpoint_not_found', 'endpoint does not exist', 'endpointId');
      }
      if (trustTierRank(endpoint.trustTier) > trustTierRank(decision.maxTrustTier)) {
        throw gatewayError(
          'trust_tier_denied',
          'issuer may not grant access to an endpoint above its trust ceiling',
          'endpointId',
        );
      }

      const token = randomBytes(GRANT_TOKEN_BYTES).toString('base64url');
      const tokenHash = hashToken(token);
      const grantId = `gr_${randomBytes(12).toString('hex')}`;

      store.transaction((tx) => {
        tx.insertGrant({ id: grantId, tokenHash, endpointId, scopes, createdAt: now, expiresAt });
      });

      return { grantId, token, tokenHash, endpointId, scopes: [...scopes], expiresAt };
    },

    /**
     * 消费必须整体原子。这个方法在第一个 `await` 之前就把整段事务跑完，
     * 所以同一进程内两个并发调用天然串行：第二个进来时 grant 已经是 consumed。
     */
    async consumeGrant(input: ConsumeGrantInput): Promise<ConsumeGrantResult> {
      const record = asRecord(input, 'consume');
      rejectUnknownKeys(record, CONSUME_GRANT_KEYS);
      const token = requireString(record, 'token', 'token');
      const deviceLabel = optionalString(record, 'deviceLabel', 'deviceLabel');

      const tokenHash = hashToken(token);
      const now = options.now();

      return store.transaction((tx) => {
        const grant = tx.findGrantByTokenHash(tokenHash);
        // 错误消息里不出现 token 也不出现 hash：这条错会被回给未认证的调用方。
        if (grant === null) {
          throw gatewayError('grant_not_found', 'pairing grant not found');
        }
        if (grant.status === 'consumed') {
          throw gatewayError('grant_consumed', 'pairing grant was already consumed');
        }
        if (grant.status === 'revoked') {
          throw gatewayError('grant_revoked', 'pairing grant was revoked');
        }
        if (grant.status === 'expired' || now >= grant.expiresAt) {
          throw gatewayError('grant_expired', 'pairing grant is expired');
        }

        const endpoint = tx.getEndpoint(grant.endpointId);
        if (endpoint === null) {
          throw gatewayError('endpoint_not_found', 'endpoint no longer exists');
        }

        const principalId = `pri_${randomBytes(12).toString('hex')}`;
        const deviceId = `dev_${randomBytes(12).toString('hex')}`;
        const pairingId = `pr_${randomBytes(12).toString('hex')}`;
        // routeId 与 pairingId 刻意不同：routeId 会出现在公共 mailbox 里，
        // 不该让观察者顺手拿到内部主键。
        const routeId = `rt_${randomBytes(16).toString('hex')}`;
        const channelSecret = new Uint8Array(randomBytes(CHANNEL_SECRET_BYTES));

        tx.markGrantConsumed(grant.id, now);
        tx.insertPrincipal({ id: principalId, status: 'active', createdAt: now });
        tx.insertDevice({ id: deviceId, principalId, label: deviceLabel, createdAt: now });
        tx.insertPairing({
          id: pairingId,
          principalId,
          deviceId,
          endpointId: grant.endpointId,
          routeId,
          scopes: grant.scopes,
          channelSecret,
          keyVersion: INITIAL_KEY_VERSION,
          createdAt: now,
        });

        return {
          pairingId,
          principalId,
          deviceId,
          endpointId: grant.endpointId,
          routeId,
          channelSecret,
          keyVersion: INITIAL_KEY_VERSION,
          scopes: grant.scopes,
        };
      });
    },

    async authorize(input: AuthorizeInput): Promise<AuthorizeDecision> {
      const pairing = store.getPairing(input.pairingId);
      if (pairing === null) {
        return deny('pairing_not_found', 'pairing not found');
      }
      if (pairing.status === 'revoked') {
        return deny('pairing_revoked', 'pairing has been revoked');
      }
      if (pairing.principalId !== input.principalId) {
        return deny('principal_mismatch', 'pairing does not belong to this principal');
      }
      // 禁止仅凭 conversation/endpoint id 跨 pairing 接续：guest 不得偷用 aster 的 endpoint。
      if (pairing.endpointId !== input.endpointId) {
        return deny('endpoint_not_bound', 'endpoint is not bound to this pairing');
      }
      if (!pairing.scopes.includes(input.scope)) {
        return deny('scope_denied', 'pairing does not hold the required scope');
      }

      const endpoint = store.getEndpoint(input.endpointId);
      if (endpoint === null) {
        return deny('endpoint_not_found', 'endpoint does not exist');
      }
      if (endpoint.status !== 'active') {
        return deny('endpoint_disabled', 'endpoint is disabled');
      }

      return { allowed: true, endpoint, trustTier: endpoint.trustTier };
    },

    async revokePairing(pairingId: string): Promise<void> {
      const now = options.now();
      store.transaction((tx) => {
        if (tx.getPairing(pairingId) === null) {
          throw gatewayError('pairing_not_found', 'pairing not found', 'pairingId');
        }
        tx.revokePairing(pairingId, now);
      });
    },
  };
}

function deny(code: string, message: string): AuthorizeDecision {
  return { allowed: false, code, message };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseScopes(value: unknown): PairingScope[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPairingScope)) {
    throw gatewayError('invalid_input', 'scopes must be a non-empty list of known scopes', 'scopes');
  }
  return value;
}
