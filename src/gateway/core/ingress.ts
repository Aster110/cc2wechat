/**
 * CoreIngress：入站半边（架构 §9 核心顺序）。
 *
 * 有两个面，因为 M2 的 adapter 只管搬运不管密码学：
 *
 * - `opener.open/seal`：routeId → pairing → 长期方向密钥。失败必须带 `permanent` 分类，
 *   adapter 靠它决定要不要把这行永久标 seen：
 *   AEAD 认证失败 / 未知路由 / 解出来不是合法 payload = 伪造行 → permanent；
 *   keyVersion 不匹配 = 将来 re-key 后也许能解的合法行 → **非** permanent，不许钉死。
 * - `sink`：身份 → scope → endpoint → 会话归属 → 幂等 → 入队。
 *
 * 顺序是安全语义的一部分：
 *
 * 「验 pairing」→「插 InboxReceipt(received)」→ accepted/duplicate →「授权、入队」
 *
 * 于是 **验不过 pairing 的消息不留 receipt**（它根本不属于任何人，留下就是给陌生人
 * 在我们库里免费写行），而**授权失败的消息留 status=rejected 的 receipt** ——
 * 重放它只会拿到 duplicate，永远不会变成一次 Agent 调用。
 *
 * 还有一条贯穿全文件的规矩：**endpoint / trustTier / principal 一律从 pairing 行现查**，
 * 客户端 payload 里的任何自报字段都不参与判定（架构 §3 硬边界 3）。
 */
import type { IngressAck } from '../contracts/channel.js';
import {
  parseSecurePayload,
  type MailboxChunk,
  type MailboxDirection,
  type MailboxKind,
  type SecurePayload,
} from '../contracts/envelope.js';
import type { PairingScope } from '../contracts/pairing.js';
import { isGatewayError } from '../contracts/validation.js';
import { openMessage, sealMessage } from '../channels/waku/chunking.js';
import type { GatewayStore, PairingRow } from '../state/sqlite-store.js';
import type { AgentEndpointRegistry } from '../runners/registry.js';
import type { ConversationService } from './conversation-service.js';
import { openFailure, PAIR_ROUTE_PREFIX, type OpenFailure } from './pairing-flow.js';
import type { ControlCommand, TurnDispatcher, TurnJob } from './orchestrator.js';

/** 长期流量的 HKDF purpose。握手用 `pair`，两把钥匙永不通用。 */
export const PURPOSE_MESSAGE = 'msg';

export interface InboundEnvelope {
  channel: 'waku';
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  createdAt: number;
  expiresAt: number;
  receivedAt: number;
  payload: SecurePayload;
}

export interface OpenInput {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  chunks: MailboxChunk[];
}

export interface SealInput {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  direction: MailboxDirection;
  createdAt: number;
  expiresAt: number;
  payload: SecurePayload;
}

/** Core 提供给 Channel 的唯一密码学入口。 */
export interface MailboxOpener {
  open(input: OpenInput): Promise<SecurePayload>;
  seal(input: SealInput): Promise<MailboxChunk[]>;
}

/** delivery 的窄投影：ingress 只回 ack、只转交玩家 ack。 */
export interface IngressDelivery {
  publish(input: {
    pairingId: string;
    routeId: string;
    keyVersion: number;
    kind: MailboxKind;
    payload: SecurePayload;
  }): Promise<{ messageId: string; receipt: unknown }>;
  acknowledge(input: {
    pairingId: string;
    ackMessageId: string;
    status: 'received' | 'completed' | 'displayed';
  }): 'acknowledged' | 'unknown';
}

/** PairingFlow 的窄投影：ingress 不认识 grant，只认识"这条路由归握手管"。 */
export interface PairingSeam {
  routes(): string[];
  openPairChunks(input: OpenInput): Promise<SecurePayload>;
  sealPairChunks(input: SealInput): Promise<MailboxChunk[]>;
  handle(envelope: InboundEnvelope): Promise<IngressAck>;
}

export interface CoreIngress {
  readonly opener: MailboxOpener;
  sink(envelope: InboundEnvelope): Promise<IngressAck>;
}

export interface CoreIngressOptions {
  store: GatewayStore;
  /** routeId → pairingId 的索引（bootstrap 注入；status/scopes/secret 一律现查 store）。 */
  resolveRoute(routeId: string): { pairingId: string } | null;
  conversations: ConversationService;
  registry: Pick<AgentEndpointRegistry, 'resolve'>;
  dispatcher: TurnDispatcher;
  delivery: IngressDelivery;
  pairing: PairingSeam;
  now(): number;
  /** 服务端可信的 admin 名单：admin-bypass endpoint 只认它，不认任何客户端自报字段。 */
  isAdminPrincipal(principalId: string): boolean;
}

const SCOPE_BY_CONTROL_OP: Record<string, PairingScope> = {
  stop: 'conversation.stop',
  new: 'conversation.new',
  resume: 'conversation.resume',
};

