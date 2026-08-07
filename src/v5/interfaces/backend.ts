export interface LaunchOpts {
  sessionId: string;
  cwd: string;
  resumeSessionId?: string;  // claude 的真实 session UUID，有则 resume
}

export interface ChatOpts {
  message: string;
  sessionId: string;
  cwd: string;
}

export interface PipeOpts {
  prompt: string;
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
}

export interface BackendEvent {
  type: string;
  [key: string]: unknown;
}

export interface AIBackend {
  readonly name: string;
  buildLaunchCommand(opts: LaunchOpts): string;
  chat(opts: ChatOpts): AsyncIterable<BackendEvent>;
  buildPipeCommand(opts: PipeOpts): string;
  extractResult(events: BackendEvent[]): string;
  /**
   * 丢弃该 bridge session 与后端会话的绑定，使下一条消息开全新上下文。
   * 后端自己维护会话映射时才需要实现（codex 走 thread_id 映射；claude 靠 --resume 的
   * sessionId 由 delivery 侧管理，不需要）。/new 与 /exit 都会调。
   */
  resetSession?(sessionId: string): void | Promise<void>;
}
