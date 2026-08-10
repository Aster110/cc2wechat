/**
 * v6 契约 —— 所有模块面向这里的接口开发。
 *
 * 设计定稿依据(2026-08-10,aster 拍板):
 * - 主链路 Channel → Core → Agent,单进程,无 Delivery×Backend 全排列
 * - Agent 自带执行方式,对 Core 只暴露统一的 run()/reset() + 标准事件
 * - 会话所有权统一在 SessionStore(一张表),不再散落
 * - 控制命令(/new /stop /exit)走抢占通道,不排在普通消息后面
 * - Core 永不接触 codex `item.completed` / claude SDK 原始事件——协议变化只改对应 Agent
 *
 * 改这个文件 = 改接缝,必须在 commit message 里显式说明理由。
 */

// ============ 消息 ============

/** Channel 标准化后的入站消息 */
export interface IncomingMessage {
  /** 平台消息 id,用于去重;平台没给就用内容 hash 兜底 */
  id: string;
  userId: string;
  /** deriveConversationId(accountId, userId) —— 与端口无关,换端口不丢会话 */
  conversationId: string;
  text: string;
  /** 已下载到本地的媒体文件路径 */
  mediaPaths: string[];
  contextToken: string;
  receivedAt: number;
}

/**
 * 会话身份 = 账号 + 用户,与端口/进程无关。
 * 实现:sha256(`${accountId}\n${userId}`) 取前 32 hex。
 */
export type DeriveConversationId = (accountId: string, userId: string) => string;

// ============ Agent ============

/** Agent 向 Core 汇报的标准事件——全部词表,不允许扩散原始协议 */
export type AgentEvent =
  | { type: 'started'; providerSessionId?: string }
  /** 可选进度信号(工具调用摘要等),Core 可用于日志/未来的进度转发,不直接发微信 */
  | { type: 'progress'; text?: string }
  | { type: 'final'; text: string; mediaFiles?: string[] }
  /** 后端会话 id 首次出现或变化时上报,Core 负责写入 SessionStore */
  | { type: 'sessionChanged'; providerSessionId: string }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface AgentRequest {
  conversationId: string;
  text: string;
  mediaPaths: string[];
  cwd: string;
  /** 现有绑定,null = 全新会话。Agent 从这里拿 providerSessionId 决定 create/resume */
  binding: SessionBinding | null;
}

export interface AgentHealth {
  ok: boolean;
  detail?: string;
}

export interface AgentAdapter {
  readonly name: string;
  /** 常驻型(进程/池挂着)还是一次性 spawn——健康检查与文档展示用 */
  readonly persistent: boolean;
  /**
   * 执行一轮。事件流式产出,不允许攒完整数组再吐。
   * signal abort = 用户 /stop 或超时:必须终止底层子进程/请求,然后正常 return(不 throw)。
   * 语义错误(配额/鉴权/turn.failed)优先于进程退出噪音——错误提取规则沿用 v5 的教训。
   */
  run(req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** 丢弃该会话与后端的绑定关系,下一条消息开全新上下文。不删后端自己的历史文件 */
  reset(conversationId: string): Promise<void>;
  health(): Promise<AgentHealth>;
  shutdown(): Promise<void>;
}

// ============ 会话存储 ============

export interface SessionBinding {
  conversationId: string;
  agentType: string;
  providerSessionId: string;
  /** /new 一次 +1。同 conversationId 的历史代数便于排查 */
  generation: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 原子 JSON 文件存储(临时文件 + rename),路径按 accountId 命名,与端口无关。
 * 普通消息不写盘;只有 providerSessionId 变化 / bump / drop 时写。
 */
export interface SessionStore {
  get(conversationId: string): SessionBinding | null;
  /** 首次拿到或变更后端会话 id 时调用(含 touch 语义:刷新 updatedAt) */
  saveProviderSession(conversationId: string, agentType: string, providerSessionId: string): void;
  /** 仅刷新 updatedAt(每轮完成时调,配合 idle TTL) */
  touch(conversationId: string): void;
  /** /new:generation+1,清空 providerSessionId,保留条目 */
  bump(conversationId: string): void;
  /** /exit:删除条目 */
  drop(conversationId: string): void;
  /** 清理空闲超时的绑定,返回被清理的 conversationId 列表。由 Core 周期调用 */
  expireIdle(maxIdleMs: number): string[];
}

// ============ 调度 ============

export type EnqueueResult = 'started' | 'queued' | 'rejected';

/**
 * 同 conversation 串行、全局并发槽、有界积压、可抢占。
 * - perConversation 并发恒为 1(保证上下文顺序)
 * - 全局并发默认 2(env CC2WECHAT_MAX_CONCURRENT 覆盖)
 * - 单会话积压上限默认 5,超限 rejected(调用方负责回复用户)
 * - abort() 取消正在跑的一轮(触发其 AbortSignal),队列保留
 * - clear() 清空该会话排队中的任务,返回清掉的数量
 */
export interface Scheduler {
  enqueue(conversationId: string, task: (signal: AbortSignal) => Promise<void>): EnqueueResult;
  abort(conversationId: string): boolean;
  clear(conversationId: string): number;
  /** 排队深度(不含正在跑的) */
  depth(conversationId: string): number;
  running(conversationId: string): boolean;
  /** 等待全部在跑任务结束(shutdown 用) */
  drain(): Promise<void>;
}

// ============ 观测 ============

/** 每轮固定打一行结构化日志,并入 /health 的环形缓冲(最近 20 轮) */
export interface TurnTiming {
  conversationId: string;
  agent: string;
  /** 入队到开跑的等待 */
  queueMs: number;
  /** 开跑到首个 Agent 事件 */
  firstEventMs: number;
  /** 开跑到 final/error */
  totalMs: number;
  outcome: 'final' | 'error' | 'aborted';
  endedAt: number;
}
