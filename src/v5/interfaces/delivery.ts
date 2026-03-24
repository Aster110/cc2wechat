import type { AIBackend } from './backend.js';
import type { MessageContext } from './context.js';

export interface CompatResult {
  available: boolean;
  reason?: string;
  missingDeps?: string[];
}

export interface DeliveryConfig {
  [key: string]: unknown;
}

export interface ProcessResult {
  text: string;
  mediaFiles?: string[];
  selfReplied?: boolean;
}

export interface Delivery {
  readonly name: string;
  checkCompatibility(): Promise<CompatResult>;
  initialize(config: DeliveryConfig): Promise<void>;
  deliver(ctx: MessageContext, backend: AIBackend): Promise<ProcessResult>;
  /** 关闭指定用户的会话 */
  closeSession(userId: string): Promise<void>;
  /** 创建新会话（不注入消息） */
  createSession(userId: string, backend: AIBackend, cwd: string, contextPath?: string): Promise<void>;
  shutdown(): Promise<void>;
}
