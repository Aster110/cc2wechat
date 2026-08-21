import type { MessageSender, MessageContext } from '../interfaces/index.js';

/** 微信/私聊都不渲染 markdown：去掉围栏、粗体与标题井号。纯函数，Replier 与 waku-dm 通道共用。 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) => {
      return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    })
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}

/** 按**字符**切片：优先在换行处断，断不开就硬切。纯函数，Replier 与 waku-dm 通道共用。 */
export function splitText(text: string, maxSize: number): string[] {
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

export class Replier {
  constructor(
    private sender: MessageSender,
    private opts: { maxChunkSize: number; stripMarkdown: boolean } = { maxChunkSize: 3900, stripMarkdown: true },
  ) {}

  async reply(ctx: MessageContext, text: string): Promise<void> {
    let processed = text;
    if (this.opts.stripMarkdown) {
      processed = this.stripMarkdown(processed);
    }

    const chunks = this.split(processed, this.opts.maxChunkSize);
    for (const chunk of chunks) {
      await this.sender.sendText(ctx.userId, chunk, ctx.contextToken);
    }
  }

  async replyMedia(ctx: MessageContext, filePath: string): Promise<void> {
    await this.sender.sendMedia(ctx.userId, filePath, ctx.contextToken);
  }

  private stripMarkdown(text: string): string {
    return stripMarkdown(text);
  }

  private split(text: string, maxSize: number): string[] {
    return splitText(text, maxSize);
  }
}
