import { userIdToSessionUUID } from '../../../utils.js';
import type { Delivery, CompatResult, DeliveryConfig, ProcessResult, AIBackend, BackendEvent, MessageContext } from '../../interfaces/index.js';

export class SDKDelivery implements Delivery {
  readonly name = 'sdk';
  // 这条投递没有进程可关，会话状态全在后端手里（如 codex 的 thread 映射）。
  // 记住最近用过的 backend，好让 /new、/exit 能通知它丢弃绑定。
  private lastBackend: AIBackend | null = null;

  async checkCompatibility(): Promise<CompatResult> {
    try {
      await import('@aster110/cc-core');
      return { available: true };
    } catch {
      return { available: false, reason: 'cc-core not installed', missingDeps: ['@aster110/cc-core'] };
    }
  }

  async initialize(_config: DeliveryConfig): Promise<void> {}

  async deliver(ctx: MessageContext, backend: AIBackend): Promise<ProcessResult> {
    this.lastBackend = backend;
    const events: BackendEvent[] = [];
    for await (const event of backend.chat({
      message: `[微信] ${ctx.text}`,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
    })) {
      events.push(event);
    }
    const text = backend.extractResult(events);
    return { text: text || '[No response]', selfReplied: false };
  }

  async closeSession(userId: string): Promise<void> {
    await this.lastBackend?.resetSession?.(userIdToSessionUUID(userId));
  }

  async createSession(userId: string, backend: AIBackend, _cwd: string): Promise<void> {
    this.lastBackend = backend;
    await backend.resetSession?.(userIdToSessionUUID(userId));
  }

  async shutdown(): Promise<void> {}
}
