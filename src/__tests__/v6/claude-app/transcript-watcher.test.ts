import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CcRegistry } from '../../../v6/claude-app/cc-registry.js';
import {
  TranscriptWatcher,
  TurnScanner,
  parseJsonl,
  jobMarker,
} from '../../../v6/claude-app/transcript-watcher.js';
import {
  appendJsonl,
  appendPartial,
  assistant,
  crossSessionUser,
  humanUser,
  noise,
  queueDequeue,
  queueEnqueue,
  toolResultUser,
  writeEngines,
} from './fixtures.js';

let root: string;
let sessionsDir: string;
let projectsDir: string;
const CWD = '/inbox/a';
const CLI_ID = 'cli-aaa';

function jsonlPath(): string {
  return path.join(projectsDir, '-inbox-a', `${CLI_ID}.jsonl`);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-watcher-')));
  sessionsDir = path.join(root, 'sessions');
  projectsDir = path.join(root, 'projects');
  fs.mkdirSync(path.join(projectsDir, '-inbox-a'), { recursive: true });
  writeEngines(sessionsDir, [{ pid: 111, sessionId: CLI_ID, cwd: CWD, name: 'inbox-a' }]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function watcher(): TranscriptWatcher {
  return new TranscriptWatcher({
    registry: new CcRegistry({ sessionsDir, projectsDir, isAlive: () => true }),
  });
}

/** 测试里全用毫秒级参数,真实默认是 5s 静默 / 180s 硬超时 */
const FAST = { pollMs: 5, settleMs: 30, silenceMs: 120, timeoutMs: 3_000, engineWaitMs: 1_000 };

describe('jobMarker —— jobId 兼作 transcript 锚点与去重键', () => {
  it('形如 job:<id>', () => {
    expect(jobMarker('abc')).toBe('job:abc');
  });
});

describe('parseJsonl —— 只吃完整行,半行留到下次', () => {
  it('解析出记录并报告消费掉的字节数', () => {
    const buf = `${JSON.stringify({ type: 'a' })}\n${JSON.stringify({ type: 'b' })}\n`;
    const r = parseJsonl(buf);
    expect(r.records).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(r.consumed).toBe(Buffer.byteLength(buf));
  });

  it('结尾半行不消费(下一轮补齐再吃)', () => {
    const full = `${JSON.stringify({ type: 'a' })}\n`;
    const r = parseJsonl(`${full}{"type":"hal`);
    expect(r.records).toEqual([{ type: 'a' }]);
    expect(r.consumed).toBe(Buffer.byteLength(full));
  });

  it('坏行跳过,不把整个 tail 带崩', () => {
    const r = parseJsonl(`不是json\n${JSON.stringify({ type: 'ok' })}\n`);
    expect(r.records).toEqual([{ type: 'ok' }]);
  });

  it('中文按字节数算 consumed(offset 是字节不是字符)', () => {
    const line = `${JSON.stringify({ t: '你好' })}\n`;
    expect(parseJsonl(line).consumed).toBe(Buffer.byteLength(line));
  });
});

// ---------------------------------------------------------------------------
// 纯状态机
// ---------------------------------------------------------------------------

describe('TurnScanner —— 完成判据:assistant.message.stop_reason === "end_turn"', () => {
  const MARKER = 'job:J1';

  it('没见到锚点前,什么都不算数', () => {
    const s = new TurnScanner(MARKER);
    s.push(assistant({ text: '这是上一轮的回复' }), 1);
    expect(s.anchored).toBe(false);
    expect(s.terminal).toBe(false);
    expect(s.answer()).toBe('');
  });

  it('锚点 = 含 jobId 的 user 记录(跨会话注入信封)', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(`[微信|kiki|${MARKER}|123] 在吗`), 1);
    expect(s.anchored).toBe(true);
  });

  it('锚点之后的 end_turn 文本就是答案', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(`[微信|kiki|${MARKER}|123] 在吗`), 1);
    s.push(assistant({ text: '在的', stopReason: 'end_turn' }), 2);
    expect(s.terminal).toBe(true);
    expect(s.answer()).toBe('在的');
  });

  it('stop_reason=tool_use 不是终点(工具还要接着跑)', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(assistant({ text: '我查一下', tools: [{ name: 'Read' }], stopReason: 'tool_use' }), 2);
    expect(s.terminal).toBe(false);
  });

  it('工具调用产出 progress,正文里的中间叙述不当成最终答案', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(assistant({ text: '我查一下', tools: [{ name: 'Read' }], stopReason: 'tool_use' }), 2);
    s.push(toolResultUser(), 3);
    s.push(assistant({ text: '查完了：42', stopReason: 'end_turn', messageId: 'msg_final' }), 4);
    expect(s.takeProgress()).toEqual(['工具 Read']);
    expect(s.answer()).toBe('查完了：42');
  });

  it('takeProgress 取一次就清空', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(assistant({ tools: [{ name: 'Bash' }], stopReason: 'tool_use' }), 2);
    expect(s.takeProgress()).toEqual(['工具 Bash']);
    expect(s.takeProgress()).toEqual([]);
  });

  it('一条 message 被拆成多行(共享 message.id)时,文本要合起来', () => {
    // 实测:end_turn 的那条 message 会先落一行 thinking,再落一行 text,两行同 id
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(assistant({ thinking: '想想', stopReason: 'end_turn', messageId: 'msg_z' }), 2);
    expect(s.answer()).toBe(''); // 只有 thinking,还没等到正文
    s.push(assistant({ text: '答案在这', stopReason: 'end_turn', messageId: 'msg_z' }), 3);
    expect(s.answer()).toBe('答案在这');
  });

  it('多个文本块拼起来', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(assistant({ text: '第一段', stopReason: 'end_turn', messageId: 'm' }), 2);
    s.push(assistant({ text: '第二段', stopReason: 'end_turn', messageId: 'm' }), 3);
    expect(s.answer()).toBe('第一段\n第二段');
  });

  it('end_turn 那条没正文时,退回锚点之后最后一段有内容的文本', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(assistant({ text: '先说一句', tools: [{ name: 'Bash' }], stopReason: 'tool_use', messageId: 'm1' }), 2);
    s.push(assistant({ thinking: '……', stopReason: 'end_turn', messageId: 'm2' }), 3);
    expect(s.terminal).toBe(true);
    expect(s.answer()).toBe('先说一句');
  });

  it('refusal / stop_sequence 也是终点', () => {
    for (const sr of ['refusal', 'stop_sequence'] as const) {
      const s = new TurnScanner(MARKER);
      s.push(crossSessionUser(MARKER), 1);
      s.push(assistant({ text: 'x', stopReason: sr }), 2);
      expect(s.terminal).toBe(true);
    }
  });

  it('max_tokens 不当终点(agent 循环可能还会续),交给静默兜底', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(assistant({ text: '写到一半', stopReason: 'max_tokens' }), 2);
    expect(s.terminal).toBe(false);
    expect(s.answer()).toBe('写到一半');
  });

  it('tool_result 那种数组 content 的 user 记录不是新一轮', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(toolResultUser(), 2);
    expect(s.nextJobStarted).toBe(false);
  });

  it('人在 app 里手敲的一句也不当边界(只是插队,我们的回复可能还在后面)', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    s.push(humanUser('你好'), 2);
    expect(s.nextJobStarted).toBe(false);
  });

  it('看到**另一条** cc2wechat 信封 = 我们这轮没戏了,立刻收边界', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(`[微信|kiki|${MARKER}|1] 一`), 1);
    s.push(crossSessionUser('[微信|kiki|job:J2|2] 二'), 2);
    expect(s.nextJobStarted).toBe(true);
  });

  it('只见到 queue-operation enqueue = 排队中,还没轮到', () => {
    const s = new TurnScanner(MARKER);
    s.push(queueEnqueue(`[微信|kiki|${MARKER}|1] 在吗`), 1);
    expect(s.anchored).toBe(false);
    expect(s.queued).toBe(true);
    s.push(queueDequeue(), 2);
    s.push(crossSessionUser(`[微信|kiki|${MARKER}|1] 在吗`), 3);
    expect(s.anchored).toBe(true);
  });

  it('attachment / bridge-session / custom-title 这些噪音一概无视', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 1);
    for (const n of noise()) s.push(n, 2);
    expect(s.terminal).toBe(false);
    expect(s.answer()).toBe('');
  });

  it('记录时刻用于静默判定', () => {
    const s = new TurnScanner(MARKER);
    s.push(crossSessionUser(MARKER), 10);
    s.push(assistant({ text: 'x', stopReason: 'tool_use' }), 42);
    expect(s.lastActivityAt).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 轮询循环
// ---------------------------------------------------------------------------

describe('TranscriptWatcher.watch —— 热引擎', () => {
  it('抓到回复并报告是靠 end_turn 结束的', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [
      queueEnqueue('[微信|kiki|job:J1|1] 在吗'),
      queueDequeue(),
      crossSessionUser('[微信|kiki|job:J1|1] 在吗'),
      ...noise(),
      assistant({ text: '在的，说', stopReason: 'end_turn' }),
    ]);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST });
    expect(r).toMatchObject({ ok: true, text: '在的，说', doneBy: 'end_turn' });
    expect((r as { transcript: string }).transcript).toBe(jsonlPath());
  });

  it('回复是边写边追加的,也能等到', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [crossSessionUser('[微信|kiki|job:J1|1] 算一下')]);
    setTimeout(() => appendJsonl(jsonlPath(), [assistant({ tools: [{ name: 'Bash' }], stopReason: 'tool_use' })]), 15);
    setTimeout(() => appendJsonl(jsonlPath(), [assistant({ text: '42', stopReason: 'end_turn', messageId: 'm2' })]), 40);

    const progress: string[] = [];
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, onProgress: (t) => progress.push(t), ...FAST });
    expect(r).toMatchObject({ ok: true, text: '42' });
    expect(progress).toContain('工具 Bash');
  });

  it('end_turn 之后还等一个 settle 窗口,把拆行的正文收齐', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [
      crossSessionUser('[微信|kiki|job:J1|1] 在吗'),
      assistant({ thinking: '想', stopReason: 'end_turn', messageId: 'msg_split' }),
    ]);
    setTimeout(() => appendJsonl(jsonlPath(), [assistant({ text: '正文来了', stopReason: 'end_turn', messageId: 'msg_split' })]), 12);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST, settleMs: 80 });
    expect(r).toMatchObject({ ok: true, text: '正文来了' });
  });

  it('写到一半的行不会被当成坏数据丢掉', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [crossSessionUser('[微信|kiki|job:J1|1] 在吗')]);
    const rec = JSON.stringify(assistant({ text: '完整了', stopReason: 'end_turn' }));
    appendPartial(jsonlPath(), rec.slice(0, 40));
    setTimeout(() => appendPartial(jsonlPath(), `${rec.slice(40)}\n`), 15);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST });
    expect(r).toMatchObject({ ok: true, text: '完整了' });
  });

  it('baseline 之前的历史不参与(锚点只认这次注入)', async () => {
    // 先写一段"上一轮"的历史,而且里面就有同名 marker(极端情况:重放同一个 jobId)
    appendJsonl(jsonlPath(), [
      crossSessionUser('[微信|kiki|job:J1|1] 老的'),
      assistant({ text: '老答案', stopReason: 'end_turn' }),
    ]);
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [
      crossSessionUser('[微信|kiki|job:J1|2] 新的'),
      assistant({ text: '新答案', stopReason: 'end_turn', messageId: 'm2' }),
    ]);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST });
    expect(r).toMatchObject({ ok: true, text: '新答案' });
  });
});

