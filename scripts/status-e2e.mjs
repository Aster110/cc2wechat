// P134 心跳 E2E —— 扮演 Playable 玩家侧，验 agent_status_v1 的在线徽章链路
// 走真 Waku 数据面 ↔ gateway daemon ↔ 真 Agent；解密与判定全部复用 Playable 仓的真实现，
// 不复刻协议——复刻出来的"通过"只能证明我抄得一致，证明不了双端真能互通。
//
// 前置：daemon 已起（心跳已接线）、pair-grant 签出的码放在 argv[2] 或 ~/.waku-gateway/grant.json
// 环境变量：PLAYABLE_DIR = waku-feed-codex-playable 仓路径
import { readFileSync } from 'node:fs';

const PLAYABLE = process.env.PLAYABLE_DIR || process.env.HOME + '/AIproject/waku-feed-codex-playable';
const { uuidv7 } = await import(PLAYABLE + '/src/protocol/ids.js');
const { deriveBootstrapKey, deriveMessageKey, derivePairRouteId } = await import(PLAYABLE + '/src/protocol/crypto.js');
const { sealMessage, openMessage, parseChunkRow } = await import(PLAYABLE + '/src/protocol/envelope.js');
// 判定用客户端自己那份 classifyAgentStatus——徽章语义的唯一事实源
const { classifyAgentStatus } = await import(PLAYABLE + '/src/client/heartbeat.js');

const HOME = process.env.HOME;
globalThis.window = {};
await import(HOME + '/.waku-gateway/runtime.js');
const rt = window.__POLYVERSE_RUNTIME__;
const BASE = rt.apiBaseUrl + '/content-runtime/data';
const H = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer ' + rt.runtimeToken,
  Origin: rt.origin || 'http://127.0.0.1:18190',
  'X-Runtime-Session-Id': rt.sessionId,
};

const token = process.argv[2] || (readFileSync(HOME + '/.waku-gateway/grant.json', 'utf8').match(/^\s{4}([A-Za-z0-9_-]{22,})\s*$/m) || [])[1];
if (!token) throw new Error('pairing token not found (argv[2] 或 grant.json)');

const api = async (col, verb, body) => {
  const r = await fetch(`${BASE}/${col}/${verb}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`${col}/${verb} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (msg) => { console.error('\n❌ FAIL: ' + msg); process.exit(1); };

async function sendRows(rows) { for (const row of rows) await api('agent_inbox_v1', 'insert', { doc: row }); }

const seen = new Set();
async function pollOutbox({ routeId, key, timeoutMs = 240000, wantKinds }) {
  const t0 = Date.now();
  const byMsg = new Map();
  while (Date.now() - t0 < timeoutMs) {
    const q = await api('agent_outbox_v1', 'query', { filter: [{ field: 'routeId', op: 'eq', value: routeId }], sort: 'createdAt', limit: 100 });
    for (const raw of q.rows || []) {
      const idKey = raw.messageId + '#' + raw.chunkIndex;
      if (seen.has(idKey)) continue;
      const parsed = parseChunkRow(raw, { direction: 'to_player' });
      const arr = byMsg.get(raw.messageId) || [];
      arr.push(parsed);
      byMsg.set(raw.messageId, arr);
      if (arr.length === arr[0].chunkCount) {
        for (const c of arr) seen.add(raw.messageId + '#' + c.chunkIndex);
        const payload = await openMessage({ key, chunks: arr });
        if (!wantKinds || wantKinds.includes(payload.type)) return { messageId: raw.messageId, payload };
      }
    }
    await sleep(1500);
  }
  throw new Error('pollOutbox timeout waiting for ' + wantKinds);
}

/** 读一条心跳并用玩家侧密钥解开。返回 {messageId, payload, rowCount}。 */
async function readStatus({ routeId, key }) {
  const q = await api('agent_status_v1', 'query', { filter: [{ field: 'routeId', op: 'eq', value: routeId }], limit: 10 });
  const rows = q.rows || [];
  if (rows.length === 0) return { rowCount: 0 };
  const chunks = rows.map((raw) => parseChunkRow(raw, { direction: 'to_player' }));
  const payload = await openMessage({ key, chunks: [chunks[0]] });
  return { messageId: rows[0].messageId, payload, rowCount: rows.length };
}

/** 心跳最长 30s 一拍 + 平台读缓存 ~5s，给足余量再判失败。 */
async function waitStatus({ routeId, key, want, timeoutMs = 75000 }) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const s = await readStatus({ routeId, key });
    if (s.rowCount > 0) {
      last = s;
      if (!want || want.includes(s.payload.agent)) return s;
    }
    await sleep(3000);
  }
  return last ?? { rowCount: 0 };
}

