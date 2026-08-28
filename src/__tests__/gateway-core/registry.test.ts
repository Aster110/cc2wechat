/**
 * M4 · AgentEndpointRegistry（RED）
 *
 * 任务书 §6.2「`AgentEndpointRegistry` 与 `aster-admin` endpoint」+ §6.4「endpoint disabled 立即拒绝」。
 *
 * registry 是"逻辑 endpoint → 物理 Runner"的唯一翻译层，冻结三件事：
 * 1. **status 是实时读的**，不是启动时快照。运行中把 endpoint disable，下一次 resolve 必须立刻拒。
 * 2. **拒绝发生在碰 Runner 之前**。disabled/未知 endpoint 一旦漏过去，就会白白产生一次 Codex rollout。
 * 3. **runnerProfileId 是绑定键**。endpoint 不能自己指定节点，节点由注册表按 profile 解析。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { createLocalRunnerAdapter } from '../../gateway/runners/local-runner.js';
import type { AgentEndpoint, RunnerAdapter } from '../../gateway/contracts/runner.js';
import type { GatewayStore } from '../../gateway/state/sqlite-store.js';

import {
  FakeAgent,
  lazyModule,
  openTestStore,
  seedEndpoint,
  type ComponentHealth,
  type TestStore,
} from './harness.js';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type EndpointResolution = { endpoint: AgentEndpoint; runner: RunnerAdapter };

type EndpointHealth = {
  id: string;
  ok: boolean;
  status: 'active' | 'disabled';
  nodeId?: string;
  detail?: string;
};

type AgentEndpointRegistryApi = {
  /** 解析成功 = endpoint 存在、active、且有对应 Runner。任何一条不满足都 throw。 */
  resolve(endpointId: string): EndpointResolution;
  list(): AgentEndpoint[];
  health(): Promise<EndpointHealth[]>;
};

type RegistryOptions = {
  store: Pick<GatewayStore, 'getEndpoint'>;
  runners: ReadonlyArray<{ runnerProfileId: string; runner: RunnerAdapter }>;
  /** 有哪些 endpoint 要出现在 list()/health() 里（endpoint 目录由 bootstrap 提供）。 */
  endpointIds: readonly string[];
};

type RegistryModule = {
  createAgentEndpointRegistry(options: RegistryOptions): AgentEndpointRegistryApi;
};

type GatewayError = Error & { code: string; field?: string };

const loadRegistry = lazyModule<RegistryModule>('../../gateway/runners/registry.js');

