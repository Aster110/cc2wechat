/**
 * GatewayOrchestrator：把「一条已授权的 TurnJob」变成「Agent 真跑一轮 + 出站回复落库」。
 *
 * 架构 §9 running→final/error、§10 stop/new/resume、§11 每 pairing 限额、
 * §12 健康面、§13 故障恢复。
 *
 * 五条冻结的语义：
 *
 * 1. **每 pairing 串行**（§11 同时执行 turn 数默认 1），不同 pairing 并行。
 *    一个人的两条消息抢同一个工作区 = 互相踩脚。
 * 2. **stop 走抢占通道**：它不排在普通队列后面，直接 abort 正在跑的那一轮。
 *    排队式的 stop 等于"等它跑完再停"，那还停什么。
 * 3. **new 提升代数**：abort 当前 turn、清队列、断旧 provider binding、回 ack。
 * 4. **拒绝要有回音，但只对容量/生命周期类**（queue_full / draining / endpoint_disabled）。
 *    鉴权类拒绝一律静默 —— 不给未授权者任何存在性反馈。
 * 5. **崩溃不自动重跑**：running 的 turn 重启后标 interrupted 就完了。
 *    它可能已经改过代码、发过消息、删过文件，重放一次比丢一次危险得多。
 */
import type { AgentEvent } from '../../v6/contracts.js';
import { mergeAttachments, parseAttachmentMarkers } from './attachments.js';
import type { MailboxKind, SecurePayload } from '../contracts/envelope.js';
import type { EndpointStatus, RunnerDescriptor } from '../contracts/runner.js';
import { isGatewayError } from '../contracts/validation.js';
import type { AgentEndpointRegistry } from '../runners/registry.js';
import type { GatewayStore } from '../state/sqlite-store.js';
import type { ConversationService } from './conversation-service.js';

// ---------------------------------------------------------------------------
// 派单契约（ingress 是唯一调用方，orchestrator 是唯一实现）
// ---------------------------------------------------------------------------

export interface TurnJob {
  pairingId: string;
  principalId: string;
  endpointId: string;
  routeId: string;
  keyVersion: number;
  conversationId: string;
  generation: number;
  messageId: string;
  text: string;
  clientSeq: number;
  receivedAt: number;
  /** 通道已下载好的本机媒体路径；缺省空数组（V1 加密信箱没有媒体）。 */
  mediaPaths?: string[];
}

export interface ControlCommand {
  op: 'stop' | 'new' | 'resume';
  pairingId: string;
  principalId: string;
  endpointId: string;
  routeId: string;
  keyVersion: number;
  conversationId: string;
  generation: number;
  messageId: string;
  receivedAt: number;
  targetTurnId?: string;
  previousConversationId?: string;
}

export type SubmitResult =
  | { status: 'started'; turnId: string }
  | { status: 'queued'; depth: number; turnId: string }
  | { status: 'rejected'; code: string };

export type ControlResult =
  | { status: 'ok'; cleared?: number; generation?: number }
  | { status: 'noop' }
  | { status: 'rejected'; code: string };

export interface TurnDispatcher {
  submitTurn(job: TurnJob): Promise<SubmitResult>;
  control(command: ControlCommand): Promise<ControlResult>;
}

export type TurnOutcome = 'final' | 'error' | 'aborted' | 'interrupted';

/** 每轮收尾时交给观测面的一行计时（`[turn] conv= agent= queue= first= total= outcome=` 的数据源）。 */
export interface TurnTiming {
  turnId: string;
  conversationId: string;
  pairingId: string;
  agentType: string;
  /** 收到到开跑的等待。 */
  queueMs: number;
  /** 开跑到首个 Agent 事件；一个事件都没有时为 -1。 */
  firstEventMs: number;
  totalMs: number;
  outcome: TurnOutcome;
  endedAt: number;
}

export interface GatewayHealth {
  core: { ok: boolean };
  runner: { nodeId: string; ok: boolean };
  endpoints: Array<{ id: string; ok: boolean; status: EndpointStatus }>;
  queues: { running: number; queued: number };
  lastTurn: { outcome: TurnOutcome; totalMs: number } | null;
}

/** 回环回复口用来推断"当前是哪条会话"：正在跑的 turn 的会话清单。 */
export interface RunningTurnSummary {
  turnId: string;
  conversationId: string;
  pairingId: string;
  routeId: string;
  keyVersion: number;
}

export interface GatewayOrchestrator extends TurnDispatcher {
  /** 启动时调用一次：把上次崩溃留下的 running turn 标成 interrupted，不重跑。 */
  recover(): { interrupted: number };
  /** 正在跑的 turn（回环回复口据此推断默认会话；多于一条就必须显式指定）。 */
  runningTurns(): RunningTurnSummary[];
  /** SIGTERM 语义：不再接新 turn，等当前 turn 收尾。 */
  drain(): Promise<void>;
  health(): Promise<GatewayHealth>;
}

