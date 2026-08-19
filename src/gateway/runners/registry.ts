/**
 * AgentEndpointRegistry：逻辑 endpoint → 物理 Runner 的唯一翻译层（架构 §4.2 / §6.2）。
 *
 * 三条被测试钉死的语义：
 *
 * 1. **status 实时读**。endpoint 行每次 resolve 都现查 store，不吃启动快照 ——
 *    运行中 disable 必须下一次调用就生效，enable 回来也要立刻能用（不是一次性熔断）。
 * 2. **拒绝发生在碰 Runner 之前**。disabled / 未知 endpoint 一旦漏过去就会白白产生
 *    一次 Codex rollout（真花钱、真留会话文件）。
 * 3. **runnerProfileId 是绑定键**。endpoint 不能自己指定跑在哪个节点上，
 *    节点由注册表按 profile 解析；profile 没注册就是配置错误，不是"随便挑一个"。
 *
 * `health()` 是运维面（架构 §12）：只报 id / status / nodeId 这类定位信息，
 * 绝不带 workspace 路径等执行细节 —— 它会出现在健康端点的响应里。
 */
import type { AgentEndpoint, EndpointStatus, RunnerAdapter } from '../contracts/runner.js';
import { gatewayError } from '../contracts/validation.js';
import type { GatewayStore } from '../state/sqlite-store.js';

export interface EndpointResolution {
  endpoint: AgentEndpoint;
  runner: RunnerAdapter;
}

export interface EndpointHealth {
  id: string;
  ok: boolean;
  status: EndpointStatus;
  nodeId?: string;
  detail?: string;
}

export interface AgentEndpointRegistry {
  /** endpoint 存在 + active + 有对应 Runner，三条全满足才返回，否则 throw。 */
  resolve(endpointId: string): EndpointResolution;
  list(): AgentEndpoint[];
  health(): Promise<EndpointHealth[]>;
}

export interface RunnerBinding {
  runnerProfileId: string;
  runner: RunnerAdapter;
}

export interface AgentEndpointRegistryOptions {
  store: Pick<GatewayStore, 'getEndpoint'>;
  runners: ReadonlyArray<RunnerBinding>;
  /** endpoint 目录由 bootstrap 提供：list()/health() 只看这些 id。 */
  endpointIds: readonly string[];
}

export function createAgentEndpointRegistry(
  options: AgentEndpointRegistryOptions,
): AgentEndpointRegistry {
  const { store } = options;
  const runners = new Map<string, RunnerAdapter>(
    options.runners.map((binding) => [binding.runnerProfileId, binding.runner]),
  );

  function runnerFor(endpoint: AgentEndpoint): RunnerAdapter | null {
    return runners.get(endpoint.runnerProfileId) ?? null;
  }

  function list(): AgentEndpoint[] {
    const listed: AgentEndpoint[] = [];
    for (const id of options.endpointIds) {
      const endpoint = store.getEndpoint(id);
      if (endpoint !== null) listed.push(endpoint);
    }
    return listed;
  }

  return {
    resolve(endpointId: string): EndpointResolution {
      const endpoint = store.getEndpoint(endpointId);
      if (endpoint === null) {
        throw gatewayError('endpoint_not_found', 'endpoint does not exist', 'endpointId');
      }
      // 状态先判：不健康的 Runner 还能重试，被 disable 的 endpoint 一次都不该跑。
      if (endpoint.status !== 'active') {
        throw gatewayError('endpoint_disabled', 'endpoint is disabled', 'endpointId');
      }
      const runner = runnerFor(endpoint);
      if (runner === null) {
        throw gatewayError(
          'runner_not_found',
          'no runner is registered for this runner profile',
          'runnerProfileId',
        );
      }
      return { endpoint, runner };
    },

    list,

    async health(): Promise<EndpointHealth[]> {
      const report: EndpointHealth[] = [];
      for (const endpoint of list()) {
        const runner = runnerFor(endpoint);
        const entry: EndpointHealth = {
          id: endpoint.id,
          ok: false,
          status: endpoint.status,
        };
        if (runner !== null) entry.nodeId = runner.descriptor.nodeId;

        if (endpoint.status !== 'active') {
          // disabled 的 endpoint 不去打扰 Runner：健康检查也是一次真调用。
          entry.detail = 'endpoint is disabled';
        } else if (runner === null) {
          entry.detail = 'no runner is registered for this runner profile';
        } else {
          const runnerHealth = await runner.health(endpoint);
          entry.ok = runnerHealth.ok;
          if (runnerHealth.detail !== undefined) entry.detail = runnerHealth.detail;
        }
        report.push(entry);
      }
      return report;
    },
  };
}
