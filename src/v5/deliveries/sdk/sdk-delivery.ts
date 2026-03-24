import type { Delivery, CompatResult, DeliveryConfig, ProcessResult, AIBackend, BackendEvent, MessageContext } from '../../interfaces/index.js';

export class SDKDelivery implements Delivery {
  readonly name = 'sdk';

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

  async closeSession(_userId: string): Promise<void> {}
  async createSession(_userId: string, _backend: AIBackend, _cwd: string): Promise<void> {}
  async shutdown(): Promise<void> {}
}
