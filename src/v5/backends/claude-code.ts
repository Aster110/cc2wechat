import type { AIBackend, LaunchOpts, ChatOpts, PipeOpts, BackendEvent } from '../interfaces/index.js';

export class ClaudeCodeBackend implements AIBackend {
  readonly name = 'claude-code';

  buildLaunchCommand(opts: LaunchOpts): string {
    if (opts.resumeSessionId) {
      // 有真实的 claude session ID → resume
      return `cd ${opts.cwd} && claude --resume ${opts.resumeSessionId} --dangerously-skip-permissions`;
    }
    // 新用户 → 启动新 session；claude 退出后 exit 关闭窗口
    return `cd ${opts.cwd} && claude --dangerously-skip-permissions; exit`;
  }

  async *chat(opts: ChatOpts): AsyncIterable<BackendEvent> {
    const { OfficialAdapter } = await import('@aster110/cc-core');
    const adapter = new OfficialAdapter();
    for await (const event of adapter.chat({
      message: opts.message,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
    })) {
      yield event as BackendEvent;
    }
  }

  buildPipeCommand(opts: PipeOpts): string {
    const prompt = JSON.stringify(opts.prompt);
    return `claude -p ${prompt} --resume ${opts.sessionId} --output-format text --permission-mode bypassPermissions`;
  }

  extractResult(events: BackendEvent[]): string {
    for (const event of [...events].reverse()) {
      if (event.type === 'result' && typeof event.result === 'string') return event.result;
      if (event.type === 'assistant') {
        const msg = event.message as { content?: unknown } | undefined;
        if (typeof msg?.content === 'string') return msg.content;
        if (Array.isArray(msg?.content)) {
          return (msg!.content as Array<{ type?: string; text?: string }>)
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text)
            .join('\n');
        }
      }
    }
    return '';
  }
}
