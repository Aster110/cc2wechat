import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { setupE2e, type E2eEnv } from './harness.js';
import { userIdToSessionUUID } from '../../../utils.js';

/**
 * 端到端:真的 `node dist/v6/main.js`,只把两个外设换成桩
 * (假 iLink HTTP + PATH 上的假 codex)。中间那条链路 —— 长轮询、去重、
 * 命令抢占、调度、会话表、回复分片 —— 全是生产代码。
 *
 * 跑之前先 `npm run build`。
 */

const TEST_TIMEOUT = 60_000;

let env: E2eEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** exec 人格下,某次 spawn 的 `-- ` 之后第一个参数就是 resume 的 threadId */
function resumeThreadIdOf(argv: string[]): string | null {
  if (argv[0] !== 'exec' || argv[1] !== 'resume') return null;
  const i = argv.indexOf('--');
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

// ---------------------------------------------------------------------------

describe('e2e — 一问一答与会话延续（exec 人格）', () => {
  it(
    '首条消息收到回复',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon();

      env.ilink.push('你好啊');
      const reply = await env.ilink.waitForReply((m) => m.text.includes('你好啊'), 20_000);

      expect(reply.toUser).toBeTruthy();
      // daemon 会给正文加 [微信] 前缀（agent 侧靠它识别来源）
      expect(reply.text).toContain('[微信]');
      expect(env.fakeCodex.spawns()).toHaveLength(1);
      expect(env.fakeCodex.spawns()[0].argv[0]).toBe('exec');
    },
    TEST_TIMEOUT,
  );

  it(
    '第二条走 resume，且 threadId 传对',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon();

      env.ilink.push('第一条');
      await env.ilink.waitForReply((m) => m.text.includes('第一条'), 20_000);

      env.ilink.push('第二条');
      await env.ilink.waitForReply((m) => m.text.includes('第二条'), 20_000);

      const spawns = env.fakeCodex.spawns();
      expect(spawns).toHaveLength(2);
      expect(spawns[0].argv).not.toContain('resume');

      const firstThread = JSON.parse(
        fs.readFileSync(path.join(env.home, '.cc2wechat', 'sessions-e2e-acct.json'), 'utf-8'),
      );
      const bound = Object.values(firstThread.bindings)[0] as any;
      expect(resumeThreadIdOf(spawns[1].argv)).toBe(bound.providerSessionId);
    },
    TEST_TIMEOUT,
  );

  it(
    '/new 之后开新 thread（不再 resume 旧的）',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon();

      env.ilink.push('建立上下文');
      await env.ilink.waitForReply((m) => m.text.includes('建立上下文'), 20_000);

      env.ilink.push('/new');
      await env.ilink.waitForReply((m) => m.text.includes('已开启新对话'), 20_000);

      env.ilink.push('新的一轮');
      await env.ilink.waitForReply((m) => m.text.includes('新的一轮'), 20_000);

      const spawns = env.fakeCodex.spawns();
      expect(spawns).toHaveLength(2); // /new 本身不 spawn
      expect(spawns[1].argv).not.toContain('resume');
    },
    TEST_TIMEOUT,
  );

  it(
    'daemon 重启后还能续上（binding 落盘生效）',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const first = await env.startDaemon();

      env.ilink.push('重启前');
      await env.ilink.waitForReply((m) => m.text.includes('重启前'), 20_000);
      await first.stop();

      await env.startDaemon();
      env.ilink.push('重启后');
      await env.ilink.waitForReply((m) => m.text.includes('重启后'), 20_000);

      const spawns = env.fakeCodex.spawns();
      expect(spawns).toHaveLength(2);
      const threadId = resumeThreadIdOf(spawns[1].argv);
      expect(threadId).toBeTruthy();
      // 第一轮 thread.started 报的那个 id
      expect(threadId).toMatch(/^t-/);
    },
    TEST_TIMEOUT,
  );

  it(
    'v5 的 codex-threads-<port>.json 会被迁移过来（升级不失忆）',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const userId = 'legacy-user-001';
      fs.writeFileSync(
        path.join(env.home, '.cc2wechat', `codex-threads-${env.port}.json`),
        JSON.stringify({ [userIdToSessionUUID(userId)]: 't-legacy-thread' }),
        'utf-8',
      );

      await env.startDaemon();
      env.ilink.push('还记得我吗', { userId });
      await env.ilink.waitForReply((m) => m.text.includes('还记得我吗'), 20_000);

      const spawns = env.fakeCodex.spawns();
      expect(resumeThreadIdOf(spawns[0].argv)).toBe('t-legacy-thread');
    },
    TEST_TIMEOUT,
  );
});

