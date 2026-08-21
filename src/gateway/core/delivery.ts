/**
 * CoreDelivery：出站半边（架构 §9 + §13 故障行）。
 *
 * 三条不可让步的：
 *
 * 1. **先落库，再写 Waku。** outbox 行必须在 `channel.send()` 之前就已持久，
 *    否则进程在 send 途中挂掉，这条回复就永远消失了（Agent 已经跑完了，没人会再算一次）。
 * 2. **messageId 由 Core 铸一次，重投复用。** at-least-once 的前提是 ID 不变 ——
 *    Playable 靠 messageId 去重展示。`unknown` 回执尤其要守这条：
 *    写可能已经成功了，换个 ID 重发等于让用户看到两条一模一样的回复。
 * 3. **重启后 pending 接着投。** 唯一事实源是 outbox 表，不是内存队列；
 *    换一个 delivery 实例、换一个 ID 生成器，投出去的仍是原来那条。
 *
 * 分片与密码学都不在这层：`channel` 拿到的是明文 `OutboundEnvelope`，
 * 由它调 Core 提供的 opener 去封（见 ingress）。
 */
import type { DeliveryReceipt } from '../contracts/channel.js';
import type { AckStatus, MailboxKind, SecurePayload } from '../contracts/envelope.js';
import { gatewayError } from '../contracts/validation.js';
import type { GatewayStore, OutboxRow } from '../state/sqlite-store.js';

/** Channel 的窄投影：delivery 只需要 send 一个动词。 */
export interface DeliveryChannel {
  send(envelope: OutboundEnvelope): Promise<DeliveryReceipt>;
}

export interface OutboundEnvelope {
  routeId: string;
  messageId: string;
  kind: MailboxKind;
  keyVersion: number;
  expiresAt: number;
  payload: SecurePayload;
}

export interface PublishInput {
  pairingId: string;
  routeId: string;
  keyVersion: number;
  kind: MailboxKind;
  payload: SecurePayload;
  /**
   * 由调用方指定 outbox id（回环回复口用 `reply:<uuid>`，让人一眼看出这条不是某一轮的产物）。
   * 缺省仍由 Core 铸 UUIDv7。**一旦铸出就不许换**——重投复用同一个 id 是幂等的全部依据。
   */
  messageId?: string;
}

export interface PublishResult {
  messageId: string;
  receipt: DeliveryReceipt;
}

export interface FlushReport {
  attempted: number;
  sent: number;
  pending: number;
  failed: number;
}

export interface AcknowledgeInput {
  pairingId: string;
  ackMessageId: string;
  status: AckStatus;
}

export interface CoreDelivery {
  publish(input: PublishInput): Promise<PublishResult>;
  /** 重投所有 pending（重启后 / 退避后调用）。 */
  flushPending(): Promise<FlushReport>;
  /** 玩家 ack（displayed/completed）后本条不再重投。 */
  acknowledge(input: AcknowledgeInput): 'acknowledged' | 'unknown';
  pendingCount(): number;
}

export interface CoreDeliveryOptions {
  store: GatewayStore;
  channel: DeliveryChannel;
  now(): number;
  newMessageId(): string;
  ttlMs?: number;
}

/** 出站消息的默认寿命：够玩家离线一会儿再回来看，又不至于让 mailbox 长草。 */
export const DEFAULT_OUTBOX_TTL_MS = 5 * 60 * 1000;

export function createCoreDelivery(options: CoreDeliveryOptions): CoreDelivery {
  const { store, channel, now } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_OUTBOX_TTL_MS;

  /** 回执 → 落库。四种回执各有各的终局，任何一种都不许换 messageId。 */
  function settle(messageId: string, receipt: DeliveryReceipt): void {
    if (receipt.status === 'sent') {
      store.transaction((tx) =>
        tx.markOutboxSent(messageId, receipt.externalDeliveryId ?? '', now()),
      );
      return;
    }
    if (receipt.status === 'permanent-failure') {
      store.transaction((tx) => tx.markOutboxFailed(messageId, now()));
      return;
    }
    // retryable / unknown：行留在 pending，等下一轮 flush。
    // unknown 特别重要 —— 写可能已经成功了，所以既不能标失败，也不能换 ID 重铸。
  }

  async function deliver(envelope: OutboundEnvelope): Promise<DeliveryReceipt> {
    const receipt = await channel.send(envelope);
    settle(envelope.messageId, receipt);
    return receipt;
  }

  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      const messageId = input.messageId ?? options.newMessageId();
      const createdAt = now();

      // 先落库：这一步返回后，即使下一行崩了，重启也还能把它投出去。
      store.transaction((tx) =>
        tx.insertOutbox({
          messageId,
          pairingId: input.pairingId,
          routeId: input.routeId,
          kind: input.kind,
          payload: JSON.stringify(input.payload),
          createdAt,
        }),
      );

      const receipt = await deliver({
        routeId: input.routeId,
        messageId,
        kind: input.kind,
        keyVersion: input.keyVersion,
        expiresAt: createdAt + ttlMs,
        payload: input.payload,
      });
      return { messageId, receipt };
    },

    async flushPending(): Promise<FlushReport> {
      const rows = store.listPendingOutbox();
      const report: FlushReport = {
        attempted: rows.length,
        sent: 0,
        pending: 0,
        failed: 0,
      };

      for (const row of rows) {
        const receipt = await deliver(envelopeOf(row, store, now() + ttlMs));
        if (receipt.status === 'sent') report.sent += 1;
        else if (receipt.status === 'permanent-failure') report.failed += 1;
        else report.pending += 1;
      }
      return report;
    },

    acknowledge(input: AcknowledgeInput): 'acknowledged' | 'unknown' {
      const row = store.getOutbox(input.ackMessageId);
      // 跨 pairing 隔离：公共信箱里谁都能喊一嗓子，只有本人的 ack 算数。
      // 不存在的 messageId 也走这条（信箱里全是垃圾行，不该抛）。
      if (row === null || row.pairingId !== input.pairingId) return 'unknown';
      if (row.status === 'pending') {
        store.transaction((tx) => tx.markOutboxAcknowledged(row.messageId, now()));
      }
      return 'acknowledged';
    },

    pendingCount(): number {
      return store.listPendingOutbox().length;
    },
  };
}

/**
 * 从 outbox 行还原一条待重投的信封。
 *
 * keyVersion 不在 outbox 表里，现从 pairing 行取：重投用的必须是**当前**这把钥匙，
 * 否则 re-key 之后所有积压消息都会变成对端解不开的乱码。
 */
function envelopeOf(row: OutboxRow, store: GatewayStore, expiresAt: number): OutboundEnvelope {
  const pairing = store.getPairing(row.pairingId);
  const parsed: unknown = JSON.parse(row.payload);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw gatewayError('store_corrupt', 'outbox payload is not a JSON object', 'payload');
  }
  return {
    routeId: row.routeId,
    messageId: row.messageId,
    kind: row.kind as MailboxKind,
    keyVersion: pairing?.keyVersion ?? 1,
    expiresAt,
    payload: parsed as SecurePayload,
  };
}