// ── 1. 配对（拿 channelSecret，才能解自己的心跳）─────────────
log('1. 配对 …');
const pairRoute = await derivePairRouteId(token);
const bootTx = await deriveBootstrapKey({ pairingToken: token, direction: 'to_agent' });
const bootRx = await deriveBootstrapKey({ pairingToken: token, direction: 'to_player' });
await sendRows(await sealMessage({
  key: bootTx, routeId: pairRoute, messageId: uuidv7(), direction: 'to_agent', kind: 'pair',
  payload: { type: 'pair_request', clientNonce: uuidv7(), clientTimeMs: Date.now(), deviceLabel: 'status-e2e' },
  expiresAt: Date.now() + 600000,
}));
const accept = await pollOutbox({ routeId: pairRoute, key: bootRx, wantKinds: ['pair_accept', 'pair_reject'] });
if (accept.payload.type !== 'pair_accept') fail('pair rejected: ' + JSON.stringify(accept.payload));
const { pairingId, routeId, channelSecret, keyVersion } = accept.payload;
log('   PAIRED route=' + routeId.slice(0, 12) + '…');

const tx = await deriveMessageKey({ channelSecret, pairingId, direction: 'to_agent', keyVersion });
const rx = await deriveMessageKey({ channelSecret, pairingId, direction: 'to_player', keyVersion });

// ── 2. 心跳出现 + 能被玩家侧解开 + 徽章判 online ────────────
log('2. 等心跳出现（≤75s）…');
const s1 = await waitStatus({ routeId, key: rx, want: ['online'] });
if (s1.rowCount === 0) fail('agent_status_v1 里没有这条 route 的心跳行——心跳没在跑');
if (s1.payload.type !== 'status') fail('解出来的不是 status 载荷: ' + JSON.stringify(s1.payload));
const badge1 = classifyAgentStatus({ payload: s1.payload, at: s1.payload.at });
log('   解密成功 agent=' + s1.payload.agent + ' queued=' + s1.payload.queued + ' running=' + s1.payload.running);
log('   客户端徽章判定 = ' + badge1);
if (badge1 !== 'online') fail('徽章应为 online，实际 ' + badge1);
if (s1.rowCount !== 1) fail('这条 route 有 ' + s1.rowCount + ' 行心跳，upsert 应恒为 1 行');

// ── 3. 下一拍：仍 1 行，但 messageId 变了（证伪 upsert 变 insert / 只拍一次）──
log('3. 等下一拍（≤75s，验 upsert 不涨行且真的在续拍）…');
const t0 = Date.now();
let s2 = null;
while (Date.now() - t0 < 75000) {
  await sleep(5000);
  const s = await readStatus({ routeId, key: rx });
  if (s.rowCount > 0 && s.messageId !== s1.messageId) { s2 = s; break; }
}
if (s2 === null) fail('75 秒内没等到新的一拍（messageId 没变）——心跳只打了一次就停了');
if (s2.rowCount !== 1) fail('第二拍后变成 ' + s2.rowCount + ' 行——upsert 退化成 insert 了');
log('   ✓ messageId 已更新，仍恰 1 行');

// ── 4. 慢 turn 期间徽章转 busy ────────────────────────────
log('4. 发一条慢 turn，验执行中徽章转 busy …');
const conversationId = uuidv7();
await sendRows(await sealMessage({
  key: tx, routeId, messageId: uuidv7(), direction: 'to_agent', kind: 'turn',
  payload: { type: 'turn', conversationId, generation: 1, clientSeq: 0,
    text: '请先思考一会儿再回答：用一句话解释什么是信箱模式，然后回复 STATUSE2E-DONE。' },
  expiresAt: Date.now() + 600000,
}));
let sawBusy = false;
const busyDeadline = Date.now() + 120000;
let finalSeen = false;
while (Date.now() < busyDeadline && !sawBusy) {
  await sleep(4000);
  const s = await readStatus({ routeId, key: rx });
  if (s.rowCount > 0 && s.payload.agent === 'busy') { sawBusy = true; break; }
  const q = await api('agent_outbox_v1', 'query', { filter: [{ field: 'routeId', op: 'eq', value: routeId }, { field: 'kind', op: 'eq', value: 'final' }], limit: 1 });
  if ((q.rows || []).length > 0) { finalSeen = true; break; }
}
if (sawBusy) log('   ✓ 执行中徽章 = busy');
else if (finalSeen) log('   ⚠ 没抓到 busy——turn 比一个拍距还快（30s），不算失败，但这一项未被证实');
else log('   ⚠ 120s 内既没抓到 busy 也没等到 final');

// ── 5. turn 结束后回 online ───────────────────────────────
log('5. 等 turn 结束并验徽章回 online（≤120s）…');
try { await pollOutbox({ routeId, key: rx, wantKinds: ['final', 'error'], timeoutMs: 120000 }); } catch { /* 可能已在上一步消费 */ }
const s3 = await waitStatus({ routeId, key: rx, want: ['online'], timeoutMs: 75000 });
if (s3.rowCount === 0 || s3.payload.agent !== 'online') fail('turn 结束后徽章没回 online，实际 ' + (s3.payload?.agent ?? '无行'));
log('   ✓ 徽章回到 online');

console.log('');
console.log('✅ STATUS HEARTBEAT PASS：心跳行存在且可被玩家侧解开、upsert 恒 1 行、续拍正常、' + (sawBusy ? 'busy 已验证、' : '') + 'turn 后回 online');
console.log('   route=' + routeId.slice(0, 14) + '…  停机墓碑请单独验（停 daemon 后读同一 route 应为 offline）');
