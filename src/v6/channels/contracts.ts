/**
 * Channel 轴契约 —— **冻结接缝,改动需在 commit message 说明理由**。
 *
 * 背景(2026-08-27 大统一网关方案):v6 的 `Channel → Core → Agent` 里 Agent 轴
 * 已成型(contracts.ts 的 AgentAdapter + 4 实现),Channel 轴却把微信硬焊在 Core 里。
 * 这个文件是 Channel 轴的那半张契约:壳自己实现收发,Core 一个具体壳都不认识。
 *
 * 三条不许含糊的语义:
 * 1. **会话主权不在壳里**。ChannelMessage 里没有 conversationId —— 只有
 *    ConversationService 能把 (channel, endpointId, threadKey) 映射成会话 id。
 *    壳自己造会话 id = 会话身份分叉,微信现网文件立刻失忆。
 * 2. **endpointId 对 Core 是不透明字符串**。微信是 userId、web 是浏览器给的名字、
 *    mesh 是节点名 —— Core 不解释,只当键用。
 * 3. **「[微信]」这类前缀归壳自报**(descriptor.sourceLabel),Core 注入到 AgentRequest.text。
 *    Agent 侧靠这个前缀识别来源,所以它是**语义**不是装饰。
 *
 * 允许的演化:**纯 additive 的可选扩展**(如下面的 ChannelTurnAware)。
 * 上面五个方法 + descriptor 的名字与签名不许改 —— 另一支团队正按这份形状写 MeshChannel。
 */

/** 壳标准化后交给 Core 的入站消息。注意:没有 conversationId(见文件头第 1 条)。 */
export interface ChannelMessage {
  /** 渠道内消息 id,去重键。平台没给可靠 id 时由壳自己兜底(内容 hash 之类) */
  id: string;
  /** 'wechat' | 'web' | 'mesh' | ... 与 ChannelAdapter.name 同值 */
  channel: string;
  /** 对端标识,Core 眼里是不透明字符串 */
  endpointId: string;
  /** 同一对端下的子会话(群里的话题、web 的多标签页…)。不给 = 单线 */
  threadKey?: string;
  text: string;
  /** 已下载到本地的媒体文件路径 */
  mediaPaths: string[];
  receivedAt: number;
}

/** Core 交回壳的一条回复 */
export interface ChannelReply {
  text: string;
  mediaFiles?: string[];
}

/** 壳的健康快照。**同步**返回 —— /health 不能因为壳卡住就一起卡住 */
export interface ChannelHealth {
  ok: boolean;
  detail?: string;
  /** 最近一次确认与平台通得上的时刻(epoch ms) */
  lastOkAt?: number;
}

/**
 * start() 拿到的上下文。
 *
 * `deliver` 是壳 → Core 的唯一入口,**同步返回**:Core 内部自己排队,
 * 壳的收信循环绝不能等后端(微信那头会直接显示"暂时无法连接")。
 *
 * `isDuplicate` 是**可选的**纯查询(peek,不登记):壳可以在下载媒体这类昂贵动作
 * 之前先问一句"这条我早见过没"。Core 仍是去重的唯一权威 —— 不问也不会重复处理,
 * 只是会白下载一次媒体。
 */
export interface ChannelStartContext {
  deliver(msg: ChannelMessage): void;
  isDuplicate?(id: string): boolean;
}

/** 壳的自我介绍。Core 只从这里知道"这条消息该打什么来源前缀" */
export interface ChannelDescriptor {
  /** 注入 AgentRequest.text 的前缀,如 '[微信]' / '[web]'(不带尾随空格,Core 负责拼) */
  sourceLabel: string;
}

export interface ChannelAdapter {
  readonly name: string;
  /** 开始收信。**立刻 resolve**,收信循环在后台跑 —— 别在这里 await 整个生命周期 */
  start(ctx: ChannelStartContext): Promise<void>;
  send(endpointId: string, reply: ChannelReply): Promise<void>;
  health(): ChannelHealth;
  stop(): Promise<void>;
  descriptor: ChannelDescriptor;
}

// ---------------------------------------------------------------------------
// 可选扩展(纯 additive,鸭子类型)
// ---------------------------------------------------------------------------

/**
 * 通道级 turn 生命周期。
 *
 * 微信要在一轮开始时发"正在输入"心跳、超过 60s 补一句"收到,正在处理…",
 * 结束时把 typing 状态收回去 —— 这些是**微信的 UX**,不是 Core 的职责。
 * 实现了这个接口的壳,Core 会在一轮开跑时调 beginTurn,拿返回的函数在收尾时调。
 *
 * 鸭子类型判断(而不是 instanceof / 必填方法)是 main.ts `isHttpAttachable` 的先例:
 * 想要就自己实现,不想要的壳一行不用写。
 */
export interface ChannelTurnAware {
  /** 返回"这轮结束"回调。Core 保证一定会调它(finally 里) */
  beginTurn(msg: ChannelMessage): () => void;
}

export function isTurnAware(c: unknown): c is ChannelTurnAware {
  return !!c && typeof (c as ChannelTurnAware).beginTurn === 'function';
}