/**
 * chunking 抛的是 `GatewayError`（没有 permanent 分类），这里补上。
 * 只有 keyVersion 不匹配是"以后也许能解"，其余全是伪造行 —— 宁可永久跳过，
 * 也不让一条解不开的行每轮轮询都被重试一次。
 */
function classifyOpenError(error: unknown): OpenFailure {
  if (typeof (error as OpenFailure | undefined)?.permanent === 'boolean') {
    return error as OpenFailure;
  }
  const code = isGatewayError(error) ? error.code : 'chunk_auth_failed';
  return openFailure(code, 'failed to open the inbound message', code !== 'key_version_mismatch');
}

function rejected(code: string): IngressAck {
  return { status: 'rejected', code };
}

export function createCoreIngress(options: CoreIngressOptions): CoreIngress {
  const { store, conversations, registry, dispatcher, delivery, pairing, now } = options;

  /** 握手路由由 PairingFlow 全权处理：前缀 + 登记表双判，两条都算它的。 */
  function isPairRoute(routeId: string): boolean {
    return routeId.startsWith(PAIR_ROUTE_PREFIX) || pairing.routes().includes(routeId);
  }

  /**
   * 路由 → 可用的 pairing 行。这是 ingress 唯一的身份来源。
   * 撤销与未知分开报：撤销的人知道自己被撤了没关系，陌生人连"这条路由存在"都不该知道。
   */
  function pairingFor(routeId: string): PairingRow {
    const resolved = options.resolveRoute(routeId);
    if (resolved === null) {
      throw openFailure('unknown_route', 'route is not bound to any pairing', true);
    }
    const row = store.getPairing(resolved.pairingId);
    if (row === null) {
      throw openFailure('unknown_route', 'route is not bound to any pairing', true);
    }
    if (row.status !== 'active') {
      // 消息体里绝不带 routeId / secret：这条错会进日志。
      throw openFailure('pairing_revoked', 'pairing has been revoked', true);
    }
    return row;
  }

  const opener: MailboxOpener = {
    async open(input: OpenInput): Promise<SecurePayload> {
      if (isPairRoute(input.routeId)) {
        return pairing.openPairChunks(input);
      }

      const row = pairingFor(input.routeId);
      // 接收方的 pairing 状态说了算，不采信密文自称的 keyVersion。
      if (input.keyVersion !== row.keyVersion) {
        throw openFailure('key_version_mismatch', 'keyVersion does not match the pairing', false);
      }

      const channelSecret = store.getPairingSecret(row.id);
      if (channelSecret === null) {
        throw openFailure('unknown_route', 'route is not bound to any pairing', true);
      }

      let plaintext: string;
      try {
        plaintext = await openMessage(input.chunks, {
          channelSecret,
          pairingId: row.id,
          direction: input.direction,
          purpose: PURPOSE_MESSAGE,
          keyVersion: row.keyVersion,
          now: now(),
        });
      } catch (error) {
        throw classifyOpenError(error);
      }

      try {
        return parseSecurePayload(JSON.parse(plaintext));
      } catch (error) {
        // 解得开但不是合法内部消息 = 对端在协议之外自由发挥，永久跳过。
        const code = isGatewayError(error) ? error.code : 'invalid_payload';
        throw openFailure(code, 'decrypted payload is not a valid message', true);
      }
    },

    async seal(input: SealInput): Promise<MailboxChunk[]> {
      if (isPairRoute(input.routeId)) {
        return pairing.sealPairChunks(input);
      }

      // 未知 / 已撤销一律抛，绝不用错钥匙封出一条"能被别人解开"的回复。
      const row = pairingFor(input.routeId);
      const channelSecret = store.getPairingSecret(row.id);
      if (channelSecret === null) {
        throw openFailure('unknown_route', 'route is not bound to any pairing', true);
      }

      return sealMessage({
        channelSecret,
        pairingId: row.id,
        routeId: input.routeId,
        messageId: input.messageId,
        direction: input.direction,
        kind: input.kind,
        keyVersion: row.keyVersion,
        purpose: PURPOSE_MESSAGE,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        plaintext: JSON.stringify(input.payload),
      });
    },
  };

  /** 授权失败也要留痕：重放同一条只会拿到 duplicate，不会变成第二次执行。 */
  function markRejected(pairingId: string, messageId: string): void {
    store.transaction((tx) => tx.updateReceiptStatus(pairingId, messageId, 'rejected'));
  }

  /** endpoint 与 admin 名单的联合判定 —— turn 与 control 共用同一把尺子。 */
  function authorizeEndpoint(
    row: PairingRow,
  ): { ok: true } | { ok: false; code: string } {
    let trustTier: string;
    try {
      trustTier = registry.resolve(row.endpointId).endpoint.trustTier;
    } catch (error) {
      return { ok: false, code: isGatewayError(error) ? error.code : 'endpoint_not_found' };
    }
    // admin-bypass 的钥匙只认服务端名单：配对本身不足以证明"我是 aster"。
    if (trustTier === 'admin-bypass' && !options.isAdminPrincipal(row.principalId)) {
      return { ok: false, code: 'admin_endpoint_denied' };
    }
    return { ok: true };
  }

  async function handleTurn(
    envelope: InboundEnvelope,
    row: PairingRow,
    payload: Extract<SecurePayload, { type: 'turn' }>,
  ): Promise<IngressAck> {
    if (!row.scopes.includes('chat.send')) return rejected('scope_denied');

    const endpoint = authorizeEndpoint(row);
    if (!endpoint.ok) return rejected(endpoint.code);

    // generation 缺省按第 1 代：M1 冻结的 turn 没有这个字段，老客户端不该因此说不上话。
    const generation = payload.generation ?? 1;
    const decision = conversations.open({
      conversationId: payload.conversationId,
      generation,
      pairingId: row.id,
      principalId: row.principalId,
    });
    if (!decision.allowed) return rejected(decision.code);

    const job: TurnJob = {
      pairingId: row.id,
      principalId: row.principalId,
      endpointId: row.endpointId,
      routeId: row.routeId,
      keyVersion: row.keyVersion,
      conversationId: payload.conversationId,
      generation: decision.conversation.generation,
      messageId: envelope.messageId,
      text: payload.text,
      clientSeq: payload.clientSeq,
      receivedAt: envelope.receivedAt,
    };

    const result = await dispatcher.submitTurn(job);
    if (result.status === 'rejected') return rejected(result.code);
    return { status: 'accepted' };
  }

  async function handleControl(
    envelope: InboundEnvelope,
    row: PairingRow,
    payload: Extract<SecurePayload, { type: 'control' }>,
  ): Promise<IngressAck> {
    const scope = SCOPE_BY_CONTROL_OP[payload.op];
    if (scope === undefined || !row.scopes.includes(scope)) return rejected('scope_denied');

    const endpoint = authorizeEndpoint(row);
    if (!endpoint.ok) return rejected(endpoint.code);

    const generation = payload.generation ?? 1;
    // stop / resume 作用在**已存在**的会话上，先判归属；
    // new 开的是新会话，归属由编排层的 startNew 一并判（这里判会误报 not_found）。
    if (payload.op !== 'new') {
      const owned = conversations.authorize({
        conversationId: payload.conversationId,
        pairingId: row.id,
        principalId: row.principalId,
      });
      if (!owned.allowed) return rejected(owned.code);
    }

    const command: ControlCommand = {
      op: payload.op,
      pairingId: row.id,
      principalId: row.principalId,
      endpointId: row.endpointId,
      routeId: row.routeId,
      keyVersion: row.keyVersion,
      conversationId: payload.conversationId,
      generation,
      messageId: envelope.messageId,
      receivedAt: envelope.receivedAt,
      ...(payload.targetTurnId === undefined ? {} : { targetTurnId: payload.targetTurnId }),
    };

    const result = await dispatcher.control(command);
    if (result.status === 'rejected') return rejected(result.code);
    return { status: 'accepted' };
  }

  return {
    opener,

    async sink(envelope: InboundEnvelope): Promise<IngressAck> {
      // 握手不查 pairing 表（它还没有 pairing），也不占 receipt。
      if (envelope.kind === 'pair' || isPairRoute(envelope.routeId)) {
        return pairing.handle(envelope);
      }

      let row: PairingRow;
      try {
        row = pairingFor(envelope.routeId);
      } catch (error) {
        // 不属于任何有效 pairing 的消息连一条 receipt 都不配占。
        return rejected(isGatewayError(error) ? error.code : 'unknown_route');
      }

      // 幂等闸门：主键是 (pairingId, messageId)，所以两个 pairing 撞同一个 messageId 互不干扰。
      const inserted = store.transaction((tx) =>
        tx.insertInboxReceipt({
          pairingId: row.id,
          messageId: envelope.messageId,
          status: 'received',
          receivedAt: envelope.receivedAt,
        }),
      );
      if (inserted === 'duplicate') return { status: 'duplicate' };

      const payload = envelope.payload;

      // 玩家 ack 是出站的回声，不入队也不回 ack（否则两端互相 ack 到天荒地老）。
      if (payload.type === 'ack') {
        delivery.acknowledge({
          pairingId: row.id,
          ackMessageId: payload.ackMessageId,
          status: payload.status,
        });
        return { status: 'accepted' };
      }

      if (payload.type !== 'turn' && payload.type !== 'control') {
        markRejected(row.id, envelope.messageId);
        return rejected('unsupported_payload');
      }

      // 收到就回执，早于任何授权判定：这条 ack 是给 Playable 删自己 inbox 行用的，
      // 拖到授权之后，被拒的那条会永远躺在它的信箱里重发。
      await delivery.publish({
        pairingId: row.id,
        routeId: row.routeId,
        keyVersion: row.keyVersion,
        kind: 'ack',
        payload: { type: 'ack', ackMessageId: envelope.messageId, status: 'received' },
      });

      const ack =
        payload.type === 'turn'
          ? await handleTurn(envelope, row, payload)
          : await handleControl(envelope, row, payload);

      if (ack.status === 'rejected') markRejected(row.id, envelope.messageId);
      return ack;
    },
  };
}