describe('TranscriptWatcher.watch —— 静默兜底(完成判据的第二道)', () => {
  it('没有 end_turn 但静默够久,把攒到的正文交出去,并标记 doneBy=silence', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [
      crossSessionUser('[微信|kiki|job:J1|1] 在吗'),
      // 老版本 app 可能不写 stop_reason
      assistant({ text: '在的', stopReason: null }),
    ]);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST, silenceMs: 60 });
    expect(r).toMatchObject({ ok: true, text: '在的', doneBy: 'silence' });
  });

  it('静默但一个字都没有 → 继续等到硬超时,不交白卷', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [crossSessionUser('[微信|kiki|job:J1|1] 在吗')]);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST, silenceMs: 20, timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, code: 'claude-app-turn-timeout' });
  });
});

describe('TranscriptWatcher.watch —— 负例', () => {
  it('硬超时:注入进去了但收件箱一直没回', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [queueEnqueue('[微信|kiki|job:J1|1] 在吗')]);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST, timeoutMs: 120 });
    expect(r).toMatchObject({ ok: false, code: 'claude-app-turn-timeout' });
    // 排队信息要进错误正文,否则运维分不清"没送到"和"没轮到"
    expect((r as { error: string }).error).toContain('排队');
  });

  it('引擎压根没起来 → 明确报错,不要干等', async () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    const w = watcher();
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: w.baseline(CWD), ...FAST, engineWaitMs: 40, timeoutMs: 120 });
    expect(r).toMatchObject({ ok: false, code: 'claude-app-no-engine' });
  });

  it('/stop:abort 之后立刻返回 aborted', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [crossSessionUser('[微信|kiki|job:J1|1] 在吗')]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST, timeoutMs: 5_000, signal: ac.signal });
    expect(r).toMatchObject({ ok: false, code: 'claude-app-aborted' });
  });

  it('后一条 job 的信封先到 = 这轮被越过,别把别人的答案发给他', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    appendJsonl(jsonlPath(), [
      crossSessionUser('[微信|kiki|job:J1|1] 一'),
      crossSessionUser('[微信|kiki|job:J2|2] 二'),
      assistant({ text: '这是回给 J2 的', stopReason: 'end_turn' }),
    ]);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST });
    expect(r).toMatchObject({ ok: false, code: 'claude-app-turn-skipped' });
  });
});

