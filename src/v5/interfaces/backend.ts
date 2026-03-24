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
}
