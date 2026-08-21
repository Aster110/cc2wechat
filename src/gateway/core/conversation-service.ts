/**
 * ConversationService：谁有权接续哪个会话（架构 §10）。
 *
 * 冻结的状态机：
 *
 * - conversationId 由客户端铸。首次出现即创建，owner = (pairingId, principalId)，此后不可更改。
 * - 每条消息带 generation。与库里相等 = 继续；小于 = `stale_generation`；
 *   大于 = 客户端开了新一代 → 提升代数，旧 provider binding 立刻失效。
 * - `new` 带**新** conversationId + 更高代数；旧会话被 supersede（generation+1），
 *   于是旧 binding 失效、旧代在途消息全变 stale。
 * - `binding()` 只在 `binding.generation === conversation.generation` 时返回。
 *   **失效靠代数比对，不靠删行** —— 删行是有损的（崩在中间就分不清"没绑过"和"绑过又断了"），
 *   代数比对是幂等的，且天然覆盖"迟到一代的写入"。
 *
 * 跨 principal / 跨 pairing 一律 `conversation_forbidden`，且错误里不回显真正的 owner：
 * 公共信箱的观察者不该拿它当会话存在性预言机。
 */
import type { SessionBinding } from '../../v6/contracts.js';
import type { ConversationRow, GatewayStore } from '../state/sqlite-store.js';

export interface ConversationSnapshot {
  id: string;
  pairingId: string;
  principalId: string;
  generation: number;
}

export type ConversationDecision =
  | {
      allowed: true;
      conversation: ConversationSnapshot;
      created: boolean;
      generationChanged: boolean;
    }
  | { allowed: false; code: string; message: string };

export interface ConversationRef {
  conversationId: string;
  generation: number;
  pairingId: string;
  principalId: string;
}

export interface BindProviderInput {
  conversationId: string;
  generation: number;
  agentType: string;
  providerSessionId: string;
}

export interface ConversationService {
  /** turn / resume 走这里：不存在就创建，存在就校验 owner 与 generation。 */
  open(input: ConversationRef): ConversationDecision;
  /**
   * `new` 控制走这里：conversationId 必须是新的，可选地 supersede 上一条会话。
   * 特例：`previousConversationId === conversationId` = 同会话提代（generation+1，不新建行）。
   */
  startNew(input: ConversationRef & { previousConversationId?: string }): ConversationDecision;
  /** 只判归属，不动 generation（stop / resume 的前置检查）。 */
  authorize(input: Omit<ConversationRef, 'generation'>): ConversationDecision;
  bindProvider(input: BindProviderInput): void;
  binding(conversationId: string): SessionBinding | null;
}

export interface ConversationServiceOptions {
  store: GatewayStore;
  now(): number;
}

/** 存在性预言机防护：所有归属失败共用同一句话，不透露 owner 是谁、甚至不透露有没有 owner。 */
const FORBIDDEN_MESSAGE = 'conversation is not accessible for this pairing';

function deny(code: string, message: string): ConversationDecision {
  return { allowed: false, code, message };
}

function snapshotOf(row: ConversationRow): ConversationSnapshot {
  return {
    id: row.id,
    pairingId: row.pairingId,
    principalId: row.principalId,
    generation: row.generation,
  };
}

function ownedBy(row: ConversationRow, input: { pairingId: string; principalId: string }): boolean {
  // 两个都要对：只凭 pairingId 接续等于把同一台设备上的所有身份混成一个。
  return row.pairingId === input.pairingId && row.principalId === input.principalId;
}

