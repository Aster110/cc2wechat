import { execSync } from 'node:child_process';
import type { Delivery, CompatResult, DeliveryConfig, ProcessResult, AIBackend, MessageContext } from '../../interfaces/index.js';

export class PipeDelivery implements Delivery {
  readonly name = 'pipe';

  async checkCompatibility(): Promise<CompatResult> {
    try {
      execSync('which claude', { encoding: 'utf-8' });
      return { available: true };
    } catch {
      return { available: false, reason: 'claude CLI not in PATH' };
    }
  }

  async initialize(_config: DeliveryConfig): Promise<void> {}

  async deliver(ctx: MessageContext, backend: AIBackend): Promise<ProcessResult> {
    const cmd = backend.buildPipeCommand({
      prompt: ctx.text,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
    });
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: ctx.cwd,
    }).trim();
    return { text: result || '[No response]', selfReplied: false };
  }

  async closeSession(_userId: string): Promise<void> {}
  async createSession(_userId: string, _backend: AIBackend, _cwd: string): Promise<void> {}
  async shutdown(): Promise<void> {}
}
