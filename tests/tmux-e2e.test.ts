/**
 * Tmux Delivery 端到端测试
 *
 * 测试完整的 deliver() 流程：
 * - 模拟微信消息 → TmuxDelivery.deliver()
 * - 验证 tmux session 被创建且命令在里面跑
 * - 验证消息注入到已有 session
 * - 验证 closeSession/shutdown 清理
 *
 * 使用 mock backend（避免真的启动 Claude Code），但 tmux 是真实的。
 *
 * ⚠️ 默认跳过，要跑得显式开：`RUN_TMUX_E2E=1 npx vitest run tests/tmux-e2e.test.ts`
 *
 * 为什么默认跳过：这个文件操作的是真 tmux，而开发机上很可能正跑着真的 cc2wechat
 * daemon。它原来的清理逻辑会 kill 掉**所有** `cc2w-` 开头的 session、并删掉
 * `/tmp/cc2wechat-tmux-*.json`——那正是生产 daemon 的会话和状态文件。被误杀后
 * daemon 会重建会话、重新拉起 claude，没登录态的 claude 就弹浏览器要授权。
 * 2026-08-07 实测就是这么让 aster 的浏览器反复弹登录页的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { TmuxDelivery } from '../src/v5/deliveries/tmux/tmux-delivery.js';
import type { AIBackend, LaunchOpts, ChatOpts, PipeOpts, BackendEvent, MessageContext } from '../src/v5/interfaces/index.js';

// Mock backend: buildLaunchCommand 返回一个简单的 bash 命令（不启动 Claude）
const mockBackend: AIBackend = {
  name: 'mock',
  buildLaunchCommand(opts: LaunchOpts): string {
    // 启动一个持久 bash，方便验证 session 存活
    return `bash -c 'echo "mock-claude-session-${opts.sessionId.slice(0, 8)}"; exec bash'`;
  },
  async *chat(_opts: ChatOpts): AsyncIterable<BackendEvent> {
    yield { type: 'result', text: 'mock response' };
  },
  buildPipeCommand(_opts: PipeOpts): string {
    return 'echo mock';
  },
  extractResult(_events: BackendEvent[]): string {
    return 'mock';
  },
};

function makeCtx(userId: string, text: string): MessageContext {
  return {
    userId,
    text,
    sessionId: `sid-${userId}`,
    mediaFiles: [],
    contextToken: 'test-token',
    rawMessage: {},
    account: {},
    cwd: '/tmp',
    accountName: 'test',
  };
}

function listTmuxSessions(): string[] {
  try {
    const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe.skipIf(!process.env.RUN_TMUX_E2E)('TmuxDelivery E2E', () => {
  let delivery: TmuxDelivery;

  // 每个测试前先清理所有残留的 cc2w- session + 磁盘文件，避免跨测试污染
  beforeEach(() => {
    const sessions = listTmuxSessions();
    for (const s of sessions) {
      if (s.startsWith('cc2w-')) {
        try { execSync(`tmux kill-session -t "${s}"`); } catch { /* ok */ }
      }
    }
    // 清理磁盘 session 文件，防止新 TmuxDelivery 加载到上一个测试的残留数据
    try { fs.unlinkSync('/tmp/cc2wechat-tmux-18081.json'); } catch { /* ok */ }
    try { fs.unlinkSync('/tmp/cc2wechat-tmux.json'); } catch { /* ok */ }
  });

  afterEach(async () => {
    // 清理所有 cc2w- 开头的 tmux session
    if (delivery) {
      await delivery.shutdown();
    }
    const sessions = listTmuxSessions();
    for (const s of sessions) {
      if (s.startsWith('cc2w-')) {
        try { execSync(`tmux kill-session -t "${s}"`); } catch { /* ok */ }
      }
    }
  });

  it('deliver() creates a tmux session for new user', async () => {
    delivery = new TmuxDelivery();
    const ctx = makeCtx('e2e-user-1', '你好，帮我写个函数');

    const result = await delivery.deliver(ctx, mockBackend);

    // 应该返回 selfReplied: true
    expect(result.selfReplied).toBe(true);
    expect(result.text).toBe('');

    // 验证 tmux session 存在
    const sessions = listTmuxSessions();
    const match = sessions.find(s => s.startsWith('cc2w-'));
    expect(match).toBeDefined();
  }, 15000);

  it('deliver() injects message into existing session', async () => {
    delivery = new TmuxDelivery();
    const ctx1 = makeCtx('e2e-user-2', '第一条消息');

    // 第一次 deliver 创建 session
    await delivery.deliver(ctx1, mockBackend);

    // 第二次 deliver 应该注入到同一个 session（不创建新的）
    const ctx2 = makeCtx('e2e-user-2', '第二条消息');
    const result = await delivery.deliver(ctx2, mockBackend);

    expect(result.selfReplied).toBe(true);

    // 应该只有 1 个 cc2w- session（不是 2 个）
    const sessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(sessions.length).toBe(1);
  }, 25000);

  it('closeSession() kills the tmux session', async () => {
    delivery = new TmuxDelivery();
    const ctx = makeCtx('e2e-user-3', '会被关掉的消息');

    await delivery.deliver(ctx, mockBackend);

    // 确认 session 存在
    let sessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(sessions.length).toBe(1);

    // 关闭
    await delivery.closeSession('e2e-user-3');

    // 确认 session 消失
    sessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(sessions.length).toBe(0);
  }, 15000);

  it('deliver() recreates session if tmux session was killed externally', async () => {
    delivery = new TmuxDelivery();
    const ctx = makeCtx('e2e-user-4', '第一条');

    await delivery.deliver(ctx, mockBackend);

    // 模拟外部 kill（用户手动关了 tmux）
    const sessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    for (const s of sessions) {
      execSync(`tmux kill-session -t "${s}"`);
    }

    // 再发消息，应该自动重建
    const ctx2 = makeCtx('e2e-user-4', '第二条，session 已被 kill');
    const result = await delivery.deliver(ctx2, mockBackend);

    expect(result.selfReplied).toBe(true);

    // 新 session 应该存在
    const newSessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(newSessions.length).toBe(1);
  }, 30000);

  it('two users get independent sessions', async () => {
    delivery = new TmuxDelivery();

    await delivery.deliver(makeCtx('e2e-alice', 'alice的消息'), mockBackend);
    await delivery.deliver(makeCtx('e2e-bob', 'bob的消息'), mockBackend);

    const sessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(sessions.length).toBe(2);

    // 关闭 alice 不影响 bob
    await delivery.closeSession('e2e-alice');
    const remaining = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(remaining.length).toBe(1);
  }, 30000);

  it('shutdown() cleans up all sessions', async () => {
    delivery = new TmuxDelivery();

    await delivery.deliver(makeCtx('e2e-s1', '消息1'), mockBackend);
    await delivery.deliver(makeCtx('e2e-s2', '消息2'), mockBackend);

    let sessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(sessions.length).toBe(2);

    await delivery.shutdown();

    sessions = listTmuxSessions().filter(s => s.startsWith('cc2w-'));
    expect(sessions.length).toBe(0);
  }, 30000);
});
