/**
 * 假的 `codex` 可执行文件 —— e2e 用。
 *
 * 写一个**无扩展名 + 0o755** 的 `codex` 到 dir,调用方把 dir 前置到 PATH,
 * daemon 的 `spawn('codex', ...)` 就会打到它身上(codex-exec.ts 走 PATH 查找)。
 *
 * 无扩展名 → node 按 **CJS** 解析,所以 shim 里只能 `require`,不能 `import`。
 *
 * 两种人格,按 `process.argv[2]` 分:
 * - `exec`       → 吐 codex-exec.ts 认识的 JSONL(thread.started / item.completed / turn.completed)
 * - `app-server` → stdin/stdout 换行分隔 JSON-RPC 2.0(**不是 LSP 分帧**)
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SpawnRecord {
  at: number;
  pid: number;
  /** codex 的参数,即 `process.argv.slice(2)`(不含 node 与 shim 路径) */
  argv: string[];
}

export interface RpcCall {
  at: number;
  method: string;
  params: any;
}

export interface InstallFakeCodexOptions {
  /** spawn 日志(JSONL)路径,默认 `<dir>/_fake-codex/spawns.jsonl` */
  logPath?: string;
  /** 跨进程状态目录(threads.json 在这),默认 `<dir>/_fake-codex` */
  statePath?: string;
  /**
   * argv[2] 既不是 exec 也不是 app-server 时的兜底人格。
   * 不设 → 只记一行 spawn 日志然后干净退出(exit 0)。
   */
  defaultPersona?: 'exec' | 'app-server';
}

export interface FakeCodex {
  binDir: string;
  /** JSONL,每次 spawn 一行 */
  logPath: string;
  /** 跨进程/跨重启共享的状态目录(threads.json) */
  statePath: string;
  /** app-server 人格收到的每一行请求(JSONL) */
  rpcLogPath: string;
  /** 那个可执行文件本身 */
  binPath: string;
  /** 读 logPath,返回每次 spawn 的记录 */
  spawns(): SpawnRecord[];
  /** app-server 人格下解析出的请求记录(threadId 传对没传对靠它断言) */
  rpcCalls(): RpcCall[];
}

