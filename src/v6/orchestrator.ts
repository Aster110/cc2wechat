import type { AccountData } from '../store.js';
import { sendMessage, sendTyping, getConfig } from '../wechat-api.js';
import { log, logError } from '../utils.js';
import type { Replier } from '../v5/sender/replier.js';
import type { MessageContext } from '../v5/interfaces/index.js';

import type { AgentAdapter, AgentRequest, IncomingMessage, SessionStore } from './contracts.js';

/** "正在输入"心跳间隔。微信端的 typing 状态会自己过期,慢后端(codex 一轮几分钟)必须续。 */
const TYPING_HEARTBEAT_MS = 15_000;

/**
 * 超过这个时间还没答完,先给用户一句"还在处理",免得他以为掉线了。
 *
 * 默认 60s:codex 这类后端一轮动辄半分钟起步,阈值定太低会**每条都触发**,
 * 那就不是信号而是噪音了("正在输入"心跳才是常态提示)。
 * `CC2WECHAT_ACK_MS=0` 彻底关掉。
 */
function slowAckMs(): number {
  const raw = process.env.CC2WECHAT_ACK_MS;
  if (raw == null || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/**
 * 持续发"正在输入",直到返回的 stop() 被调用。
 * ticket 必须从 getConfig 拿 —— 空 ticket 发了等于没发(v5 早期就踩在这)。
 */
function startTypingHeartbeat(account: AccountData, userId: string, contextToken: string): () => void {
  let stopped = false;
  let ticket = '';
  let timer: NodeJS.Timeout | null = null;

  const ping = (status: 1 | 2): void => {
    if (!ticket) return;
    sendTyping(account.token, userId, ticket, status, account.baseUrl).catch(() => {});
  };

  void (async () => {
    try {
      const cfg = await getConfig(account.token, userId, contextToken, account.baseUrl);
      ticket = cfg.typing_ticket ?? '';
    } catch {
      return; // 拿不到 ticket 就安静放弃,不影响正事
    }
    if (stopped || !ticket) return;
    ping(1);
    timer = setInterval(() => ping(1), TYPING_HEARTBEAT_MS);
  })();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    ping(2);
  };
}

export interface TurnResult {
  outcome: 'final' | 'error' | 'aborted';
  /** 开跑到首个 Agent 事件的毫秒数 */
  firstEventMs: number;
}

export interface OrchestratorDeps {
  account: AccountData;
  agent: AgentAdapter;
  store: SessionStore;
  replier: Replier;
  cwd: string;
  accountName?: string;
}

/**
 * 一轮的生命周期编排:typing → 组请求 → 消费 Agent 事件流 → 回复 → 收尾。
 *
 * Core 只认 contracts.ts 里那五种 AgentEvent,
 * 永远不碰 codex 的 item.completed 或 claude SDK 的原始消息 —— 协议变了只改对应 Agent。
 */
export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async runTurn(msg: IncomingMessage, signal: AbortSignal): Promise<TurnResult> {
    const { account, agent, store, replier, cwd, accountName } = this.deps;
    const startedAt = Date.now();
    let firstEventMs = -1;
    let outcome: TurnResult['outcome'] = 'aborted';

    const ctx: MessageContext = {
      text: msg.text,
      mediaFiles: msg.mediaPaths,
      userId: msg.userId,
      sessionId: msg.conversationId,
      contextToken: msg.contextToken,
      rawMessage: msg,
      account,
      cwd,
      accountName,
    };

    const stopTyping = startTypingHeartbeat(account, msg.userId, msg.contextToken);
    const ackMs = slowAckMs();
    const slowAck =
      ackMs > 0
        ? setTimeout(() => {
            sendMessage(account.token, msg.userId, '收到，正在处理…', msg.contextToken, account.baseUrl).catch(() => {});
          }, ackMs)
        : null;

    const req: AgentRequest = {
      conversationId: msg.conversationId,
      // v5 sdk-delivery 的口径:agent 侧靠这个前缀识别"这是微信来的"
      text: `[微信] ${msg.text}`,
      mediaPaths: msg.mediaPaths,
      cwd,
      binding: store.get(msg.conversationId),
    };

    try {
      for await (const event of agent.run(req, signal)) {
        if (firstEventMs < 0) firstEventMs = Date.now() - startedAt;

        switch (event.type) {
          case 'sessionChanged':
            // 立刻落盘:进程这时候被 kill 也不该丢会话绑定
            store.saveProviderSession(msg.conversationId, agent.name, event.providerSessionId);
            break;
          case 'progress':
            if (event.text) log(`[agent] ${agent.name} ${event.text}`);
            break;
          case 'final':
            outcome = 'final';
            await this.safeReply(replier, ctx, event.text);
            for (const file of event.mediaFiles ?? []) {
              await replier.replyMedia(ctx, file).catch((err) => logError(`replyMedia failed: ${String(err)}`));
            }
            break;
          case 'error':
            outcome = 'error';
            await this.safeReply(replier, ctx, `[${agent.name}] ${event.message}`);
            break;
          case 'started':
            break;
        }
      }

      if (signal.aborted && outcome === 'aborted') {
        return { outcome, firstEventMs: firstEventMs < 0 ? Date.now() - startedAt : firstEventMs };
      }

      // agent 一句话没说、也没被打断:别让用户对着空气等
      if (outcome === 'aborted') {
        outcome = 'error';
        await this.safeReply(replier, ctx, `[${agent.name}] 这轮没有任何输出`);
      }

      store.touch(msg.conversationId);
      return { outcome, firstEventMs: firstEventMs < 0 ? Date.now() - startedAt : firstEventMs };
    } catch (err) {
      if (signal.aborted) {
        return { outcome: 'aborted', firstEventMs: firstEventMs < 0 ? Date.now() - startedAt : firstEventMs };
      }
      const message = err instanceof Error ? err.message : String(err);
      logError(`turn failed: ${message}`);
      await this.safeReply(replier, ctx, `[${agent.name}] ${message}`);
      return { outcome: 'error', firstEventMs: firstEventMs < 0 ? Date.now() - startedAt : firstEventMs };
    } finally {
      if (slowAck) clearTimeout(slowAck);
      stopTyping();
    }
  }

  /** 微信发送失败(现在会因为 errcode 真的抛了)不该把一轮拖成 crash */
  private async safeReply(replier: Replier, ctx: MessageContext, text: string): Promise<void> {
    try {
      await replier.reply(ctx, text);
    } catch (err) {
      logError(`reply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