describe('TranscriptWatcher.watch —— 冷唤醒(CLI id 换了 / 引擎后起)', () => {
  it('注入时没有活引擎,等它起来再定位 jsonl', async () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    const w = watcher();
    const base = w.baseline(CWD);

    setTimeout(() => {
      writeEngines(sessionsDir, [{ pid: 777, sessionId: 'cli-cold', cwd: CWD }]);
      appendJsonl(path.join(projectsDir, '-inbox-a', 'cli-cold.jsonl'), [
        crossSessionUser('[微信|kiki|job:J1|1] 醒醒'),
        assistant({ text: '醒了', stopReason: 'end_turn' }),
      ]);
    }, 25);

    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST, engineWaitMs: 1_000 });
    expect(r).toMatchObject({ ok: true, text: '醒了' });
    expect((r as { transcript: string }).transcript).toContain('cli-cold.jsonl');
  });

  it('唤醒后换了 CLI id,答案落在新文件里也能捡到(不缓存旧映射)', async () => {
    const w = watcher();
    const base = w.baseline(CWD);
    // 老文件里塞点无关内容,证明我们不是碰巧读对了
    appendJsonl(jsonlPath(), [assistant({ text: '上一代的尾巴', stopReason: 'end_turn' })]);
    writeEngines(sessionsDir, [{ pid: 888, sessionId: 'cli-new', cwd: CWD, startedAt: 99_999 }]);
    appendJsonl(path.join(projectsDir, '-inbox-a', 'cli-new.jsonl'), [
      crossSessionUser('[微信|kiki|job:J1|1] 在吗'),
      assistant({ text: '新引擎答的', stopReason: 'end_turn', messageId: 'm2' }),
    ]);
    const r = await w.watch({ cwd: CWD, marker: 'job:J1', baseline: base, ...FAST });
    expect(r).toMatchObject({ ok: true, text: '新引擎答的' });
  });
});

describe('TranscriptWatcher.baseline', () => {
  it('记下已有文件的字节数,新文件从 0 起', () => {
    appendJsonl(jsonlPath(), [assistant({ text: 'old' })]);
    const b = watcher().baseline(CWD);
    expect(b[jsonlPath()]).toBe(fs.statSync(jsonlPath()).size);
    expect(b[path.join(projectsDir, '-inbox-a', 'never-seen.jsonl')]).toBeUndefined();
  });

  it('目录还不存在时给空基线而不是抛', () => {
    expect(watcher().baseline('/inbox/never')).toEqual({});
  });
});