/** delivery 的窄投影：编排层只往外发，不管重投。 */
export interface OrchestratorDelivery {
  publish(input: {
    pairingId: string;
    routeId: string;
    keyVersion: number;
    kind: MailboxKind;
    payload: SecurePayload;
  }): Promise<{ messageId: string; receipt: unknown }>;
}

export interface GatewayOrchestratorOptions {
  store: GatewayStore;
  registry: Pick<AgentEndpointRegistry, 'resolve' | 'health'>;
  conversations: ConversationService;
  delivery: OrchestratorDelivery;
  now(): number;
  newTurnId(): string;
  queueCap?: number;
  /** 观测钩子：每轮收尾调一次（组装层拿它打 `[turn]` 日志）。抛错不影响 turn 收尾。 */
  onTurnFinished?: (timing: TurnTiming) => void;
}

/** 单会话积压上限，沿用 v6 的口径。满了就明确拒，不做无限缓冲。 */
export const DEFAULT_QUEUE_CAP = 5;

// ---------------------------------------------------------------------------

interface QueuedTurn {
  turnId: string;
  job: TurnJob;
}

interface RunningTurn extends QueuedTurn {
  controller: AbortController;
  startedAt: number;
}

interface PairingState {
  running: RunningTurn | null;
  queue: QueuedTurn[];
}

function codeOf(error: unknown): string {
  if (isGatewayError(error)) return error.code;
  return 'internal_error';
}

/** Runner 的能力表里带着 `agent:<name>`，binding 记的就是这个名字。 */
function agentTypeOf(descriptor: RunnerDescriptor): string {
  for (const capability of descriptor.capabilities) {
    if (capability.startsWith('agent:')) return capability.slice('agent:'.length);
  }
  return descriptor.runnerId;
}

