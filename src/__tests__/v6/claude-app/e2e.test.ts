import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { AgentAdapter, AgentEvent, AgentRequest } from '../../../v6/contracts.js';
import { ClaudeAppAgent } from '../../../v6/agents/claude-app.js';
import { CcRegistry } from '../../../v6/claude-app/cc-registry.js';
import { GatewayBus } from '../../../v6/claude-app/gateway-bus.js';
import { InboxRegistry } from '../../../v6/claude-app/inbox-registry.js';
import { TranscriptWatcher } from '../../../v6/claude-app/transcript-watcher.js';
import { seedInbox } from '../../../v6/claude-app/seed.js';
import { startFakeGateway, type FakeGateway, type InjectBehavior } from './fake-gateway.js';
import { writeEngines } from './fixtures.js';

/**
 * 仿真 E2E(DoD 第 2 条):没有真 app,但除了 app 之外全是真的 ——
 * 真 SSE 长连接、真 HTTP 回执、真 fs 轮询、真 ClaudeAppAgent。
 * 假网关照契约办事:消费 SSE → 回 ack/resolve → 往夹具 jsonl 追加回复。
 */

let tmp: string;
let sessionsDir: string;
let projectsDir: string;
let dataDir: string;
let inboxRoot: string;
let server: http.Server;
let bus: GatewayBus;
let inboxes: InboxRegistry;
let agent: ClaudeAppAgent;
let port: number;
let gateway: FakeGateway | null;
let fallback: RecordingFallback;

const INBOX_CWD = (): string => path.join(inboxRoot, 'inbox-kiki');
const LOCAL_ID = 'local_kiki_0001';

class RecordingFallback implements AgentAdapter {
  readonly name = 'codex';
  readonly persistent = true;
  runs: AgentRequest[] = [];
  async *run(req: AgentRequest): AsyncIterable<AgentEvent> {
    this.runs.push(req);
    yield { type: 'final', text: '[codex 兜底] 通道降级了' };
  }
  async reset(): Promise<void> {}
  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async shutdown(): Promise<void> {}
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function req(text = '在吗', conversationId = 'conv-e2e'): AgentRequest {
  return { conversationId, text: `[微信] ${text}`, mediaPaths: [], cwd: '/daemon/work', binding: null };
}

function finalOf(events: AgentEvent[]): string | null {
  const f = [...events].reverse().find((e) => e.type === 'final');
  return f && f.type === 'final' ? f.text : null;
}

function errorOf(events: AgentEvent[]): { code: string; message: string } | null {
  const e = [...events].reverse().find((x) => x.type === 'error');
  return e && e.type === 'error' ? { code: e.code, message: e.message } : null;
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-appe2e-')));
  sessionsDir = path.join(tmp, 'sessions');
  projectsDir = path.join(tmp, 'projects');
  dataDir = path.join(tmp, 'data');
  inboxRoot = path.join(tmp, 'cc-wechat');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  bus = new GatewayBus({ ackTimeoutMs: 1_500 });
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('Not Found');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  port = (server.address() as AddressInfo).port;

  inboxes = new InboxRegistry({ accountId: 'e2e', dir: dataDir });
  const registry = new CcRegistry({ sessionsDir, projectsDir, isAlive: () => true });
  fallback = new RecordingFallback();
  agent = new ClaudeAppAgent({
    bus,
    inboxes,
    watcher: new TranscriptWatcher({ registry }),
    fallback,
    gatewayWaitMs: 150,
    turnTimeoutMs: 2_500,
    watchTuning: { pollMs: 15, settleMs: 60, silenceMs: 400, engineWaitMs: 1_200 },
  });
  agent.attachHttp(server);
  gateway = null;
});

