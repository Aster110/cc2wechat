/**
 * 真实数据形状的脱敏夹具。
 *
 * 全部抄自 2026-08-27 实测:
 * - 引擎注册表: ~/.claude/sessions/<pid>.json
 * - transcript: ~/.claude/projects/-Users-aster-AIproject-mylife/39015806-….jsonl
 *   (含一次完整「cross-session 注入探针 → assistant 回复」交换)
 *
 * 这里只留形状与关键字段,把账号 uuid / bridgeSessionId / 组织 id 换成假值。
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 引擎注册表
// ---------------------------------------------------------------------------

export interface EngineFixture {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  startedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
}

/** 与真实 ~/.claude/sessions/<pid>.json 同形 */
export function engineJson(f: EngineFixture): Record<string, unknown> {
  return {
    pid: f.pid,
    sessionId: f.sessionId,
    cwd: f.cwd,
    startedAt: f.startedAt ?? 1787822673477,
    procStart: 'Thu Aug 27 09:24:33 2026',
    version: f.version ?? '2.1.246',
    peerProtocol: 1,
    peerFeatures: ['notify_idle', 'artifact_yield'],
    kind: f.kind ?? 'interactive',
    entrypoint: f.entrypoint ?? 'claude-desktop',
    pidDomain: 'darwin',
    messagingSocketPath: `/tmp/cc-socks/${f.pid}.sock`,
    name: f.name ?? 'inbox-x',
    nameSource: 'derived',
    nameSince: f.startedAt ?? 1787822673477,
    bridgeSessionId: 'session_TESTFIXTURE0000',
  };
}

/** 把一批引擎写进夹具版 sessions 目录(连 .key 文件一起造,验证解析器会跳过它们) */
export function writeEngines(sessionsDir: string, engines: EngineFixture[]): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (const e of engines) {
    fs.writeFileSync(path.join(sessionsDir, `${e.pid}.json`), JSON.stringify(engineJson(e), null, 2));
    fs.writeFileSync(path.join(sessionsDir, `${e.pid}.deadbeef.key`), 'not-json-at-all');
  }
}

// ---------------------------------------------------------------------------
// transcript 记录
// ---------------------------------------------------------------------------

const SESSION = '39015806-bacd-41e5-abd0-b877a9c3332d';

function envelope(rec: Record<string, unknown>): Record<string, unknown> {
  return {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'claude-desktop',
    cwd: '/Users/aster/cc-wechat/inbox-test',
    sessionId: SESSION,
    version: '2.1.246',
    gitBranch: 'main',
    ...rec,
  };
}

/** app 收到 ccd send_message 时先落一条 enqueue,正文原样带着 —— 排队但还没轮到的证据 */
export function queueEnqueue(content: string, timestamp = '2026-08-27T08:27:18.729Z'): Record<string, unknown> {
  return { type: 'queue-operation', operation: 'enqueue', timestamp, sessionId: SESSION, content };
}

export function queueDequeue(timestamp = '2026-08-27T08:27:18.753Z'): Record<string, unknown> {
  return { type: 'queue-operation', operation: 'dequeue', timestamp, sessionId: SESSION };
}

/**
 * 跨会话注入落地成 user 记录:content 是**字符串**,外面裹一层
 * `Another Claude session sent a message:` + `<cross-session-message …>` 信封,
 * 并且带 isMeta:true。我们的 jobId 标记就藏在正文里。
 */
export function crossSessionUser(
  body: string,
  opts: { uuid?: string; parentUuid?: string | null; timestamp?: string } = {},
): Record<string, unknown> {
  const content =
    'Another Claude session sent a message:\n' +
    `<cross-session-message from="local_1a59c3a1-e104-4d31-a32e-41a79c90c4fa" name="cc2wechat 网关" encoded="1">\n` +
    `${body}\n` +
    '</cross-session-message>\n\n' +
    'This came from another Claude session — not typed by your user.';
  return envelope({
    type: 'user',
    parentUuid: opts.parentUuid ?? null,
    isMeta: true,
    message: { role: 'user', content },
    uuid: opts.uuid ?? 'fdc035f9-abe8-45a8-91ee-6c8a28f42fc8',
    timestamp: opts.timestamp ?? '2026-08-27T08:27:20.826Z',
    promptSource: 'sdk',
    // 实测:被注入的记录带 origin.kind=peer + hostInjected
    origin: { kind: 'peer', from: 'local_1a59c3a1-e104-4d31-a32e-41a79c90c4fa', hostInjected: true, fromMode: 'bypass' },
    promptId: 'c2e38739-448f-45e5-b5f9-5055d2067f5a',
    permissionMode: 'bypassPermissions',
  });
}

