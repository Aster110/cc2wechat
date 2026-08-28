import { log, logError } from '../../utils.js';

import type { AgentAdapter, AgentRequest, SessionStore } from '../contracts.js';
import type { TurnResult } from '../orchestrator.js';
import type { ChannelMessage, ChannelReply } from './contracts.js';

/**
 * 一轮的编排 —— 通道无关版。
 *
 * 与 v6/orchestrator.ts(微信版)的差别只有一处:**这里没有微信**。
 * typing 心跳、慢提示、`[微信]` 前缀原来硬编码在那边,现在:
 * - typing / 慢提示 → 归壳自己(ChannelTurnAware.beginTurn)
 * - 前缀 → 壳自报的 descriptor.sourceLabel,由这里注入 AgentRequest.text
 *
 * Core 只认 contracts.ts 里那五种 AgentEvent,永远不碰 codex 的 item.completed
 * 或 claude SDK 的原始消息 —— 协议变了只改对应 Agent。
 */

export interface ChannelTurnInput {
  msg: ChannelMessage;
  conversationId: string;
  /** 来源前缀,如 '[微信]';agent 侧靠它识别"这是哪来的" */
  sourceLabel: string;
  /** 回到来源通道的那根线 */
  send(reply: ChannelReply): Promise<void>;
}

export interface ChannelOrchestratorDeps {
  agent: AgentAdapter;
  store: SessionStore;
  cwd: string;
}

export class ChannelOrchestrator {
  constructor(private deps: ChannelOrchestratorDeps) {}

  async runTurn(input: ChannelTurnInput, signal: AbortSignal): Promise<TurnResult> {
    const { agent, store, cwd } = this.deps;
    const { msg, conversationId, sourceLabel, send } = input;

    const startedAt = Date.now();
    let firstEventMs = -1;
    let outcome: TurnResult['outcome'] = 'aborted';

    const req: AgentRequest = {
      conversationId,
      // v5 sdk-delivery 的口径:agent 侧靠这个前缀识别消息来源
      text: `${sourceLabel} ${msg.text}`,
      mediaPaths: msg.mediaPaths,
      cwd,
      binding: store.get(conversationId),
    };

    try {
      for await (const event of agent.run(req, signal)) {
        if (firstEventMs < 0) firstEventMs = Date.now() - startedAt;

        switch (event.type) {
          case 'sessionChanged':
            // 立刻落盘:进程这时候被 kill 也不该丢会话绑定
            store.saveProviderSession(conversationId, agent.name, event.providerSessionId);
            break;
          case 'progress':
            if (event.text) log(`[agent] ${agent.name} ${event.text}`);
            break;
          case 'final':
            outcome = 'final';
            await this.safeSend(send, { text: event.text, mediaFiles: event.mediaFiles });
            break;
          case 'error':
            outcome = 'error';
            await this.safeSend(send, { text: `[${agent.name}] ${event.message}` });
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
        await this.safeSend(send, { text: `[${agent.name}] 这轮没有任何输出` });
      }

      store.touch(conversationId);
      return { outcome, firstEventMs: firstEventMs < 0 ? Date.now() - startedAt : firstEventMs };
    } catch (err) {
      if (signal.aborted) {
        return { outcome: 'aborted', firstEventMs: firstEventMs < 0 ? Date.now() - startedAt : firstEventMs };
      }
      const message = err instanceof Error ? err.message : String(err);
      logError(`turn failed: ${message}`);
      await this.safeSend(send, { text: `[${agent.name}] ${message}` });
      return { outcome: 'error', firstEventMs: firstEventMs < 0 ? Date.now() - startedAt : firstEventMs };
    }
  }

  /** 通道发送失败(微信 errcode 会真的抛)不该把一轮拖成 crash */
  private async safeSend(send: (reply: ChannelReply) => Promise<void>, reply: ChannelReply): Promise<void> {
    try {
      await send(reply);
    } catch (err) {
      logError(`reply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
