import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexAppServerAgent } from '../../../v6/agents/codex-app-server.js';
import type { AgentEvent, AgentRequest, SessionBinding } from '../../../v6/contracts.js';

/**
 * 真机冒烟 —— 唯一会真的烧配额的测试，默认不跑。
 *
 *   RUN_REAL_CODEX=1 npx vitest run src/__tests__/v6/e2e/real-codex.smoke.test.ts
 *
 * 预算纪律（别改大）：
 * - 3 次模型调用，全是"回复 ok"级别的提示词
 * - effort 强制 low
 * - 用默认 ~/.codex，**绝不碰 ~/.codex-wechat**（那是微信桥的账号目录，
 *   跟它抢 thread 写锁会把生产会话搞坏）
 * - pid 文件写临时目录，不碰 ~/.cc2wechat
 */

const ENABLED = process.env.RUN_REAL_CODEX === '1';

const tmp = ENABLED ? fs.mkdtempSync(path.join(os.tmpdir(), 'cc2wechat-real-codex-')) : '';

function realAgent(): CodexAppServerAgent {
  const env: NodeJS.ProcessEnv = { ...process.env, CC2WECHAT_CODEX_EFFORT: 'low' };
  // 显式回到默认账号目录：继承来的 CODEX_HOME 可能指着微信桥那套
  delete env.CODEX_HOME;
  return new CodexAppServerAgent({
    env,
    pidFilePath: path.join(tmp, 'appserver.pid'),
    cwd: tmp,
  });
}

function req(text: string, threadId?: string): AgentRequest {
  const binding: SessionBinding | null = threadId
    ? { conversationId: 'smoke', agentType: 'codex', providerSessionId: threadId, generation: 1, createdAt: 0, updatedAt: 0 }
    : null;
  return { conversationId: 'smoke', text, mediaPaths: [], cwd: tmp, binding };
}

interface TurnOutcome {
  ms: number;
  firstEventMs: number;
  threadId: string;
  final: string | null;
  error: string | null;
  events: string[];
}

async function runTurn(agent: CodexAppServerAgent, r: AgentRequest, signal: AbortSignal): Promise<TurnOutcome> {
  const t0 = Date.now();
  let firstEventMs = -1;
  let threadId = '';
  let final: string | null = null;
  let error: string | null = null;
  const events: string[] = [];

  for await (const e of agent.run(r, signal) as AsyncIterable<AgentEvent>) {
    if (firstEventMs < 0) firstEventMs = Date.now() - t0;
    events.push(e.type);
    if (e.type === 'started' && e.providerSessionId) threadId = e.providerSessionId;
    if (e.type === 'sessionChanged') threadId = e.providerSessionId;
    if (e.type === 'final') final = e.text;
    if (e.type === 'error') error = `${e.code}: ${e.message}`;
  }
  return { ms: Date.now() - t0, firstEventMs, threadId, final, error, events };
}

const timings: Array<[string, string]> = [];

afterAll(() => {
  if (!ENABLED || timings.length === 0) return;
  const width = Math.max(...timings.map(([k]) => k.length));
  const lines = timings.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`);
  console.log(`\n=== 真机冒烟计时 (codex app-server, effort=low) ===\n${lines.join('\n')}\n`);
});

describe.skipIf(!ENABLED)('真机冒烟 — 真 codex app-server（会烧配额）', () => {
  const agent = ENABLED ? realAgent() : (null as unknown as CodexAppServerAgent);
  let threadId = '';

  afterAll(async () => {
    if (ENABLED) await agent.shutdown();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('① 冷启动 + 新线程一轮', { timeout: 180_000 }, async () => {
    const t0 = Date.now();
    const out = await runTurn(agent, req('记住数字 7。只回复 ok'), new AbortController().signal);
    timings.push(['冷启动 + 第一轮 (spawn→initialize→thread/start→turn)', `${out.ms} ms`]);
    timings.push(['  其中 首个事件(进程就绪+线程开好)', `${out.firstEventMs} ms`]);

    expect(out.error).toBeNull();
    expect(out.final).toBeTruthy();
    expect(out.threadId).toBeTruthy();
    threadId = out.threadId;
  });

  it('② 同一个常驻进程追加一轮：上下文要接得上，而且要快', { timeout: 180_000 }, async () => {
    const out = await runTurn(agent, req('我刚才说的数字是几？只回数字', threadId), new AbortController().signal);
    timings.push(['热轮 (同进程 + thread/resume 命中)', `${out.ms} ms`]);
    timings.push(['  其中 首个事件', `${out.firstEventMs} ms`]);

    expect(out.error).toBeNull();
    expect(out.final ?? '').toMatch(/7/); // 上下文没断
    // 复用了同一条线程 = 没有多余的 sessionChanged
    expect(out.events).not.toContain('sessionChanged');
  });

  it('③ turn/interrupt 打断（不 kill 进程），进程还能继续服务', { timeout: 180_000 }, async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = Date.now();
      ctrl.abort();
    }, 2_000);

    const out = await runTurn(agent, req('从 1 数到 300，每个数字单独一行', threadId), ctrl.signal);
    timings.push(['打断生效 (abort → 生成器收敛)', `${Date.now() - abortedAt} ms`]);
    timings.push(['被打断的那一轮总耗时', `${out.ms} ms`]);

    // 被打断的一轮不该产出 final/error —— 回执由命令层发
    expect(out.final).toBeNull();
    expect(out.error).toBeNull();

    // 进程没被打断带走：health 还能问得动
    const h = await agent.health();
    timings.push(['打断后 health', `ok=${h.ok} ${h.detail ?? ''}`]);
    expect(h.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(120_000);
  });
});
