import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { CodexAppServerAgent } from '../../v6/agents/codex-app-server.js';
import type { AgentEvent, AgentRequest, SessionBinding } from '../../v6/contracts.js';
import { buildWakuDmGateway, loadDmGatewayConfig } from '../../gateway/bootstrap/waku-dm.js';
import { FakeBridgeServer, RecordingLogger, waitFor } from '../gateway-waku-dm/fake-bridge-server.js';

// The default gateway factory stays real; only the external Codex process is fake.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

type RpcRequest = { id?: number; method: string; params: Record<string, any> };
type ThreadConfig = { model?: string; model_reasoning_effort?: string };

// Observe the serialized protocol at the child-process boundary, not a config
// helper. Responses use the same thread/turn frame shapes as the existing suite.
class ThreadServer {
  readonly requests: RpcRequest[] = [];
  readonly child: any;
  private buffer = '';
  private threadSeq = 0;
  private turnSeq = 0;
  private readonly known: Set<string>;

  constructor(private readonly opts: { knownThreads?: string[]; omitResumeId?: boolean } = {}) {
    this.known = new Set(opts.knownThreads);
    const child = new EventEmitter() as any;
    child.pid = 61001;
    child.exitCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal: string) => {
      this.exit(signal);
      return true;
    };
    child.stdin.on('finish', () => this.exit(null));
    child.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (;;) {
        const end = this.buffer.indexOf('\n');
        if (end < 0) break;
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (frame.trim()) this.handle(JSON.parse(frame));
      }
    });
    this.child = child;
  }

  private exit(signal: string | null): void {
    if (this.child.exitCode !== null) return;
    this.child.exitCode = 0;
    this.child.emit('exit', 0, signal);
  }

  private send(frame: unknown): void {
    this.child.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private handle(request: RpcRequest): void {
    this.requests.push(request);
    const reply = (result: unknown) => this.send({ jsonrpc: '2.0', id: request.id, result });
    switch (request.method) {
      case 'initialize':
        reply({ codexHome: '/fake/codex-home', userAgent: 'test-server' });
        return;
      case 'initialized':
        return;
      case 'thread/start': {
        const id = `th-created-${++this.threadSeq}`;
        this.known.add(id);
        reply({ thread: { id, turns: [], status: { type: 'idle' } } });
        return;
      }
      case 'thread/resume': {
        const id = request.params.threadId;
        if (!this.known.has(id)) {
          this.send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'thread not found' } });
          return;
        }
        reply({ thread: { ...(this.opts.omitResumeId ? {} : { id }), turns: [], status: { type: 'idle' } } });
        return;
      }
      case 'turn/start': {
        const id = `turn-${++this.turnSeq}`;
        const threadId = request.params.threadId;
        reply({ turn: { id, status: 'inProgress', items: [] } });
        setImmediate(() => this.send({
          jsonrpc: '2.0', method: 'turn/completed',
          params: {
            threadId,
            turn: { id, status: 'completed', error: null, items: [{ type: 'agentMessage', text: '私聊已回复' }] },
          },
        }));
        return;
      }
      default:
        this.send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unexpected ${request.method}` } });
    }
  }

  threads(): RpcRequest[] {
    return this.requests.filter((request) => request.method === 'thread/start' || request.method === 'thread/resume');
  }
}

const cleanup: Array<() => Promise<void>> = [];

function harness(env: NodeJS.ProcessEnv, serverOptions: ConstructorParameters<typeof ThreadServer>[0] = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-thread-config-'));
  const server = new ThreadServer(serverOptions);
  const spawnFn = vi.fn(() => server.child);
  const agent = new CodexAppServerAgent({
    env,
    cwd: '/waku-project',
    pidFilePath: path.join(tmp, 'app-server.pid'),
    spawnFn: spawnFn as any,
    procOps: { isAlive: () => false, cmdline: () => null, kill: () => {} },
  });
  cleanup.push(async () => {
    await agent.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { agent, server, spawnFn };
}

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.mocked(spawn).mockReset();
    vi.unstubAllEnvs();
  }
});

function binding(threadId: string): SessionBinding {
  return { conversationId: 'waku-dm-conversation', agentType: 'codex', providerSessionId: threadId, generation: 1, createdAt: 0, updatedAt: 0 };
}

async function run(agent: CodexAppServerAgent, existing: SessionBinding | null = null): Promise<AgentEvent[]> {
  const request: AgentRequest = {
    conversationId: 'waku-dm-conversation', text: '继续这条私聊', mediaPaths: [], cwd: '/waku-project', binding: existing,
  };
  const events: AgentEvent[] = [];
  for await (const event of agent.run(request, new AbortController().signal)) events.push(event);
  return events;
}

const configCases: Array<{ name: string; env: NodeJS.ProcessEnv; config?: ThreadConfig }> = [
  { name: 'model only', env: { CC2WECHAT_CODEX_MODEL: 'gpt-6-astra' }, config: { model: 'gpt-6-astra' } },
  { name: 'effort only', env: { CC2WECHAT_CODEX_EFFORT: 'high' }, config: { model_reasoning_effort: 'high' } },
  { name: 'model and effort', env: { CC2WECHAT_CODEX_MODEL: 'gpt-6-astra', CC2WECHAT_CODEX_EFFORT: 'high' }, config: { model: 'gpt-6-astra', model_reasoning_effort: 'high' } },
  { name: 'neither configured', env: {} },
  { name: 'empty strings', env: { CC2WECHAT_CODEX_MODEL: '', CC2WECHAT_CODEX_EFFORT: '' } },
  { name: 'whitespace only', env: { CC2WECHAT_CODEX_MODEL: ' \t', CC2WECHAT_CODEX_EFFORT: '\n ' } },
  { name: 'trimmed values', env: { CC2WECHAT_CODEX_MODEL: ' gpt-6-astra\t', CC2WECHAT_CODEX_EFFORT: ' high\n' }, config: { model: 'gpt-6-astra', model_reasoning_effort: 'high' } },
  { name: 'blank model with effort', env: { CC2WECHAT_CODEX_MODEL: ' ', CC2WECHAT_CODEX_EFFORT: 'high' }, config: { model_reasoning_effort: 'high' } },
  { name: 'model with blank effort', env: { CC2WECHAT_CODEX_MODEL: 'gpt-6-astra', CC2WECHAT_CODEX_EFFORT: ' ' }, config: { model: 'gpt-6-astra' } },
];

function expectConfig(request: RpcRequest, config?: ThreadConfig): void {
  if (config) expect(request.params.config).toEqual(config);
  else expect(request.params).not.toHaveProperty('config');
}

describe('Waku DM thread configuration at the JSON-RPC boundary', () => {
  it.each(configCases)('thread/start: $name applies only explicit configuration', async ({ env, config }) => {
    const h = harness(env);
    const events = await run(h.agent);

    expect(events).toEqual([
      { type: 'started', providerSessionId: 'th-created-1' },
      { type: 'sessionChanged', providerSessionId: 'th-created-1' },
      { type: 'final', text: '私聊已回复' },
    ]);
    expect(h.server.threads()).toHaveLength(1);
    const request = h.server.threads()[0];
    expect(request.method).toBe('thread/start');
    expect(request.params.cwd).toBe('/waku-project');
    expectConfig(request, config);
  });

  it.each(configCases)('thread/resume: $name preserves the existing conversation', async ({ env, config }) => {
    const h = harness(env, { knownThreads: ['th-existing'] });
    const events = await run(h.agent, binding('th-existing'));

    expect(events).toEqual([
      { type: 'started', providerSessionId: 'th-existing' },
      { type: 'final', text: '私聊已回复' },
    ]);
    expect(h.server.threads()).toHaveLength(1);
    const request = h.server.threads()[0];
    expect(request.method).toBe('thread/resume');
    expect(request.params).toMatchObject({ threadId: 'th-existing', cwd: '/waku-project', excludeTurns: true });
    expectConfig(request, config);
    expect(h.server.requests.find((frame) => frame.method === 'turn/start')?.params.threadId).toBe('th-existing');
  });

  it.each(configCases.slice(0, 4))('missing thread fallback retains $name on the replacement thread', async ({ env, config }) => {
    const h = harness(env);
    const events = await run(h.agent, binding('th-missing'));

    expect(h.server.threads().map((frame) => frame.method)).toEqual(['thread/resume', 'thread/start']);
    expect(h.server.threads()[0].params.threadId).toBe('th-missing');
    for (const request of h.server.threads()) expectConfig(request, config);
    expect(events).toEqual([
      { type: 'started', providerSessionId: 'th-created-1' },
      { type: 'sessionChanged', providerSessionId: 'th-created-1' },
      { type: 'final', text: '私聊已回复' },
    ]);
    expect(h.server.requests.find((frame) => frame.method === 'turn/start')?.params.threadId).toBe('th-created-1');
  });

  it('successful resume without a returned id keeps the requested thread', async () => {
    const h = harness({}, { knownThreads: ['th-existing'], omitResumeId: true });
    const events = await run(h.agent, binding('th-existing'));

    expect(h.server.threads().map((frame) => frame.method)).toEqual(['thread/resume']);
    expect(events).toEqual([
      { type: 'started', providerSessionId: 'th-existing' },
      { type: 'final', text: '私聊已回复' },
    ]);
  });

  it('adapter reconstruction applies updated configuration while reusing the first sessionChanged thread', async () => {
    const first = harness({ CC2WECHAT_CODEX_MODEL: 'gpt-5.6-sol', CC2WECHAT_CODEX_EFFORT: 'low' });
    const initialEvents = await run(first.agent);
    const sessionChanged = initialEvents.find((event) => event.type === 'sessionChanged');
    expect(sessionChanged).toBeDefined();
    const threadId = sessionChanged!.providerSessionId;
    await first.agent.shutdown();

    // This reconstructs the adapter in one test process; it does not restart a
    // daemon or reopen SQLite. The bootstrap case below covers real persistence.
    const reconstructed = harness(
      { CC2WECHAT_CODEX_MODEL: 'gpt-6-astra', CC2WECHAT_CODEX_EFFORT: 'high' },
      { knownThreads: [threadId] },
    );
    const events = await run(reconstructed.agent, binding(threadId));
    expect(reconstructed.spawnFn).toHaveBeenCalledTimes(1);
    expect(reconstructed.server.threads().map((frame) => frame.method)).toEqual(['thread/resume']);
    expect(reconstructed.server.threads()[0].params).toMatchObject({
      threadId, config: { model: 'gpt-6-astra', model_reasoning_effort: 'high' },
    });
    expect(events).toEqual([
      { type: 'started', providerSessionId: threadId },
      { type: 'final', text: '私聊已回复' },
    ]);
  });

  it('default Waku DM bootstrap forwards model and Waku effort to start/resume and preserves the SQLite binding', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waku-dm-default-agent-'));
    cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    const owner = 'usr_test_owner';
    const persona = 'usr_test_persona';
    const conversationId = 'conv_test_default_codex';
    const credential = 'abc_XfQ1m2n3o4p5q6r7s8t9u0v1w2x3y4z5A6B7C8D9E0';
    const credentialFile = path.join(dir, 'bridge.credential');
    fs.writeFileSync(credentialFile, credential, { mode: 0o600 });
    const bridge = new FakeBridgeServer({ ownerUserId: owner, personaUserId: persona, credential, keepaliveMs: 50 });
    cleanup.push(() => bridge.close());
    await bridge.start();
    bridge.seedDm(conversationId, owner);

    vi.stubEnv('CC2WECHAT_CODEX_MODEL', 'gpt-6-astra');
    // Deliberately absent: the production factory must translate WAKU's effort.
    vi.stubEnv('CC2WECHAT_CODEX_EFFORT', undefined);
    const config = loadDmGatewayConfig({
      WAKU_GATEWAY_CHANNEL: 'waku-dm',
      WAKU_GATEWAY_STATE_DIR: path.join(dir, 'state'),
      WAKU_GATEWAY_WORKSPACE_DIR: dir,
      WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE: credentialFile,
      WAKU_GATEWAY_API_BASE: bridge.apiBase,
      WAKU_GATEWAY_OWNER_USER_IDS: owner,
      WAKU_GATEWAY_CODEX_HOME: path.join(dir, 'codex-home'),
      WAKU_GATEWAY_CODEX_EFFORT: 'medium',
      WAKU_DM_ACK_MS: '0',
    });
    const server = new ThreadServer();
    vi.mocked(spawn).mockReturnValue(server.child);
    const gateway = buildWakuDmGateway({ config, log: new RecordingLogger() });
    cleanup.push(() => gateway.stop());
    await gateway.start();
    await waitFor(() => bridge.liveConnectionCount === 1, { label: 'default gateway subscribed' });

    bridge.emitChatMessage({ conversationId, senderUserId: owner, body: '第一条私聊' });
    await waitFor(() => bridge.messages.length === 1, { label: 'first default-agent reply' });
    const firstBinding = gateway.store.getProviderBinding(conversationId);
    expect(firstBinding).toMatchObject({ conversationId, agentType: 'codex', providerSessionId: 'th-created-1' });

    bridge.emitChatMessage({ conversationId, senderUserId: owner, body: '继续同一条私聊' });
    await waitFor(() => bridge.messages.length === 2, { label: 'resumed default-agent reply' });

    expect(bridge.messages.map(({ conversationId: id, senderUserId, body }) => ({ id, senderUserId, body }))).toEqual([
      { id: conversationId, senderUserId: persona, body: '私聊已回复' },
      { id: conversationId, senderUserId: persona, body: '私聊已回复' },
    ]);
    expect(gateway.store.getProviderBinding(conversationId)).toEqual(firstBinding);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.threads().map((frame) => frame.method)).toEqual(['thread/start', 'thread/resume']);
    expect(server.threads()[1].params.threadId).toBe(firstBinding!.providerSessionId);
    expect(server.threads().map((frame) => frame.params.cwd)).toEqual([dir, dir]);
    // Assert both wire requests after both turns, so missing start config cannot
    // prevent the resume and persisted-binding portions from being exercised.
    expect(server.threads().map((frame) => frame.params.config)).toEqual([
      { model: 'gpt-6-astra', model_reasoning_effort: 'medium' },
      { model: 'gpt-6-astra', model_reasoning_effort: 'medium' },
    ]);
  });
});
