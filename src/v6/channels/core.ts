import { log, logError } from '../../utils.js';

import type { AgentAdapter, Scheduler, SessionStore, TurnTiming } from '../contracts.js';
import { tryHandleCommand } from '../commands.js';
import { startIdleSweeper, turnTimeoutMs, type TurnRing } from '../poller.js';
import { ChannelOrchestrator } from './orchestrator.js';
import { isTurnAware, type ChannelAdapter, type ChannelMessage, type ChannelReply } from './contracts.js';
import type { ConversationService } from './conversation-service.js';

/**
 * Core —— 不认识任何具体壳、也不认识任何具体后端的那一层。
 *
 * 职责就三件:
 * 1. **Ingress**:去重 → 控制命令抢占(必须在入队之前) → 入站日志 → 交给调度器
 * 2. **会话身份**:向 ConversationService 要 conversationId,壳无权自己造
 * 3. **Delivery**:Agent 的 final/error 回给**来源通道**,前缀用壳自报的 sourceLabel
 *
 * 调度器、SessionStore、TurnRing、idle sweeper 全部复用现有实现(一行没改)。
 */

const DEDUPE_CAPACITY = 200;

export interface ChannelHealthEntry {
  name: string;
  ok: boolean;
  detail?: string;
  lastOkAt?: number;
}

export interface ChannelCoreDeps {
  channels: ChannelAdapter[];
  agent: AgentAdapter;
  scheduler: Scheduler;
  /** noteUser 是 FileSessionStore 的补充能力(legacy 迁移用),没有也能跑 */
  store: SessionStore & { noteUser?(conversationId: string, userId: string): void };
  conversations: ConversationService;
  turns: TurnRing;
  cwd: string;
  dedupeCapacity?: number;
}

export class ChannelCore {
  private readonly orchestrator: ChannelOrchestrator;
  private readonly capacity: number;
  private seen = new Set<string>();
  private stopSweeper: (() => void) | null = null;

  constructor(private deps: ChannelCoreDeps) {
    this.capacity = deps.dedupeCapacity ?? DEDUPE_CAPACITY;
    this.orchestrator = new ChannelOrchestrator({ agent: deps.agent, store: deps.store, cwd: deps.cwd });
  }

  async start(): Promise<void> {
    this.stopSweeper = startIdleSweeper({ store: this.deps.store, agent: this.deps.agent });

    for (const channel of this.deps.channels) {
      await channel.start({
        deliver: (msg) => this.deliver(channel, msg),
        // 纯查询:壳可以在下载媒体这类昂贵动作前先问一句。登记仍然只发生在 ingest 里。
        isDuplicate: (id) => this.seen.has(`${channel.name}:${id}`),
      });
      log(`Channel 已挂载: ${channel.name} (${channel.descriptor.sourceLabel})`);
    }
  }

  async stop(): Promise<void> {
    this.stopSweeper?.();
    this.stopSweeper = null;
    for (const channel of this.deps.channels) {
      try {
        await channel.stop();
      } catch (err) {
        logError(`channel ${channel.name} stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  channelHealth(): ChannelHealthEntry[] {
    return this.deps.channels.map((c) => {
      try {
        return { name: c.name, ...c.health() };
      } catch (err) {
        return { name: c.name, ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  /** /health 用 */
  turnsSnapshot(): TurnTiming[] {
    return this.deps.turns.list();
  }

  /** 壳 → Core 的唯一入口。**同步返回**:壳的收信循环绝不能等后端 */
  deliver(channel: ChannelAdapter, msg: ChannelMessage): void {
    void this.ingest(channel, msg).catch((err) => {
      logError(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ---------------------------------------------------------------------

  private async ingest(channel: ChannelAdapter, msg: ChannelMessage): Promise<void> {
    const key = `${channel.name}:${msg.id}`;
    if (this.seen.has(key)) {
      log(`skip duplicate message ${key}`);
      return;
    }
    this.remember(key);

    const { scheduler, store, agent, turns, conversations } = this.deps;
    const conversationId = conversations.idFor(msg);
    // legacy 会话迁移要知道这条会话背后是哪个用户(微信侧 endpointId 就是 userId)
    store.noteUser?.(conversationId, msg.endpointId);

    const send = (reply: ChannelReply): Promise<void> => channel.send(msg.endpointId, reply);
    const replyText = (text: string): Promise<void> => send({ text });

    log(`<- ${msg.endpointId.slice(0, 10)}...: ${msg.text.slice(0, 50)}`);

    // 抢占通道:控制命令**在入队之前**处理。
    // 排在长任务后面的 /stop 等于没有 /stop —— v5 就是这个毛病。
    const handled = await tryHandleCommand(msg.text, {
      conversationId,
      reply: replyText,
      scheduler,
      store,
      agent,
    }).catch((err) => {
      logError(`command failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    });
    if (handled) return;

    const enqueuedAt = Date.now();
    const result = scheduler.enqueue(conversationId, async (signal) => {
      const queueMs = Date.now() - enqueuedAt;
      const startedAt = Date.now();
      const timeoutMs = turnTimeoutMs();
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              logError(`turn timeout after ${timeoutMs}ms, aborting conv=${conversationId.slice(0, 8)}`);
              scheduler.abort(conversationId);
            }, timeoutMs)
          : null;

      // 通道级 UX(微信的 typing / 慢提示)。Core 只保证"开始通知一次、结束一定通知一次"
      const endTurn = isTurnAware(channel) ? channel.beginTurn(msg) : () => {};

      let outcome: TurnTiming['outcome'] = 'error';
      let firstEventMs = -1;
      try {
        const turn = await this.orchestrator.runTurn(
          { msg, conversationId, sourceLabel: channel.descriptor.sourceLabel, send },
          signal,
        );
        outcome = turn.outcome;
        firstEventMs = turn.firstEventMs;
      } catch (err) {
        logError(`runTurn failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
        try {
          endTurn();
        } catch (err) {
          logError(`channel ${channel.name} endTurn failed: ${String(err)}`);
        }
      }

      const timing: TurnTiming = {
        conversationId,
        agent: agent.name,
        queueMs,
        firstEventMs,
        totalMs: Date.now() - startedAt,
        outcome,
        endedAt: Date.now(),
      };
      turns.push(timing);
      log(
        `[turn] conv=${conversationId.slice(0, 8)} agent=${agent.name} queue=${timing.queueMs}ms ` +
          `first=${timing.firstEventMs}ms total=${timing.totalMs}ms outcome=${timing.outcome}`,
      );

      if (timedOut) {
        await replyText(
          `这轮超过 ${Math.round(timeoutMs / 60_000)} 分钟没跑完，已中止。把任务拆小一点再试。`,
        ).catch(() => {});
      }
    });

    if (result === 'rejected') {
      const depth = scheduler.depth(conversationId);
      await replyText(`⏳ 前面还有 ${depth} 条在排队，这条先不处理了，稍后再发`).catch(() => {});
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > this.capacity) {
      // Set 保插入序,删最老的那个
      const oldest = this.seen.values().next().value as string | undefined;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