export function createGatewayOrchestrator(
  options: GatewayOrchestratorOptions,
): GatewayOrchestrator {
  const { store, registry, conversations, delivery, now } = options;
  const queueCap = options.queueCap ?? DEFAULT_QUEUE_CAP;

  const states = new Map<string, PairingState>();
  const inflight = new Set<Promise<void>>();
  let draining = false;
  let lastTurn: { outcome: TurnOutcome; totalMs: number } | null = null;

  function stateFor(pairingId: string): PairingState {
    const existing = states.get(pairingId);
    if (existing !== undefined) return existing;
    const created: PairingState = { running: null, queue: [] };
    states.set(pairingId, created);
    return created;
  }

  function publish(job: TurnJob, kind: MailboxKind, payload: SecurePayload): Promise<unknown> {
    return delivery.publish({
      pairingId: job.pairingId,
      routeId: job.routeId,
      keyVersion: job.keyVersion,
      kind,
      payload,
    });
  }

  /** 容量/生命周期类拒绝要让玩家知道，否则他只看到"消息发出去了然后没下文"。 */
  async function publishRejection(job: TurnJob, code: string): Promise<void> {
    await publish(job, 'error', {
      type: 'error',
      code,
      conversationId: job.conversationId,
      replyTo: job.messageId,
    });
  }

  /**
   * turn 收尾。**吞掉存储异常**：这段跑在 finally 里，而它最常见的失败场景是
   * "库已经被关了/进程正在退出"——那时候再抛一个未捕获的 rejection 只会盖住真正的原因。
   */
  function finishTurn(
    running: RunningTurn,
    outcome: TurnOutcome,
    agentType: string,
    firstEventAt: number | null,
  ): void {
    const endedAt = now();
    lastTurn = { outcome, totalMs: endedAt - running.startedAt };
    try {
      store.transaction((tx) =>
        tx.finishTurn(running.turnId, outcome === 'final' || outcome === 'error' ? 'completed' : 'interrupted', endedAt),
      );
    } catch {
      /* 收尾写不进去就算了：turn 的真相由崩溃恢复那条路补（running → interrupted） */
    }
    if (options.onTurnFinished !== undefined) {
      try {
        options.onTurnFinished({
          turnId: running.turnId,
          conversationId: running.job.conversationId,
          pairingId: running.job.pairingId,
          agentType,
          queueMs: Math.max(0, running.startedAt - running.job.receivedAt),
          firstEventMs: firstEventAt === null ? -1 : firstEventAt - running.startedAt,
          totalMs: endedAt - running.startedAt,
          outcome,
          endedAt,
        });
      } catch {
        /* 观测钩子不许把 turn 收尾弄挂 */
      }
    }
  }

  async function executeTurn(state: PairingState, running: RunningTurn): Promise<void> {
    const { job } = running;
    let outcome: TurnOutcome = 'aborted';
    let agentType = 'unknown';
    let firstEventAt: number | null = null;

    try {
      // 派活时再解析一次 endpoint：从入队到轮到它，中间可能已经被 disable 了。
      const { endpoint, runner } = registry.resolve(job.endpointId);
      agentType = agentTypeOf(runner.descriptor);

      const stream = runner.run(
        endpoint,
        {
          conversationId: job.conversationId,
          turnId: running.turnId,
          text: job.text,
          // 入站媒体一路贯通到 Agent：写死 [] 等于图片下载完就扔，codex 永远看不到。
          mediaPaths: job.mediaPaths ?? [],
        },
        running.controller.signal,
      );

      for await (const event of stream) {
        if (firstEventAt === null) firstEventAt = now();
        await handleAgentEvent(job, agentType, event);
        if (event.type === 'final') outcome = 'final';
        else if (event.type === 'error') outcome = 'error';
      }

      if (outcome === 'aborted' && !running.controller.signal.aborted) {
        // 流干净地结束却没给结论：当成一次失败，别让玩家等一个不会来的 final。
        outcome = 'error';
        await publish(job, 'error', {
          type: 'error',
          code: 'agent_no_result',
          conversationId: job.conversationId,
          replyTo: job.messageId,
        });
      }
    } catch (error) {
      outcome = 'error';
      try {
        await publish(job, 'error', {
          type: 'error',
          code: codeOf(error),
          conversationId: job.conversationId,
          replyTo: job.messageId,
        });
      } catch {
        /* 连错误都发不出去（通道也挂了）：留给 outbox 重投与健康面去暴露 */
      }
    } finally {
      finishTurn(running, outcome, agentType, firstEventAt);
      state.running = null;
      pump(state);
    }
  }

  async function handleAgentEvent(
    job: TurnJob,
    agentType: string,
    event: AgentEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'started':
        if (event.providerSessionId !== undefined) {
          conversations.bindProvider({
            conversationId: job.conversationId,
            generation: job.generation,
            agentType,
            providerSessionId: event.providerSessionId,
          });
        }
        return;

      case 'sessionChanged':
        conversations.bindProvider({
          conversationId: job.conversationId,
          generation: job.generation,
          agentType,
          providerSessionId: event.providerSessionId,
        });
        return;

      case 'progress':
        await publish(job, 'progress', {
          type: 'progress',
          conversationId: job.conversationId,
          replyTo: job.messageId,
          stage: 'running',
          ...(event.text === undefined ? {} : { text: event.text }),
        });
        return;

      case 'final': {
        // Agent 只会说话：附件靠正文里的 `[[send-…]]` 标记 + 它自己产出的 mediaFiles 表达。
        // 解析放这里（Core），通道拿到的是已经归一好的清单——词法不会在两条链路上分叉。
        const parsed = parseAttachmentMarkers(event.text);
        const attachments = mergeAttachments(event.mediaFiles, parsed.attachments);
        await publish(job, 'final', {
          type: 'final',
          conversationId: job.conversationId,
          replyTo: job.messageId,
          text: parsed.text,
          ...(attachments.length === 0 ? {} : { attachments }),
        });
        return;
      }

      case 'error':
        await publish(job, 'error', {
          type: 'error',
          code: event.code,
          message: event.message,
          conversationId: job.conversationId,
          replyTo: job.messageId,
        });
        return;
    }
  }

  function beginTurn(state: PairingState, entry: QueuedTurn): void {
    const running: RunningTurn = {
      ...entry,
      controller: new AbortController(),
      startedAt: now(),
    };
    // turn 行在开跑那一刻落库，不是入队那一刻：排队中的活没碰过 Agent，
    // 崩溃后不该被算成"跑了一半"。
    store.transaction((tx) =>
      tx.startTurn({
        turnId: running.turnId,
        conversationId: running.job.conversationId,
        pairingId: running.job.pairingId,
        messageId: running.job.messageId,
        startedAt: running.startedAt,
      }),
    );
    state.running = running;

    const promise = executeTurn(state, running).finally(() => {
      inflight.delete(promise);
    });
    inflight.add(promise);
  }

  function pump(state: PairingState): void {
    if (state.running !== null) return;
    const next = state.queue.shift();
    if (next === undefined) return;
    if (draining) {
      // 关机途中不再开新活，但也不静默吞：明确告诉玩家这条没跑。
      void publishRejection(next.job, 'draining').catch(() => undefined);
      return;
    }
    beginTurn(state, next);
  }

  return {
    async submitTurn(job: TurnJob): Promise<SubmitResult> {
      if (draining) {
        await publishRejection(job, 'draining');
        return { status: 'rejected', code: 'draining' };
      }

      try {
        registry.resolve(job.endpointId);
      } catch (error) {
        const code = codeOf(error);
        await publishRejection(job, code);
        return { status: 'rejected', code };
      }

      // 归属与代数：编排层独立判一次，不只靠 ingress ——
      // 这一层还会被 CLI / 未来的其他入口调用。
      const decision = conversations.open({
        conversationId: job.conversationId,
        generation: job.generation,
        pairingId: job.pairingId,
        principalId: job.principalId,
      });
      if (!decision.allowed) {
        return { status: 'rejected', code: decision.code };
      }

      const state = stateFor(job.pairingId);
      const entry: QueuedTurn = {
        turnId: options.newTurnId(),
        // 代数以服务端解析出来的为准（客户端开新一代时 open 会把它抬上去）。
        job: { ...job, generation: decision.conversation.generation },
      };

      if (state.running !== null) {
        if (state.queue.length >= queueCap) {
          await publishRejection(job, 'queue_full');
          return { status: 'rejected', code: 'queue_full' };
        }
        state.queue.push(entry);
        return { status: 'queued', depth: state.queue.length, turnId: entry.turnId };
      }

      beginTurn(state, entry);
      return { status: 'started', turnId: entry.turnId };
    },

    async control(command: ControlCommand): Promise<ControlResult> {
      const state = stateFor(command.pairingId);

      if (command.op === 'new') {
        const decision = conversations.startNew({
          conversationId: command.conversationId,
          generation: command.generation,
          pairingId: command.pairingId,
          principalId: command.principalId,
          ...(command.previousConversationId === undefined
            ? {}
            : { previousConversationId: command.previousConversationId }),
        });
        if (!decision.allowed) return { status: 'rejected', code: decision.code };

        // 先立新代，再拆旧摊子：反过来的话中间那一瞬旧 turn 已经死了、新代还没立，
        // 这时候进来的消息会落到一个没人管的代数上。
        const cleared = state.queue.length;
        state.queue.length = 0;
        state.running?.controller.abort();

        await publish(commandAsJob(command), 'ack', {
          type: 'ack',
          ackMessageId: command.messageId,
          status: 'completed',
        });
        return { status: 'ok', cleared, generation: decision.conversation.generation };
      }

      const owned = conversations.authorize({
        conversationId: command.conversationId,
        pairingId: command.pairingId,
        principalId: command.principalId,
      });
      if (!owned.allowed) return { status: 'rejected', code: owned.code };

      if (command.op === 'resume') {
        // resume 是"我回来了"，不是"再跑一遍"：绑定本来就还在，什么都不用做。
        return { status: 'ok' };
      }

      const running = state.running;
      if (running === null || running.job.conversationId !== command.conversationId) {
        return { status: 'noop' };
      }
      running.controller.abort();
      return { status: 'ok' };
    },

    recover(): { interrupted: number } {
      return { interrupted: store.recoverInterruptedTurns(now()).length };
    },

    runningTurns(): RunningTurnSummary[] {
      const out: RunningTurnSummary[] = [];
      for (const state of states.values()) {
        const running = state.running;
        if (running === null) continue;
        out.push({
          turnId: running.turnId,
          conversationId: running.job.conversationId,
          pairingId: running.job.pairingId,
          routeId: running.job.routeId,
          keyVersion: running.job.keyVersion,
        });
      }
      return out;
    },

    async drain(): Promise<void> {
      draining = true;
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },

    async health(): Promise<GatewayHealth> {
      const endpoints = await registry.health();
      let running = 0;
      let queued = 0;
      for (const state of states.values()) {
        if (state.running !== null) running += 1;
        queued += state.queue.length;
      }

      return {
        core: { ok: !draining },
        runner: {
          nodeId: endpoints.find((entry) => entry.nodeId !== undefined)?.nodeId ?? 'unknown',
          // 至少一个 active endpoint 的 Runner 是健康的，才算这台机器还能干活。
          ok: endpoints.some((entry) => entry.ok),
        },
        // 只报 id/ok/status：健康端点是公开面，workspace 路径、detail 之类一律不出去。
        endpoints: endpoints.map((entry) => ({
          id: entry.id,
          ok: entry.ok,
          status: entry.status,
        })),
        queues: { running, queued },
        lastTurn,
      };
    },
  };
}

/** 控制命令没有正文，但回执要发到同一条路由上——借用 TurnJob 的字段形状。 */
function commandAsJob(command: ControlCommand): TurnJob {
  return {
    pairingId: command.pairingId,
    principalId: command.principalId,
    endpointId: command.endpointId,
    routeId: command.routeId,
    keyVersion: command.keyVersion,
    conversationId: command.conversationId,
    generation: command.generation,
    messageId: command.messageId,
    text: '',
    clientSeq: 0,
    receivedAt: command.receivedAt,
  };
}
