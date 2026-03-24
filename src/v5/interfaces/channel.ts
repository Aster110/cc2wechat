export interface MessageSender {
  sendText(to: string, text: string, contextToken: string): Promise<void>;
  sendMedia(to: string, filePath: string, contextToken: string): Promise<void>;
}

export interface MessageReceiver {
  readonly name: string;
  start(handler: (msg: unknown, account: unknown) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
