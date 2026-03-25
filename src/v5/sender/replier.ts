import type { MessageSender, MessageContext } from '../interfaces/index.js';
import { stripMarkdown } from '../shared/strip-markdown.js';

export class Replier {
  constructor(
    private sender: MessageSender,
    private opts: { maxChunkSize: number; stripMarkdown: boolean } = { maxChunkSize: 3900, stripMarkdown: true },
  ) {}

  async reply(ctx: MessageContext, text: string): Promise<void> {
    let processed = text;
    if (this.opts.stripMarkdown) {
      processed = stripMarkdown(processed);
    }

    const chunks = this.split(processed, this.opts.maxChunkSize);
    for (const chunk of chunks) {
      await this.sender.sendText(ctx.userId, chunk, ctx.contextToken);
    }
  }

  async replyMedia(ctx: MessageContext, filePath: string): Promise<void> {
    await this.sender.sendMedia(ctx.userId, filePath, ctx.contextToken);
  }

  private split(text: string, maxSize: number): string[] {
    if (text.length <= maxSize) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxSize) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxSize);
      if (splitAt <= 0) splitAt = maxSize;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
  }
}
