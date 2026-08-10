import type { AgentAdapter, AgentEvent, AgentHealth, AgentRequest } from '../contracts.js';

/** cc-core 的 OfficialAdapter 里 v6 真正用到的面(避免把整个 SDK 类型拖进来) */
interface CoreAdapter {
  chat(params: { message: string; sessionId?: string; cwd: string }): AsyncIterable<Record<string, unknown>>;
  closeSession(sessionId: string): void;
  closeAllSessions(): void;
}

interface CoreModule {
  OfficialAdapter: new () => CoreAdapter;
}

export interface ClaudeSdkAgentOptions {
  /**
   * 注入点:默认动态 import。
   * 保持动态是刻意的 —— codex-only 部署可能压根没装 cc-core,
   * 构造时 import 会让整个 daemon 起不来(v5 的 checkCompatibility 思想)。
   */
  loadModule?: () => Promise<CoreModule>;
}

function extractText(msg: Record<string, unknown>): string {
  if (msg.type === 'result' && typeof msg.result === 'string') return msg.result;
  if (msg.type === 'assistant') {
    const m = msg.message as { content?: unknown } | undefined;
    if (typeof m?.content === 'string') return m.content;
    if (Array.isArray(m?.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n');
    }
  }
  return '';
}

/**
 * 常驻型 agent:包装 cc-core 的 OfficialAdapter(单例,daemon 生命周期一个)。
 * 池里 15 分钟 TTL,命中 = 进程还活着 = 秒回;过期 = SDK 侧 resume。
 *
 * 相对 v5 的关键修正 —— 会话身份用**真实 provider session id**:
 * v5 传的是 userIdToSessionUUID(userId) 这种确定性伪 UUID,
 * 读 node_modules/@aster110/cc-core/dist/adapters/official.js 的 getOrCreateSession 可知:
 * 传了 sessionId 且池里没有 → 走 unstable_v2_resumeSession(一个根本不存在的会话);
 * 不传 → unstable_v2_createSession 开新会话,随后 extractSessionId 只从
 * `type === "system"` 且带 session_id 的消息里取真实 id 并注册进池。
 * 所以 v6:没绑定就不传,从事件流里捞真 id 存进 SessionStore,下次拿它续。
 */
export class ClaudeSdkAgent implements AgentAdapter {
  readonly name = 'claude-code';
  readonly persistent = true;

  private readonly loadModule: () => Promise<CoreModule>;
  private adapter: CoreAdapter | null = null;
  /** conversationId → 真实 provider session id,只为 reset() 能找到池里那条 */
  private live = new Map<string, string>();

  constructor(opts: ClaudeSdkAgentOptions = {}) {
    this.loadModule = opts.loadModule ?? (() => import('@aster110/cc-core') as unknown as Promise<CoreModule>);
  }

  async *run(req: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (signal.aborted) return;

    let adapter: CoreAdapter;
    try {
      adapter = await this.ensureAdapter();
    } catch (err) {
      yield {
        type: 'error',
        code: 'claude-sdk-missing',
        message: `@aster110/cc-core 加载失败: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      };
      return;
    }

    const known = req.binding?.providerSessionId || undefined;
    let resolved = known;
    let lastText = '';

    yield { type: 'started', providerSessionId: known };

    try {
      for await (const msg of adapter.chat({ message: req.text, sessionId: known, cwd: req.cwd })) {
        if (signal.aborted) break;
        if (!msg || typeof msg !== 'object') continue;

        const sid = msg.session_id;
        if (typeof sid === 'string' && sid && sid !== resolved) {
          resolved = sid;
          this.live.set(req.conversationId, sid);
          yield { type: 'sessionChanged', providerSessionId: sid };
        }

        const text = extractText(msg);
        if (text) {
          lastText = text;
          continue;
        }
        if (typeof msg.type === 'string') yield { type: 'progress', text: msg.type };
      }
    } catch (err) {
      if (signal.aborted) return;
      yield {
        type: 'error',
        code: 'claude-sdk-error',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
      return;
    }

    if (signal.aborted) {
      // SDK 的 chat() 没有 abort 参数,能给的最强中止就是关掉这条 session
      // (cc-core closeSession → SDKSession.close(),真的把子进程收了)。
      // 会话文件还在,下一条消息靠 resume 接得回来 —— 符合 /stop"上下文保留"的语义。
      if (resolved) this.closeIfPossible(resolved);
      return;
    }

    if (resolved) this.live.set(req.conversationId, resolved);

    if (lastText) {
      yield { type: 'final', text: lastText };
      return;
    }
    yield {
      type: 'error',
      code: 'claude-no-output',
      message: '这轮没有拿到任何输出（SDK 没有产出 result/assistant 文本）',
      retryable: true,
    };
  }

  async reset(conversationId: string): Promise<void> {
    const sid = this.live.get(conversationId);
    if (!sid) return;
    this.live.delete(conversationId);
    this.closeIfPossible(sid);
  }

  async health(): Promise<AgentHealth> {
    // 刻意不 import:cc-core 在模块加载期会去 patch claude CLI,
    // 为了回答一次 /health 触发这个副作用不值当。
    return { ok: true, detail: this.adapter ? 'sdk pool active' : 'sdk not loaded yet' };
  }

  async shutdown(): Promise<void> {
    this.live.clear();
    try {
      this.adapter?.closeAllSessions();
    } catch {
      /* 关不掉就算了,进程马上就没了 */
    }
  }

  private async ensureAdapter(): Promise<CoreAdapter> {
    if (!this.adapter) {
      const mod = await this.loadModule();
      this.adapter = new mod.OfficialAdapter();
    }
    return this.adapter;
  }

  private closeIfPossible(sessionId: string): void {
    try {
      this.adapter?.closeSession(sessionId);
    } catch {
      /* 池里没有就算了 */
    }
  }
}