// ---------------------------------------------------------------------------
// shim 源码。**运行期生成的 CJS 字符串**,不参与 tsc 编译。
// 里面刻意不用模板字符串,省掉一层转义地狱。
// ---------------------------------------------------------------------------
const SHIM_SOURCE = `#!/usr/bin/env node
'use strict';
/* fake codex — e2e only. 无扩展名 => node 按 CJS 跑,只能 require。 */

var fs = require('fs');
var path = require('path');

var LOG = process.env.FAKE_CODEX_LOG || '';
var STATE = process.env.FAKE_CODEX_STATE || '';
var RPC = LOG ? path.join(path.dirname(LOG), 'rpc.jsonl') : (STATE ? path.join(STATE, 'rpc.jsonl') : '');

function appendLine(file, obj) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\\n');
  } catch (e) { /* 日志写不进去也不该把假 codex 弄崩 */ }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

function outThen(obj, cb) {
  process.stdout.write(JSON.stringify(obj) + '\\n', cb);
}

// ---- 线程注册表(跨进程/跨重启共享)-------------------------------------
function statePath() {
  return STATE ? path.join(STATE, 'threads.json') : '';
}

function readState() {
  var p = statePath();
  if (!p) return { threads: [], seq: 0 };
  try {
    var s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!s || typeof s !== 'object') return { threads: [], seq: 0 };
    if (!Array.isArray(s.threads)) s.threads = [];
    if (typeof s.seq !== 'number') s.seq = 0;
    return s;
  } catch (e) {
    return { threads: [], seq: 0 };
  }
}

function writeState(s) {
  var p = statePath();
  if (!p) return;
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s));
  } catch (e) { /* ignore */ }
}

function newThreadId() {
  var s = readState();
  s.seq = s.seq + 1;
  var id = 't-' + process.pid + '-' + s.seq;
  s.threads.push(id);
  writeState(s);
  return id;
}

function rememberThread(id) {
  if (!id) return;
  var s = readState();
  if (s.threads.indexOf(id) < 0) {
    s.threads.push(id);
    writeState(s);
  }
}

function hasThread(id) {
  if (!id) return false;
  return readState().threads.indexOf(id) >= 0;
}

// ---- 分片 sleep:别用同步忙等,SIGKILL 要打得中 ---------------------------
function sleepChunks(totalMs, isCancelled, done) {
  if (!totalMs || totalMs <= 0) return done(false);
  var left = totalMs;
  (function tick() {
    if (isCancelled && isCancelled()) return done(true);
    if (left <= 0) return done(false);
    var step = left < 50 ? left : 50;
    left -= step;
    setTimeout(tick, step);
  })();
}

function envMs(name) {
  var n = Number(process.env[name] || 0);
  return isFinite(n) && n > 0 ? n : 0;
}

// ---- 人格 1:exec --------------------------------------------------------
function runExec(argv) {
  var isResume = argv[1] === 'resume';
  var dash = argv.indexOf('--');
  var tail = dash >= 0 ? argv.slice(dash + 1) : [];
  var threadId = '';
  var text = '';
  if (isResume) {
    threadId = tail[0] || '';
    text = tail.slice(1).join(' ');
  } else {
    text = tail.join(' ');
  }

  var tid = threadId || newThreadId();
  rememberThread(tid);
  out({ type: 'thread.started', thread_id: tid });

  sleepChunks(envMs('FAKE_CODEX_SLOW_MS'), null, function () {
    if (process.env.FAKE_CODEX_FAIL === '1') {
      out({ type: 'turn.failed', error: { message: 'injected failure' } });
      process.exitCode = 1;
      return;
    }
    out({ type: 'item.completed', item: { type: 'agent_message', text: 'echo:' + text.slice(0, 200) } });
    out({ type: 'turn.completed' });
    // 故意赖着不退:证明上层不等进程退出就能出结果
    var linger = envMs('FAKE_CODEX_LINGER_MS');
    if (linger > 0) setTimeout(function () { /* 到点自然退 */ }, linger);
  });
}

// ---- 人格 2:app-server(换行分隔 JSON-RPC 2.0)--------------------------
function runAppServer() {
  var readline = require('readline');
  var memThreads = [];
  var turnSeq = 0;
  var active = null; // { turnId, threadId, cancelled }

  function reply(id, result) {
    if (id === undefined || id === null) return;
    out({ jsonrpc: '2.0', id: id, result: result });
  }
  function replyErr(id, code, message) {
    if (id === undefined || id === null) return;
    out({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
  }
  function notify(method, params) {
    out({ jsonrpc: '2.0', method: method, params: params });
  }
  function inputText(input) {
    var list = Array.isArray(input) ? input : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].type === 'text') return String(list[i].text || '');
    }
    return '';
  }
  function chunks(s) {
    if (!s) return [''];
    var n = s.length >= 3 ? 3 : 2;
    var size = Math.ceil(s.length / n);
    var parts = [];
    for (var i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
    return parts.length ? parts : [''];
  }
  function soon(fn) { setTimeout(fn, 0); }

  function runTurn(threadId, turnId, text, startedAt) {
    var answer = 'echo:' + text.slice(0, 200);
    var umId = 'um-' + process.pid + '-' + turnSeq;
    var msgId = 'msg-' + process.pid + '-' + turnSeq;
    var turnShell = {
      id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress',
      error: null, startedAt: startedAt, completedAt: null, durationMs: null,
    };
    var userItem = {
      type: 'userMessage', id: umId, clientId: null,
      content: [{ type: 'text', text: text, text_elements: [] }],
    };
    var agentItem = {
      type: 'agentMessage', id: msgId, text: answer,
      phase: 'final_answer', memoryCitation: null,
    };

    function cancelled() { return !active || active.cancelled; }

    function finish(interrupted) {
      var completedAt = Math.floor(Date.now() / 1000);
      notify('turn/completed', {
        threadId: threadId,
        turn: {
          id: turnId,
          items: interrupted ? [] : [agentItem],
          itemsView: 'summary',
          status: interrupted ? 'interrupted' : 'completed',
          error: null,
          startedAt: startedAt,
          completedAt: completedAt,
          durationMs: (completedAt - startedAt) * 1000,
        },
      });
      active = null;
    }

    soon(function () {
      if (cancelled()) return finish(true);
      notify('turn/started', { threadId: threadId, turn: turnShell });
      notify('item/started', {
        item: userItem, threadId: threadId, turnId: turnId, startedAtMs: Date.now(),
      });
      notify('item/completed', {
        item: userItem, threadId: threadId, turnId: turnId, completedAtMs: Date.now(),
      });
      var parts = chunks(answer);
      for (var i = 0; i < parts.length; i++) {
        notify('item/agentMessage/delta', {
          threadId: threadId, turnId: turnId, itemId: msgId, delta: parts[i],
        });
      }
      sleepChunks(envMs('FAKE_CODEX_SLOW_MS'), cancelled, function (wasCancelled) {
        if (wasCancelled || cancelled()) return finish(true);
        notify('item/completed', {
          item: agentItem, threadId: threadId, turnId: turnId, completedAtMs: Date.now(),
        });
        // 必须发:用来验证它不会被当成错误
        notify('account/rateLimits/updated', {
          rateLimits: {
            limitId: 'codex', limitName: null,
            primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
            secondary: null,
            credits: { hasCredits: false, unlimited: false, balance: '0' },
            individualLimit: null, spendControlReached: null,
            planType: 'pro', rateLimitReachedType: null,
          },
        });
        finish(false);
      });
    });
  }

  function handle(m) {
    var id = m.id;
    var p = m.params || {};
    switch (m.method) {
      case 'initialize':
        reply(id, {
          userAgent: 'fake-codex/0.0.1',
          codexHome: process.env.CODEX_HOME || '',
          platformFamily: 'unix',
          platformOs: 'macos',
        });
        return;
      case 'initialized':
        return; // 通知,不回
      case 'thread/start': {
        var nid = newThreadId();
        memThreads.push(nid);
        reply(id, { thread: { id: nid, turns: [], status: { type: 'idle' } } });
        return;
      }
      case 'thread/resume': {
        var rid = p.threadId || '';
        if (!hasThread(rid)) return replyErr(id, -32602, 'thread not found');
        if (memThreads.indexOf(rid) < 0) memThreads.push(rid);
        reply(id, { thread: { id: rid, turns: [], status: { type: 'idle' } } });
        return;
      }
      case 'turn/start': {
        var tid = p.threadId || '';
        var text = inputText(p.input);
        turnSeq += 1;
        var turnId = 'turn-' + process.pid + '-' + turnSeq;
        var startedAt = Math.floor(Date.now() / 1000);
        if (text.indexOf('__CRASH__') >= 0) {
          // 先把 ack 冲出去再死,别让对端连响应都收不到
          outThen({
            jsonrpc: '2.0', id: id,
            result: { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: startedAt, completedAt: null, durationMs: null } },
          }, function () { process.exit(9); });
          return;
        }
        reply(id, {
          turn: {
            id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress',
            error: null, startedAt: startedAt, completedAt: null, durationMs: null,
          },
        });
        active = { turnId: turnId, threadId: tid, cancelled: false };
        runTurn(tid, turnId, text, startedAt);
        return;
      }
      case 'turn/interrupt':
        if (active) active.cancelled = true;
        reply(id, {});
        return;
      case 'thread/loaded/list':
        reply(id, { data: memThreads.slice(), nextCursor: null });
        return;
      default:
        replyErr(id, -32601, 'method not found');
        return;
    }
  }

  var rl = readline.createInterface({ input: process.stdin });
  rl.on('line', function (line) {
    var s = String(line).trim();
    if (!s) return;
    var m;
    try { m = JSON.parse(s); } catch (e) { return; }
    appendLine(RPC, { at: Date.now(), method: m.method, params: m.params });
    handle(m);
  });
  rl.on('close', function () { process.exit(0); });
}

// ---- 入口 ---------------------------------------------------------------
var ARGV = process.argv.slice(2);
appendLine(LOG, { at: Date.now(), pid: process.pid, argv: ARGV });

var persona = ARGV[0] === 'exec' ? 'exec'
  : ARGV[0] === 'app-server' ? 'app-server'
  : (process.env.FAKE_CODEX_PERSONA || '');

if (persona === 'exec') runExec(ARGV);
else if (persona === 'app-server') runAppServer();
/* 其它子命令(--version 之类):已记 spawn 日志,安静退出 */
`;

function readJsonl<T>(file: string): T[] {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s) as T);
    } catch {
      /* 半行(还在写)直接跳过 */
    }
  }
  return rows;
}

export function installFakeCodex(dir: string, opts: InstallFakeCodexOptions = {}): FakeCodex {
  const statePath = opts.statePath ?? path.join(dir, '_fake-codex');
  const logPath = opts.logPath ?? path.join(statePath, 'spawns.jsonl');
  const rpcLogPath = path.join(path.dirname(logPath), 'rpc.jsonl');
  const binPath = path.join(dir, 'codex');

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(statePath, { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  let source = SHIM_SOURCE;
  if (opts.defaultPersona) {
    source = source.replace(
      "(process.env.FAKE_CODEX_PERSONA || '')",
      `(process.env.FAKE_CODEX_PERSONA || ${JSON.stringify(opts.defaultPersona)})`,
    );
  }
  fs.writeFileSync(binPath, source, 'utf-8');
  fs.chmodSync(binPath, 0o755);

  return {
    binDir: dir,
    logPath,
    statePath,
    rpcLogPath,
    binPath,
    spawns: () => readJsonl<SpawnRecord>(logPath),
    rpcCalls: () => readJsonl<RpcCall>(rpcLogPath),
  };
}