afterEach(async () => {
  gateway?.close();
  await agent.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 播一个收件箱(走真 seedInbox,不真开 app) */
async function seed(withLocalId = true, withEngine = true): Promise<void> {
  await seedInbox({ name: 'kiki', root: inboxRoot, inboxes, open: false });
  if (withLocalId) inboxes.bindLocalId('kiki', LOCAL_ID);
  if (withEngine) writeEngines(sessionsDir, [{ pid: 3001, sessionId: 'cli-warm', cwd: INBOX_CWD(), startedAt: Date.now() }]);
}

async function gw(behavior?: (ev: { jobId: string; text: string }, n: number) => InjectBehavior, engines?: Record<string, string>): Promise<FakeGateway> {
  gateway = await startFakeGateway({
    port,
    sessionsDir,
    projectsDir,
    localIds: { [INBOX_CWD()]: LOCAL_ID },
    engines: engines ?? { [INBOX_CWD()]: 'cli-warm' },
    behavior: behavior as never,
    wakeMs: 30,
  });
  await gateway.waitFor((e) => e.type === 'hello');
  return gateway;
}

// ---------------------------------------------------------------------------

describe('仿真 E2E —— 全链', () => {
  it('一条消息走完 SSE → send_message → transcript → final', async () => {
    await seed();
    const g = await gw(() => ({ kind: 'reply', text: '在的，说' }));

    const events = await collect(agent.run(req('在吗'), new AbortController().signal));

    expect(finalOf(events)).toBe('在的，说');
    expect(g.injects).toHaveLength(1);
    // 注入的是信封,不是裸文本;jobId 在里面(它就是 transcript 锚点)
    expect(g.injects[0].text).toMatch(/^\[微信\|kiki\|job:[a-z0-9]+\|/);
    expect(g.injects[0].text).toContain('在吗');
    expect(g.injects[0].localId).toBe(LOCAL_ID);
  });

  it('工具调用的进度会冒出来,最终答案仍然只取收尾那条', async () => {
    await seed();
    await gw(() => ({ kind: 'reply', text: '查完了：42', tools: ['Bash', 'Read'] }));
    const events = await collect(agent.run(req('算一下'), new AbortController().signal));
    expect(finalOf(events)).toBe('查完了：42');
    const progress = events.filter((e) => e.type === 'progress').map((e) => (e as { text: string }).text);
    expect(progress).toContain('工具 Bash');
    expect(progress).toContain('工具 Read');
  });

  it('冷唤醒:注入时没有活引擎,网关唤起后照样取得回复', async () => {
    await seed(true, false); // 没有引擎登记
    await gw(() => ({ kind: 'reply', text: '醒了，我在' }), {}); // 假网关也不知道有引擎 → 会现造
    const events = await collect(agent.run(req('醒醒'), new AbortController().signal));
    expect(finalOf(events)).toBe('醒了，我在');
  });

  it('localId 懒解析:台账没有句柄时先 resolve,拿到后落盘', async () => {
    await seed(false); // 没绑 localId
    const g = await gw(() => ({ kind: 'reply', text: '解析完了' }));
    const events = await collect(agent.run(req(), new AbortController().signal));

    expect(g.events.some((e) => e.type === 'resolve')).toBe(true);
    expect(finalOf(events)).toBe('解析完了');
    expect(inboxes.byName('kiki')!.localId).toBe(LOCAL_ID);
    expect(events.some((e) => e.type === 'sessionChanged' && e.providerSessionId === LOCAL_ID)).toBe(true);
  });

  it('连着两轮:第二轮不再 resolve,收件箱绑定稳定', async () => {
    await seed(false);
    const g = await gw(() => ({ kind: 'reply', text: 'ok' }));
    await collect(agent.run(req('一'), new AbortController().signal));
    await collect(agent.run(req('二'), new AbortController().signal));
    expect(g.events.filter((e) => e.type === 'resolve')).toHaveLength(1);
    expect(g.injects).toHaveLength(2);
    expect(inboxes.forConversation('conv-e2e')!.name).toBe('kiki');
  });

  it('/new 之后那一条注入带新话题标记', async () => {
    await seed();
    const g = await gw(() => ({ kind: 'reply', text: 'ok' }));
    await collect(agent.run(req('一'), new AbortController().signal));
    await agent.reset('conv-e2e');
    await collect(agent.run(req('二'), new AbortController().signal));
    expect(g.injects[0].text).not.toContain('新话题');
    expect(g.injects[1].text).toContain('新话题');
  });

  it('app 不写 stop_reason 时走静默兜底,并留下痕迹', async () => {
    await seed();
    await gw(() => ({ kind: 'reply-no-stop-reason', text: '老格式也答得出来' }));
    const events = await collect(agent.run(req(), new AbortController().signal));
    expect(finalOf(events)).toBe('老格式也答得出来');
    expect(events.some((e) => e.type === 'progress' && String(e.text).includes('silence'))).toBe(true);
  });

  it('POST /claude-app/test-send 走的就是这条全链(真 E2E 的入口)', async () => {
    await seed();
    await gw(() => ({ kind: 'reply', text: '探针收到' }));

    const r = await new Promise<any>((resolve) => {
      const rq = http.request(
        { host: '127.0.0.1', port, path: '/claude-app/test-send', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
        },
      );
      rq.end(JSON.stringify({ text: '口令探针', conversationId: 'probe-1' }));
    });

    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, text: '探针收到' });
  });
});

describe('仿真 E2E —— 负例 1:超时', () => {
  it('网关 ack 了但收件箱一直不答 → turn-timeout,不吊死', async () => {
    await seed();
    const g = await gw(() => ({ kind: 'no-reply' }));
    const events = await collect(agent.run(req(), new AbortController().signal));
    expect(g.injects).toHaveLength(1);
    const err = errorOf(events);
    expect(err?.code).toBe('claude-app-turn-timeout');
    expect(finalOf(events)).toBeNull();
  });

  it('网关装死不回执 → ack-timeout(区别于上面:这次是网关的锅)', async () => {
    await seed();
    await gw(() => ({ kind: 'silent' }));
    const events = await collect(agent.run(req(), new AbortController().signal));
    expect(errorOf(events)?.code).toBe('claude-app-ack-timeout');
  });
});

describe('仿真 E2E —— 负例 2:断连', () => {
  it('投递后网关掉线 → 重挂时补投,这一轮还能救回来', async () => {
    await seed();
    // 第一次投递就掉线;补投时正常回复
    const g = await gw((_ev, n) => (n === 0 ? { kind: 'drop' } : { kind: 'reply', text: '重挂之后答的' }));
    const run = collect(agent.run(req(), new AbortController().signal));
    await g.waitFor((e) => e.type === 'inject');
    await new Promise((r) => setTimeout(r, 50));
    await g.reconnect();
    const events = await run;
    expect(finalOf(events)).toBe('重挂之后答的');
    expect(g.injects.length).toBeGreaterThanOrEqual(2); // 补投过
  });

  it('掉线之后没人重挂 → ack-timeout,如实报错', async () => {
    await seed();
    const g = await gw(() => ({ kind: 'drop' }));
    const events = await collect(agent.run(req(), new AbortController().signal));
    expect(errorOf(events)?.code).toBe('claude-app-ack-timeout');
    expect(g.injects).toHaveLength(1);
  });
});

describe('仿真 E2E —— 负例 3:降级', () => {
  it('压根没有网关在线 → 降级 codex,微信那头照样有人答', async () => {
    await seed();
    const events = await collect(agent.run(req(), new AbortController().signal));
    expect(finalOf(events)).toBe('[codex 兜底] 通道降级了');
    expect(fallback.runs).toHaveLength(1);
  });

  it('一个收件箱都没播种 → 也降级(不许哑死)', async () => {
    await gw(() => ({ kind: 'reply', text: '不会走到这' }));
    const events = await collect(agent.run(req(), new AbortController().signal));
    expect(finalOf(events)).toBe('[codex 兜底] 通道降级了');
  });

  it('网关在线但 send_message 被拒 → 不降级,如实报错(单轮问题不是通道塌了)', async () => {
    await seed();
    await gw(() => ({ kind: 'fail', error: 'send_message: session not found' }));
    const events = await collect(agent.run(req(), new AbortController().signal));
    expect(errorOf(events)?.code).toBe('claude-app-inject-failed');
    expect(fallback.runs).toHaveLength(0);
    // 句柄可能作废了,下一轮该重解析
    expect(inboxes.needResolve('kiki')).toBe(true);
  });
});

describe('仿真 E2E —— health 反映真实链路状态', () => {
  it('网关在线 + 收件箱在 → 健康', async () => {
    await seed();
    await gw();
    expect((await agent.health()).ok).toBe(true);
  });

  it('网关掉线 → 立刻不健康(运维看得见)', async () => {
    await seed();
    const g = await gw();
    g.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    const h = await agent.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('网关');
  });
});
