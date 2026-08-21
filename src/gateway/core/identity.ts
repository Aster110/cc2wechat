/**
 * IdentityResolver：入站信封 → 「这条消息是谁、跑在哪个 endpoint、归哪条车道」（契约 §3.6）。
 *
 * ingress 原本把「routeId → pairing 行现查」焊死在入站路径上；抽成策略之后：
 *
 * - **V1 mailbox**：`createPairingIdentityResolver`——行为与原 `pairingFor` 逐字相同
 *   （未知路由 / 撤销的 pairing 抛 `OpenFailure`，code 与 permanent 分类不变），
 *   ingress 缺省就用它，所以不传 `identity` 的旧调用方零回归。
 * - **waku-dm**：`createAclIdentityResolver`——平台已经认证了 sender（`sender_user_id` 来自
 *   马甲自己的 per-user 总线，不可伪造），daemon 只做授权：`OWNER_USER_IDS` → admin endpoint；
 *   其它 sender 默认 deny（静默，不留 receipt、不回话），可选地落到一个权限受限的 guest endpoint。
 *
 * `ResolvedIdentity.pairingId` 是 Core 各表（inbox_receipts / outbox / conversations / turns）
 * 与串行车道共用的分组键：V1 = pairing 行 id；waku-dm = sender user id——
 * 一个人对马甲只有一条私聊，按人串行等价于按会话串行，且天然不让两个人互相踩工作区。
 */
import { PAIRING_SCOPES, type PairingScope } from '../contracts/pairing.js';
import { gatewayError } from '../contracts/validation.js';
import type { GatewayStore } from '../state/sqlite-store.js';
import type { InboundEnvelope } from './ingress.js';
import { openFailure } from './pairing-flow.js';

export interface ResolvedIdentity {
  /** 车道 / receipt / outbox / 会话归属的分组键。 */
  pairingId: string;
  principalId: string;
  endpointId: string;
  /** 出站要回到的路由：V1 = 配对路由；waku-dm = Waku conversation_id。 */
  routeId: string;
  keyVersion: number;
  scopes: readonly PairingScope[];
}

export interface IdentityResolver {
  /**
   * 解析失败一律 throw 带 `code` 的错误（`unknown_route` / `pairing_revoked` / `acl_denied` …）；
   * ingress 把它转成 `rejected(code)` 且**不留 receipt**——不属于任何身份的消息不配占一行。
   */
  resolve(envelope: InboundEnvelope): ResolvedIdentity;
}

export interface PairingIdentityResolver extends IdentityResolver {
  /** opener 只有 routeId（没有信封）：V1 密码学面按路由解析。 */
  byRoute(routeId: string): ResolvedIdentity;
}

export interface PairingIdentityResolverOptions {
  store: Pick<GatewayStore, 'getPairing'>;
  /** routeId → pairingId 的索引（bootstrap 注入；status/scopes/secret 一律现查 store）。 */
  resolveRoute(routeId: string): { pairingId: string } | null;
}

export function createPairingIdentityResolver(
  options: PairingIdentityResolverOptions,
): PairingIdentityResolver {
  function byRoute(routeId: string): ResolvedIdentity {
    const resolved = options.resolveRoute(routeId);
    if (resolved === null) {
      throw openFailure('unknown_route', 'route is not bound to any pairing', true);
    }
    const row = options.store.getPairing(resolved.pairingId);
    if (row === null) {
      throw openFailure('unknown_route', 'route is not bound to any pairing', true);
    }
    if (row.status !== 'active') {
      // 消息体里绝不带 routeId / secret：这条错会进日志。
      throw openFailure('pairing_revoked', 'pairing has been revoked', true);
    }
    return {
      pairingId: row.id,
      principalId: row.principalId,
      endpointId: row.endpointId,
      routeId: row.routeId,
      keyVersion: row.keyVersion,
      scopes: row.scopes,
    };
  }

  return {
    byRoute,
    resolve(envelope: InboundEnvelope): ResolvedIdentity {
      if (envelope.channel !== 'waku') {
        // 明文通道的信封没有配对：策略不串台，按未知路由拒。
        throw openFailure('unknown_route', 'envelope channel is not backed by a pairing', true);
      }
      return byRoute(envelope.routeId);
    },
  };
}

export interface AclIdentityResolverOptions {
  /** 服务端可信的 owner 名单（活查询：加人不用重启）。 */
  isOwner(userId: string): boolean;
  ownerEndpointId: string;
  /** 非 owner 的落点；null = 默认档 deny（静默）。 */
  guestEndpointId: string | null;
  scopes?: readonly PairingScope[];
}

export function createAclIdentityResolver(options: AclIdentityResolverOptions): IdentityResolver {
  const scopes = options.scopes ?? [...PAIRING_SCOPES];

  return {
    resolve(envelope: InboundEnvelope): ResolvedIdentity {
      if (envelope.channel !== 'waku-dm') {
        throw openFailure('unknown_route', 'envelope channel is not a waku-dm envelope', true);
      }
      const sender = envelope.principalRef;
      if (typeof sender !== 'string' || sender.length === 0) {
        throw gatewayError('acl_denied', 'sender is not allowed', 'principalRef');
      }
      const endpointId = options.isOwner(sender) ? options.ownerEndpointId : options.guestEndpointId;
      if (endpointId === null) {
        // 静默 deny：错误文案里不回显 sender —— 这条会进日志。
        throw gatewayError('acl_denied', 'sender is not allowed', 'principalRef');
      }
      return {
        pairingId: sender,
        principalId: sender,
        endpointId,
        routeId: envelope.routeId,
        keyVersion: 1,
        scopes,
      };
    },
  };
}