/** 人在 app 里手敲的一条(content 也是字符串,没有 isMeta) */
export function humanUser(text: string, uuid = 'aaaa1111-2222-3333-4444-555566667777'): Record<string, unknown> {
  return envelope({
    type: 'user',
    parentUuid: null,
    message: { role: 'user', content: text },
    uuid,
    timestamp: '2026-08-27T08:30:00.000Z',
  });
}

/**
 * 工具结果回填 —— 也是 type:'user',但 content 是**数组**(tool_result 块)。
 * 一轮里有多少次工具调用就有多少条,数量远超真正的人类 prompt。
 * 谁要是把"看见 user 记录就当新一轮开始",这里就是坑。
 */
export function toolResultUser(toolUseId = 'toolu_x'): Record<string, unknown> {
  return envelope({
    type: 'user',
    parentUuid: 'b487e247-4073-45e5-b065-60c0f01dcf99',
    promptId: 'c2e38739-448f-45e5-b5f9-5055d2067f5a',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    uuid: 'cccc1111-2222-3333-4444-555566667777',
    timestamp: '2026-08-27T08:27:23.000Z',
  });
}

export interface AssistantFixture {
  /** 文本块;给了 tools 就同时带 tool_use 块 */
  text?: string;
  thinking?: string;
  tools?: Array<{ name: string; input?: Record<string, unknown> }>;
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | null;
  /** 同一条 message 被拆成多行时,几行共享同一个 id —— 真实数据就是这样 */
  messageId?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
}

export function assistant(f: AssistantFixture): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (f.thinking != null) content.push({ type: 'thinking', thinking: f.thinking, signature: 'sig' });
  if (f.text != null) content.push({ type: 'text', text: f.text });
  for (const t of f.tools ?? []) {
    content.push({ type: 'tool_use', id: `toolu_${t.name}`, name: t.name, input: t.input ?? {} });
  }
  return envelope({
    type: 'assistant',
    parentUuid: f.parentUuid ?? 'fdc035f9-abe8-45a8-91ee-6c8a28f42fc8',
    requestId: 'req_011CeSwG7uBbEihLXFhQRv83',
    effort: 'high',
    message: {
      id: f.messageId ?? 'msg_011CeSwGHQgLxbsCdtKxDCRT',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content,
      stop_reason: f.stopReason === undefined ? 'end_turn' : f.stopReason,
      stop_sequence: null,
      usage: { input_tokens: 2, cache_read_input_tokens: 37570, output_tokens: 16 },
    },
    uuid: f.uuid ?? 'fee73771-c6a6-45d9-98e9-19a0edb0e0a7',
    timestamp: f.timestamp ?? '2026-08-27T08:27:26.248Z',
  });
}

/** 真实 transcript 里 assistant 之间还夹着这些"噪音"记录,解析器必须视而不见 */
export function noise(): Array<Record<string, unknown>> {
  return [
    envelope({
      type: 'attachment',
      parentUuid: 'fdc035f9-abe8-45a8-91ee-6c8a28f42fc8',
      attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', content: '<current-time>…</current-time>' },
      uuid: '0f389df8-022c-4cb7-a6c2-284a11c09ac8',
      timestamp: '2026-08-27T08:27:20.826Z',
    }),
    { type: 'custom-title', customTitle: '收件箱', sessionId: SESSION },
    {
      type: 'bridge-session',
      sessionId: SESSION,
      bridgeSessionId: 'cse_TESTFIXTURE',
      lastSequenceNum: 0,
      ownerAccountUuid: '00000000-0000-0000-0000-000000000000',
      ownerOrganizationUuid: '00000000-0000-0000-0000-000000000000',
    },
    { type: 'last-prompt', lastPrompt: '…', leafUuid: '4416eca6-db17-44bd-9aba-d8be1f8400c6', sessionId: SESSION },
    { type: 'atis-latch', atis: '', sessionId: SESSION },
  ];
}

// ---------------------------------------------------------------------------
// 落盘小工具
// ---------------------------------------------------------------------------

export function appendJsonl(file: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
}

/** 写半行(模拟正在写盘被我们撞上) */
export function appendPartial(file: string, text: string): void {
  fs.appendFileSync(file, text, 'utf-8');
}
