import type { Delivery, AIBackend, MessageContext, ProcessResult } from '../interfaces/index.js';
import type { Replier } from '../sender/replier.js';

export class Router {
  constructor(
    private delivery: Delivery,
    private backend: AIBackend,
    private replier: Replier,
  ) {}

  async handle(ctx: MessageContext): Promise<void> {
    try {
      const result: ProcessResult = await this.delivery.deliver(ctx, this.backend);

      if (!result.selfReplied && result.text) {
        await this.replier.reply(ctx, result.text);
      }
      if (result.mediaFiles?.length) {
        for (const file of result.mediaFiles) {
          await this.replier.replyMedia(ctx, file);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.replier.reply(ctx, `[Error] ${message}`);
    }
  }
}
