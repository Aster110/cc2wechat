/**
 * 假网关 —— 仿真 E2E 的另一半。
 *
 * 它扮演的是「app 里那个网关会话 + 被唤醒的收件箱会话」这一整段:
 *   1. `curl -N /claude-app/events` 那根 SSE 长连接(这里用 http.request,行为一样)
 *   2. 收到 inject → 按契约 POST /claude-app/ack
 *   3. 模拟 `send_message` 的后果:把注入信封写进收件箱的 transcript jsonl,
 *      隔一小会儿再写 assistant 回复(带 stop_reason:end_turn)
 *   4. 收到 resolve → POST /claude-app/resolve 回报 localId
 *
 * 冷唤醒也照做:第一次给某个 cwd 投递时,先补一条 ~/.claude/sessions/<pid>.json
 * 的引擎登记(实测冷唤醒约 2s 起新引擎),再开始写 transcript。
 *
 * daemon 侧一行没改 —— 真 SSE、真 HTTP 回执、真 fs 轮询。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type { GatewayEvent } from '../../../v6/claude-app/gateway-bus.js';
import { slugOf } from '../../../v6/claude-app/cc-registry.js';
import { appendJsonl, assistant, crossSessionUser, engineJson, noise, queueDequeue, queueEnqueue } from './fixtures.js';

export type InjectBehavior =
  | { kind: 'reply'; text: string; delayMs?: number; tools?: string[] }
  /** ack 了但收件箱永远不答(模拟 app 卡住/人接管了) */
  | { kind: 'no-reply' }
  /** 不写 stop_reason,逼回程走静默兜底 */
  | { kind: 'reply-no-stop-reason'; text: string; delayMs?: number }
  /** 网关自己报失败(send_message 被拒) */
  | { kind: 'fail'; error: string }
  /** 收到就装死:不 ack,也不回复 */
  | { kind: 'silent' }
  /** 收到就断线(掉线负例) */
  | { kind: 'drop' };

export interface FakeGatewayOptions {
  port: number;
  sessionsDir: string;
  projectsDir: string;
  /** cwd → app 侧 local_ 句柄。resolve 事件查这张表 */
  localIds?: Record<string, string>;
  /** cwd → 已经在跑的引擎 CLI id;没有就在首次投递时"冷唤醒"造一个 */
  engines?: Record<string, string>;
  behavior?: (ev: Extract<GatewayEvent, { type: 'inject' }>, n: number) => InjectBehavior;
  /** 冷唤醒延迟 */
  wakeMs?: number;
}

export interface FakeGateway {
  events: GatewayEvent[];
  injects: Array<Extract<GatewayEvent, { type: 'inject' }>>;
  waitFor(pred: (e: GatewayEvent) => boolean, timeoutMs?: number): Promise<GatewayEvent>;
  /** 断开 SSE(不重连) */
  disconnect(): void;
  /** 断开后再挂上去(人一句"值班") */
  reconnect(): Promise<void>;
  close(): void;
}

