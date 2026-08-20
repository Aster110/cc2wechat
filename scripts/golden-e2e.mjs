// P134 金线 E2E 驱动 —— 扮演 Playable 玩家侧，用 Playable 仓的真协议实现
// 走真 Waku 数据面（draft env）↔ gateway daemon ↔ 真 Agent（codex / claude-sdk）
// 前置：daemon 已起、pair-grant 已签到 ~/.waku-gateway/grant.json、runtime.js 未过期
// 环境变量：PLAYABLE_DIR = waku-feed-codex-playable 仓路径（默认 ~/AIproject/waku-feed-codex-playable）
import { readFileSync } from 'node:fs';
const PLAYABLE = process.env.PLAYABLE_DIR || process.env.HOME + '/AIproject/waku-feed-codex-playable';
const { uuidv7 } = await import(PLAYABLE + '/src/protocol/ids.js');
const { deriveBootstrapKey, deriveMessageKey, derivePairRouteId } = await import(PLAYABLE + '/src/protocol/crypto.js');
const { sealMessage, openMessage, parseChunkRow } = await import(PLAYABLE + '/src/protocol/envelope.js');


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
const grantText = readFileSync(HOME + '/.waku-gateway/grant.json', 'utf8');
const token = (grantText.match(/^\s{4}([A-Za-z0-9_-]{22,})\s*$/m) || [])[1];
if (!token) throw new Error('pairing token not found in grant.json');

const api = async (col, verb, body) => {
  const r = await fetch(`${BASE}/${col}/${verb}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`${col}/${verb} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function sendRows(rows) {
  for (const row of rows) await api('agent_inbox_v1', 'insert', { doc: row });
}
const seen = new Set();
async function pollOutbox({ routeId, key, timeoutMs = 240000, wantKinds }) {
  const t0 = Date.now();
  const byMsg = new Map();
  while (Date.now() - t0 < timeoutMs) {
    const q = await api('agent_outbox_v1', 'query', {
      filter: [{ field: 'routeId', op: 'eq', value: routeId }],
      sort: 'createdAt', limit: 100,
    });
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
        log('  (skip', payload.type + ')');
      }
    }
    await sleep(1500);
  }
  throw new Error('pollOutbox timeout waiting for ' + wantKinds);
}

// ── 1. 配对 ──────────────────────────────────────────────
log('1. pair_request …');
const pairRoute = await derivePairRouteId(token);
const bootTx = await deriveBootstrapKey({ pairingToken: token, direction: 'to_agent' });
const bootRx = await deriveBootstrapKey({ pairingToken: token, direction: 'to_player' });
await sendRows(await sealMessage({
  key: bootTx, routeId: pairRoute, messageId: uuidv7(), direction: 'to_agent', kind: 'pair',
  payload: { type: 'pair_request', clientNonce: uuidv7(), clientTimeMs: Date.now(), deviceLabel: 'golden-e2e' },
  expiresAt: Date.now() + 600000,
}));
const accept = await pollOutbox({ routeId: pairRoute, key: bootRx, wantKinds: ['pair_accept', 'pair_reject'] });
if (accept.payload.type !== 'pair_accept') throw new Error('pair rejected: ' + JSON.stringify(accept.payload));
const { pairingId, routeId, channelSecret, keyVersion, endpointId, scopes } = accept.payload;
log('   PAIRED pairing=' + pairingId.slice(0, 12) + '… route=' + routeId.slice(0, 10) + '… endpoint=' + endpointId + ' scopes=' + scopes.length);
if (routeId.startsWith('pr_')) throw new Error('long-term route must not be pr_');

const tx = await deriveMessageKey({ channelSecret, pairingId, direction: 'to_agent', keyVersion });
const rx = await deriveMessageKey({ channelSecret, pairingId, direction: 'to_player', keyVersion });

// ── 2. 首轮 turn：随机 nonce ─────────────────────────────
const nonce = 'ZX' + Math.floor(Math.random() * 900000 + 100000);
const conversationId = uuidv7();
log('2. turn #1 nonce=' + nonce + ' …');
await sendRows(await sealMessage({
  key: tx, routeId, messageId: uuidv7(), direction: 'to_agent', kind: 'turn',
  payload: { type: 'turn', conversationId, generation: 1, clientSeq: 0, text: `请只回答这个暗号本身，不要任何其他文字：${nonce}` },
  expiresAt: Date.now() + 600000,
}));
let final1;
for (;;) {
  const m = await pollOutbox({ routeId, key: rx, wantKinds: ['progress', 'final', 'error'] });
  log('   got', m.payload.type, m.payload.stage || '');
  if (m.payload.type === 'error') throw new Error('turn#1 error: ' + JSON.stringify(m.payload));
  if (m.payload.type === 'final') { final1 = m.payload; break; }
}
log('   FINAL#1:', JSON.stringify(final1.text).slice(0, 120));
if (!final1.text.includes(nonce)) throw new Error('nonce not echoed back!');

// ── 3. 续聊：验证 provider session 记忆 ───────────────────
log('3. turn #2 (memory check) …');
await sendRows(await sealMessage({
  key: tx, routeId, messageId: uuidv7(), direction: 'to_agent', kind: 'turn',
  payload: { type: 'turn', conversationId, generation: 1, clientSeq: 1, text: '我上一条消息里的暗号是什么？请只回答暗号本身。' },
  expiresAt: Date.now() + 600000,
}));
let final2;
for (;;) {
  const m = await pollOutbox({ routeId, key: rx, wantKinds: ['progress', 'final', 'error'] });
  log('   got', m.payload.type, m.payload.stage || '');
  if (m.payload.type === 'error') throw new Error('turn#2 error: ' + JSON.stringify(m.payload));
  if (m.payload.type === 'final') { final2 = m.payload; break; }
}
log('   FINAL#2:', JSON.stringify(final2.text).slice(0, 120));
if (!final2.text.includes(nonce)) throw new Error('resume memory FAILED — nonce not recalled');

log('');
log('✅ GOLDEN PATH PASS: pair → turn(nonce) → final → resume(memory) 全部通过');
log('   route=' + routeId.slice(0, 14) + '… conversation=' + conversationId);