describe('e2e — 控制命令要能抢占', () => {
  it(
    '长任务中 /stop 立刻中止并给回执',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon({ FAKE_CODEX_SLOW_MS: '20000' });

      env.ilink.push('跑个长任务');
      await waitFor(() => env!.fakeCodex.spawns().length >= 1, 15_000, 'codex spawned');

      const t0 = Date.now();
      env.ilink.push('/stop');
      const ack = await env.ilink.waitForReply((m) => m.text.includes('已停止当前任务'), 15_000);

      // 排在长任务后面的 /stop 等于没有 /stop —— 这条守的就是抢占
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(ack.text).toContain('上下文保留');
      // 被打断的那一轮不该再吐正文
      expect(env.ilink.sent.some((m) => m.text.includes('跑个长任务'))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    '长任务中 /help 不排队，立刻回',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon({ FAKE_CODEX_SLOW_MS: '20000' });

      env.ilink.push('又一个长任务');
      await waitFor(() => env!.fakeCodex.spawns().length >= 1, 15_000, 'codex spawned');

      env.ilink.push('/help');
      const help = await env.ilink.waitForReply((m) => m.text.includes('可用命令'), 15_000);

      expect(help).toBeTruthy();
      // 长任务还在跑，正文一个字都还没出来
      expect(env.ilink.sent.some((m) => m.text.includes('又一个长任务'))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    '连发到超过积压上限时给背压回执，而不是默默攒着',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      await env.startDaemon({ FAKE_CODEX_SLOW_MS: '20000', CC2WECHAT_QUEUE_CAP: '4' });

      for (let i = 1; i <= 6; i++) env.ilink.push(`连发-${i}`);
      const backpressure = await env.ilink.waitForReply((m) => m.text.includes('排队'), 20_000);

      expect(backpressure.text).toContain('稍后再发');
      // 背压回执可能比子进程真正起来还快，所以先等第一轮落地再断言
      await waitFor(() => env!.fakeCodex.spawns().length >= 1, 15_000, 'first turn spawned');
      // 1 个在跑 + 4 个排队 = 同时只有一个子进程（同会话串行是上下文顺序的底线）
      expect(env.fakeCodex.spawns().length).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('e2e — 观测面', () => {
  it(
    '微信 errcode 不装成功：日志里要大声报错',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const daemon = await env.startDaemon();

      env.ilink.injectSendError(-14, 1);
      env.ilink.push('这条的回复会被平台吞掉');

      await daemon.waitForLog(/reply failed/, 20_000);
      expect(daemon.logs()).toContain('errcode=-14');
      // 平台确实收到了请求，只是回了个假成功 —— 两边都要看得见
      expect(env.ilink.sent.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    '/health 只听回环，且带上 agentHealth 与最近几轮',
    async () => {
      env = await setupE2e({ backend: 'codex-exec' });
      const daemon = await env.startDaemon();

      env.ilink.push('留一条 turn 记录');
      await env.ilink.waitForReply((m) => m.text.includes('留一条 turn 记录'), 20_000);

      const health = await daemon.health();
      expect(health.engine).toBe('v6');
      expect(health.agent).toBe('codex');
      expect(health.agentHealth).toBeDefined();
      expect(health.agentHealth.ok).toBe(true);

      // turns 环形缓冲：回复发出去之后才写，所以给它一点时间
      await waitFor(async () => (await daemon.health()).turns.length > 0, 10_000, 'turn ring filled');
      const withTurns = await daemon.health();
      expect(withTurns.turns.length).toBeGreaterThan(0);
      expect(withTurns.turns[0].outcome).toBe('final');
      expect(typeof withTurns.turns[0].totalMs).toBe('number');

      // 外网卡连不上（服务器没有防火墙，绑 0.0.0.0 = 把账号信息挂公网）
      const external = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
      if (external) {
        await expect(
          new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: external, port: env!.port, timeout: 800 });
            sock.on('connect', () => {
              sock.destroy();
              resolve('connected');
            });
            sock.on('error', reject);
            sock.on('timeout', () => {
              sock.destroy();
              reject(new Error('timeout'));
            });
          }),
        ).rejects.toBeTruthy();
      }
    },
    TEST_TIMEOUT,
  );
});

describe('e2e — 常驻 app-server（生产默认后端）', () => {
  it(
    '两轮之间不再 spawn，thread 复用',
    async () => {
      env = await setupE2e({ backend: 'codex', persona: 'app-server' });
      await env.startDaemon();

      env.ilink.push('第一问');
      await env.ilink.waitForReply((m) => m.text.includes('第一问'), 25_000);
      const afterFirst = env.fakeCodex.spawns().length;

      env.ilink.push('第二问');
      await env.ilink.waitForReply((m) => m.text.includes('第二问'), 25_000);

      expect(afterFirst).toBe(1);
      expect(env.fakeCodex.spawns()).toHaveLength(1); // 常驻就是这条断言
      expect(env.fakeCodex.spawns()[0].argv[0]).toBe('app-server');

      const calls = env.fakeCodex.rpcCalls();
      expect(calls.filter((c) => c.method === 'thread/start')).toHaveLength(1);
      const turns = calls.filter((c) => c.method === 'turn/start');
      expect(turns).toHaveLength(2);
      expect(turns[1].params.threadId).toBe(turns[0].params.threadId);
      // bypass 每轮都要带
      expect(turns[1].params.approvalPolicy).toBe('never');
      expect(turns[1].params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    },
    TEST_TIMEOUT,
  );

  it(
    '后端崩了会自动重启，并 thread/resume 把会话续回来',
    async () => {
      env = await setupE2e({ backend: 'codex', persona: 'app-server' });
      await env.startDaemon();

      env.ilink.push('先建立上下文');
      await env.ilink.waitForReply((m) => m.text.includes('先建立上下文'), 25_000);
      const threadId = env.fakeCodex.rpcCalls().find((c) => c.method === 'turn/start')!.params.threadId;

      env.ilink.push('这条会让后端 __CRASH__');
      await env.ilink.waitForReply((m) => m.text.includes('中途退出'), 25_000);

      env.ilink.push('崩完还能聊');
      await env.ilink.waitForReply((m) => m.text.includes('崩完还能聊'), 25_000);

      expect(env.fakeCodex.spawns()).toHaveLength(2); // 重启了一次
      const resumes = env.fakeCodex.rpcCalls().filter((c) => c.method === 'thread/resume');
      expect(resumes.length).toBeGreaterThanOrEqual(1);
      expect(resumes[resumes.length - 1].params.threadId).toBe(threadId);
      expect(resumes[resumes.length - 1].params.excludeTurns).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