function captureThrow(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    return error as GatewayError;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let handle: TestStore | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface Fixture {
  store: GatewayStore;
  agent: FakeAgent;
  runner: RunnerAdapter;
  resolvedWorkspaces: string[];
}

function setup(): Fixture {
  handle = openTestStore();
  const store = handle.store;
  const agent = new FakeAgent();
  const resolvedWorkspaces: string[] = [];
  const runner = createLocalRunnerAdapter({
    runnerId: 'local-729a',
    nodeId: '729a',
    agent,
    resolveWorkspace: (policyId) => {
      resolvedWorkspaces.push(policyId);
      return `/home/waku/ws/${policyId}`;
    },
    getBinding: () => null,
  });
  return { store, agent, runner, resolvedWorkspaces };
}

async function makeRegistry(
  fixture: Fixture,
  overrides: Partial<RegistryOptions> = {},
): Promise<AgentEndpointRegistryApi> {
  const mod = await loadRegistry();
  return mod.createAgentEndpointRegistry({
    store: fixture.store,
    runners: [{ runnerProfileId: 'local-729a', runner: fixture.runner }],
    endpointIds: ['aster-admin'],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('M4 · AgentEndpointRegistry 解析', () => {
  it('active endpoint 解析出 endpoint 与按 runnerProfileId 绑定的 Runner', async () => {
    const fixture = setup();
    const endpoint = seedEndpoint(fixture.store, { id: 'aster-admin' });
    const registry = await makeRegistry(fixture);

    const resolved = registry.resolve('aster-admin');
    expect(resolved.endpoint).toEqual(endpoint);
    expect(resolved.runner.descriptor.nodeId).toBe('729a');
    expect(resolved.runner.descriptor.runnerId).toBe('local-729a');
    expect(resolved.runner.descriptor.kind).toBe('local');
  });

  it('disabled endpoint 立即拒绝，且在碰 Runner 之前就拒（不产生 rollout）', async () => {
    const fixture = setup();
    seedEndpoint(fixture.store, { id: 'aster-admin', status: 'disabled' });
    const registry = await makeRegistry(fixture);

    const error = captureThrow(() => registry.resolve('aster-admin'));
    expect(error.code).toBe('endpoint_disabled');
    expect(fixture.agent.turns).toHaveLength(0);
    expect(fixture.agent.healthCalls).toBe(0);
    expect(fixture.resolvedWorkspaces).toEqual([]);
  });

  it('未知 endpoint 报 endpoint_not_found，未注册的 runnerProfileId 报 runner_not_found', async () => {
    const fixture = setup();
    seedEndpoint(fixture.store, { id: 'guest-sandbox', runnerProfileId: 'sandbox-pool' });
    const registry = await makeRegistry(fixture, { endpointIds: ['guest-sandbox'] });

    expect(captureThrow(() => registry.resolve('does-not-exist')).code).toBe('endpoint_not_found');
    expect(captureThrow(() => registry.resolve('guest-sandbox')).code).toBe('runner_not_found');
    expect(fixture.agent.turns).toHaveLength(0);
  });

  it('status 实时读：运行中把 endpoint disable，下一次 resolve 立刻拒（不吃启动快照）', async () => {
    const fixture = setup();
    seedEndpoint(fixture.store, { id: 'aster-admin' });
    const registry = await makeRegistry(fixture);
    expect(registry.resolve('aster-admin').endpoint.status).toBe('active');

    seedEndpoint(fixture.store, { id: 'aster-admin', status: 'disabled' });
    expect(captureThrow(() => registry.resolve('aster-admin')).code).toBe('endpoint_disabled');

    // 再 enable 回来必须又能用（不是一次性熔断）
    seedEndpoint(fixture.store, { id: 'aster-admin', status: 'active' });
    expect(registry.resolve('aster-admin').endpoint.status).toBe('active');
  });

  it('list() 反映 store 里的 endpoint 目录，含 trustTier 与 workspacePolicyId', async () => {
    const fixture = setup();
    seedEndpoint(fixture.store, { id: 'aster-admin', trustTier: 'admin-bypass' });
    seedEndpoint(fixture.store, {
      id: 'guest-sandbox',
      trustTier: 'sandbox-workspace',
      status: 'disabled',
      workspacePolicyId: 'sandbox-a',
    });
    const registry = await makeRegistry(fixture, { endpointIds: ['aster-admin', 'guest-sandbox'] });

    const listed = registry.list().slice().sort((a, b) => a.id.localeCompare(b.id));
    expect(listed.map((e) => e.id)).toEqual(['aster-admin', 'guest-sandbox']);
    expect(listed[0].trustTier).toBe('admin-bypass');
    expect(listed[1].trustTier).toBe('sandbox-workspace');
    expect(listed[1].workspacePolicyId).toBe('sandbox-a');
    expect(listed[1].status).toBe('disabled');
  });
});

describe('M4 · AgentEndpointRegistry 健康面', () => {
  it('active endpoint 的健康来自 Runner；disabled 直接 ok=false 且不去打扰 Runner', async () => {
    const fixture = setup();
    seedEndpoint(fixture.store, { id: 'aster-admin' });
    seedEndpoint(fixture.store, { id: 'guest-sandbox', status: 'disabled' });
    const registry = await makeRegistry(fixture, { endpointIds: ['aster-admin', 'guest-sandbox'] });

    const health = await registry.health();
    const byId = new Map(health.map((entry) => [entry.id, entry]));

    expect(byId.get('aster-admin')?.ok).toBe(true);
    expect(byId.get('aster-admin')?.status).toBe('active');
    expect(byId.get('aster-admin')?.nodeId).toBe('729a');

    expect(byId.get('guest-sandbox')?.ok).toBe(false);
    expect(byId.get('guest-sandbox')?.status).toBe('disabled');

    // 只有 active 的那个问过 Runner
    expect(fixture.agent.healthCalls).toBe(1);
  });

  it('Runner 不健康时 endpoint 也不健康，但仍是可解析的 endpoint（区分 disabled 与 unhealthy）', async () => {
    const fixture = setup();
    seedEndpoint(fixture.store, { id: 'aster-admin' });
    fixture.agent.ok = false;
    const registry = await makeRegistry(fixture);

    const health = await registry.health();
    expect(health).toHaveLength(1);
    expect(health[0].ok).toBe(false);
    expect(health[0].status).toBe('active');

    // unhealthy ≠ disabled：resolve 仍然成功，由上层决定要不要派活
    expect(registry.resolve('aster-admin').endpoint.status).toBe('active');
  });

  it('health() 输出只含 id/status/nodeId 这类运维字段，不带 workspace 路径等执行细节', async () => {
    const fixture = setup();
    seedEndpoint(fixture.store, { id: 'aster-admin', workspacePolicyId: 'admin-home' });
    const registry = await makeRegistry(fixture);

    const health: EndpointHealth[] = await registry.health();
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain('/home/waku');
    expect(serialized).not.toContain('admin-home');

    const sample: ComponentHealth = { ok: health[0].ok };
    expect(sample.ok).toBe(true);
  });
});