export function createConversationService(
  options: ConversationServiceOptions,
): ConversationService {
  const { store, now } = options;

  /**
   * SQLite 的 binding 行没有时间列（M1 冻结的 schema）。这里按实例记一份，
   * 重启后落回 now() —— 时间戳是观测信息，不参与任何判定，不值得为它改 schema。
   */
  const stamps = new Map<string, { createdAt: number; updatedAt: number }>();

  return {
    open(input: ConversationRef): ConversationDecision {
      if (!Number.isInteger(input.generation) || input.generation < 1) {
        return deny('invalid_generation', 'generation must be a positive integer');
      }

      return store.transaction((tx): ConversationDecision => {
        const existing = store.getConversation(input.conversationId);
        if (existing === null) {
          const created: ConversationRow = {
            id: input.conversationId,
            pairingId: input.pairingId,
            principalId: input.principalId,
            generation: input.generation,
          };
          tx.saveConversation(created);
          return {
            allowed: true,
            conversation: snapshotOf(created),
            created: true,
            generationChanged: false,
          };
        }

        if (!ownedBy(existing, input)) {
          return deny('conversation_forbidden', FORBIDDEN_MESSAGE);
        }
        if (input.generation < existing.generation) {
          return deny('stale_generation', 'message belongs to a superseded generation');
        }

        const generationChanged = input.generation > existing.generation;
        if (generationChanged) {
          tx.saveConversation({ ...existing, generation: input.generation });
        }
        return {
          allowed: true,
          conversation: { ...snapshotOf(existing), generation: input.generation },
          created: false,
          generationChanged,
        };
      });
    },

    startNew(input): ConversationDecision {
      if (!Number.isInteger(input.generation) || input.generation < 1) {
        return deny('invalid_generation', 'generation must be a positive integer');
      }

      // supersede 旧会话与创建新会话必须同生共死：中途失败会留下
      // 「旧会话已断代、新会话没建起来」的黑洞，客户端两头都接不上。
      return store.transaction((tx): ConversationDecision => {
        // previousConversationId === conversationId = 「同会话提代」（waku-dm 的 /new：Waku 会话 id 不变，
        // 只把代数 +1 让旧 binding 失效、在途旧代消息变 stale）。V1 客户端从不发这种形状——
        // 它们 new 时总是铸一个新 id，所以原有「重开已有会话被拒」的语义原样保留在下面。
        if (input.previousConversationId === input.conversationId) {
          const existing = store.getConversation(input.conversationId);
          if (existing !== null) {
            if (!ownedBy(existing, input)) {
              return deny('conversation_forbidden', FORBIDDEN_MESSAGE);
            }
            const generation = tx.bumpGeneration(existing.id);
            return {
              allowed: true,
              conversation: { ...snapshotOf(existing), generation },
              created: false,
              generationChanged: true,
            };
          }
          // 还没有会话：落到下面的首次创建路径。
        }

        if (store.getConversation(input.conversationId) !== null) {
          return deny('conversation_exists', 'conversation already exists');
        }

        if (input.previousConversationId !== undefined) {
          const previous = store.getConversation(input.previousConversationId);
          if (previous !== null) {
            if (!ownedBy(previous, input)) {
              return deny('conversation_forbidden', FORBIDDEN_MESSAGE);
            }
            // +1 就够了：旧代的在途消息全部落到 stale，旧 binding 同时失效。
            tx.bumpGeneration(previous.id);
          }
        }

        const created: ConversationRow = {
          id: input.conversationId,
          pairingId: input.pairingId,
          principalId: input.principalId,
          generation: input.generation,
        };
        tx.saveConversation(created);
        return {
          allowed: true,
          conversation: snapshotOf(created),
          created: true,
          generationChanged: false,
        };
      });
    },

    authorize(input): ConversationDecision {
      const existing = store.getConversation(input.conversationId);
      if (existing === null) {
        return deny('conversation_not_found', 'conversation does not exist');
      }
      if (!ownedBy(existing, input)) {
        return deny('conversation_forbidden', FORBIDDEN_MESSAGE);
      }
      return {
        allowed: true,
        conversation: snapshotOf(existing),
        created: false,
        generationChanged: false,
      };
    },

    bindProvider(input: BindProviderInput): void {
      // 无条件写：读那侧的代数闸门负责判它还算不算数。
      // 这样"迟到一代的绑定"会明确地把当前绑定作废，而不是被静默丢弃。
      const at = now();
      const previous = stamps.get(input.conversationId);
      stamps.set(input.conversationId, {
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      });
      store.transaction((tx) =>
        tx.saveProviderBinding({
          conversationId: input.conversationId,
          agentType: input.agentType,
          providerSessionId: input.providerSessionId,
          generation: input.generation,
        }),
      );
    },

    binding(conversationId: string): SessionBinding | null {
      const row = store.getProviderBinding(conversationId);
      if (row === null) return null;
      const conversation = store.getConversation(conversationId);
      if (conversation === null) return null;
      // 同代才作数 —— 这一行就是"同 generation 只有一个有效 binding"的实现点。
      if (row.generation !== conversation.generation) return null;

      const stamp = stamps.get(conversationId);
      const at = now();
      return {
        conversationId: row.conversationId,
        agentType: row.agentType,
        providerSessionId: row.providerSessionId,
        generation: row.generation,
        createdAt: stamp?.createdAt ?? at,
        updatedAt: stamp?.updatedAt ?? at,
      };
    },
  };
}