function post(port: number, urlPath: string, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.end(JSON.stringify(body));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startFakeGateway(opts: FakeGatewayOptions): Promise<FakeGateway> {
  const events: GatewayEvent[] = [];
  const injects: Array<Extract<GatewayEvent, { type: 'inject' }>> = [];
  const waiters: Array<{ pred: (e: GatewayEvent) => boolean; resolve: (e: GatewayEvent) => void; timer: NodeJS.Timeout }> = [];
  const engines: Record<string, string> = { ...(opts.engines ?? {}) };
  const localIds = opts.localIds ?? {};
  const cwdOf = new Map<string, string>(); // localId → cwd
  for (const [cwd, lid] of Object.entries(localIds)) cwdOf.set(lid, cwd);

  let current: http.ClientRequest | null = null;
  let closed = false;
  let injectSeq = 0;
  let pid = 40_000;

  const emit = (ev: GatewayEvent): void => {
    events.push(ev);
    for (const w of [...waiters]) {
      if (!w.pred(ev)) continue;
      clearTimeout(w.timer);
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(ev);
    }
  };

  /** 模拟 send_message 落地:收件箱会话被唤醒 → transcript 里出现记录 */
  async function actAsInbox(ev: Extract<GatewayEvent, { type: 'inject' }>, behavior: InjectBehavior): Promise<void> {
    const cwd = cwdOf.get(ev.localId);
    if (!cwd) return;

    // 冷唤醒:没有活引擎就先注册一个(实测 ~2s)
    if (!engines[cwd]) {
      await sleep(opts.wakeMs ?? 20);
      const cliId = `cli-${Math.random().toString(36).slice(2, 10)}`;
      engines[cwd] = cliId;
      fs.mkdirSync(opts.sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(opts.sessionsDir, `${pid}.json`),
        JSON.stringify(engineJson({ pid: pid++, sessionId: cliId, cwd, startedAt: Date.now() })),
      );
    }

    const jsonl = path.join(opts.projectsDir, slugOf(cwd), `${engines[cwd]}.jsonl`);
    appendJsonl(jsonl, [queueEnqueue(ev.text), queueDequeue(), crossSessionUser(ev.text), ...noise()]);

    if (behavior.kind === 'no-reply' || behavior.kind === 'fail' || behavior.kind === 'silent' || behavior.kind === 'drop') return;

    await sleep(behavior.delayMs ?? 20);
    const mid = `msg_${Math.random().toString(36).slice(2, 10)}`;
    if (behavior.kind === 'reply') {
      for (const t of behavior.tools ?? []) {
        appendJsonl(jsonl, [assistant({ tools: [{ name: t }], stopReason: 'tool_use', messageId: `${mid}-tool` })]);
        await sleep(5);
      }
      appendJsonl(jsonl, [assistant({ text: behavior.text, stopReason: 'end_turn', messageId: mid })]);
      return;
    }
    // reply-no-stop-reason:逼静默兜底
    appendJsonl(jsonl, [assistant({ text: behavior.text, stopReason: null, messageId: mid })]);
  }

  async function onEvent(ev: GatewayEvent): Promise<void> {
    emit(ev);

    if (ev.type === 'resolve') {
      const localId = localIds[ev.cwd] ?? null;
      await post(opts.port, '/claude-app/resolve', { jobId: ev.jobId, cwd: ev.cwd, localId });
      return;
    }

    if (ev.type !== 'inject') return;
    injects.push(ev);
    const behavior = opts.behavior?.(ev, injectSeq++) ?? { kind: 'reply', text: `收到:${ev.jobId}` };

    if (behavior.kind === 'silent') return;
    if (behavior.kind === 'drop') {
      current?.destroy();
      current = null;
      return;
    }
    if (behavior.kind === 'fail') {
      await post(opts.port, '/claude-app/ack', { jobId: ev.jobId, ok: false, error: behavior.error });
      return;
    }

    // 真实顺序:send_message 一返回就 ack,收件箱那边慢慢跑
    await post(opts.port, '/claude-app/ack', { jobId: ev.jobId, ok: true });
    void actAsInbox(ev, behavior);
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: opts.port, path: '/claude-app/events', method: 'GET' },
        (res) => {
          let buf = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                let ev: GatewayEvent;
                try {
                  ev = JSON.parse(line.slice(6)) as GatewayEvent;
                } catch {
                  continue;
                }
                void onEvent(ev);
              }
            }
          });
          resolve();
        },
      );
      req.on('error', (err) => {
        if (!closed) reject(err);
      });
      req.end();
      current = req;
    });
  }

  await connect();

  return {
    events,
    injects,
    waitFor(pred, timeoutMs = 3_000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<GatewayEvent>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`假网关 waitFor 超时,已收到 ${JSON.stringify(events)}`)),
          timeoutMs,
        );
        waiters.push({ pred, resolve, timer });
      });
    },
    disconnect() {
      current?.destroy();
      current = null;
    },
    async reconnect() {
      await connect();
    },
    close() {
      closed = true;
      for (const w of waiters.splice(0)) clearTimeout(w.timer);
      current?.destroy();
      current = null;
    },
  };
}
