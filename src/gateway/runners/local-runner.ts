/**
 * LocalRunnerAdapter：把 Gateway 的 `RunnerRequest` 映射到现有 v6 `AgentAdapter`（架构 §4.2）。
 *
 * 这是**复用**而不是新写一套执行器：codex/claude 的进程管理、错误提取、abort 语义
 * 都在 v6 那边打磨过了，这里只负责三件事：
 *
 * 1. **解析执行位置**。cwd 的唯一来源是 `endpoint.workspacePolicyId` 经注入的
 *    `resolveWorkspace` 解析出来的路径 —— 客户端在任何字段里都够不到它。
 * 2. **拿会话绑定**。`getBinding` 决定 create 还是 resume，Agent 自己不查库。
 * 3. **原样流出 AgentEvent**。不改写、不吞、不补 —— 词表归 v6 管，
 *    这里一旦"顺手翻译一下"，协议就分叉了。
 *
 * endpoint 被 disabled 时直接拒，且**在碰 Agent 之前**拒：不然会白白产生一次
 * Codex rollout（真花钱、真留会话文件）。
 */
import type { AgentAdapter, AgentEvent, SessionBinding } from '../../v6/contracts.js';
import type { ComponentHealth } from '../contracts/channel.js';
import type {
  AgentEndpoint,
  RunnerAdapter,
  RunnerDescriptor,
  RunnerRequest,
} from '../contracts/runner.js';
import { gatewayError } from '../contracts/validation.js';

export interface LocalRunnerOptions {
  runnerId: string;
  nodeId: string;
  agent: AgentAdapter;
  /** cwd 的唯一来源：endpoint.workspacePolicyId */
  resolveWorkspace(workspacePolicyId: string): string;
  getBinding(conversationId: string): SessionBinding | null;
}

export function createLocalRunnerAdapter(options: LocalRunnerOptions): RunnerAdapter {
  const { agent } = options;

  const descriptor: RunnerDescriptor = {
    runnerId: options.runnerId,
    nodeId: options.nodeId,
    kind: 'local',
    capabilities: [
      `agent:${agent.name}`,
      agent.persistent ? 'persistent' : 'ephemeral',
      'chat',
      'reset',
    ],
  };

  function assertActive(endpoint: AgentEndpoint): void {
    if (endpoint.status !== 'active') {
      throw gatewayError('endpoint_disabled', 'endpoint is disabled', 'status');
    }
  }

  async function* run(
    endpoint: AgentEndpoint,
    request: RunnerRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    assertActive(endpoint);
    yield* agent.run(
      {
        conversationId: request.conversationId,
        text: request.text,
        mediaPaths: request.mediaPaths,
        cwd: options.resolveWorkspace(endpoint.workspacePolicyId),
        binding: options.getBinding(request.conversationId),
      },
      signal,
    );
  }

  return {
    descriptor,
    run,

    async reset(endpoint: AgentEndpoint, conversationId: string): Promise<void> {
      assertActive(endpoint);
      await agent.reset(conversationId);
    },

    async health(): Promise<ComponentHealth> {
      const health = await agent.health();
      return health.detail === undefined
        ? { ok: health.ok }
        : { ok: health.ok, detail: health.detail };
    },

    async shutdown(): Promise<void> {
      await agent.shutdown();
    },
  };
}
