// waku-dm 金线 E2E 驱动（契约 §3.7）—— 扮演 owner（真人账号），走真 Waku 聊天域 ↔ daemon ↔ 真 Agent。
//
// 前置：
//   1. daemon 已起（bridge 模式：WAKU_GATEWAY_CHANNEL=waku-dm + BRIDGE_CREDENTIAL_FILE），/health 绿；
//   2. owner 的 ~/.config/waku/auth.json 已登录（`waku login`），且 owner 与马甲互相关注（create 时自动建立）。
// 参数（环境变量）：
//   PERSONA_USER_ID     必填：马甲的 user_id（`waku agent-friend create` 打印的 persona_user_id）
//   WAKU_API_BASE       可选：v1 base，默认 auth.json 的 api_base
//   WAKU_CLI_AUTH_PATH  可选：默认 ~/.config/waku/auth.json
//   GOLDEN_TIMEOUT_MS   可选：每轮等回复的上限，默认 240000
// 步骤：建/取 dm 会话 → 发暗号 → 等马甲回复含暗号 → 第二轮问「上一条暗号是什么」验续聊记忆 → ✅ GOLDEN PATH PASS
// 纪律：不打印 token；只打印会话 id 前缀与回复前 120 字。
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERSONA = process.env.PERSONA_USER_ID;
if (!PERSONA) {
  console.error('PERSONA_USER_ID is required (the agent persona user id)');
  process.exit(2);
}
const AUTH_PATH = process.env.WAKU_CLI_AUTH_PATH || path.join(os.homedir(), '.config', 'waku', 'auth.json');
const TIMEOUT_MS = Number(process.env.GOLDEN_TIMEOUT_MS || 240000);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 凭证：与 waku CLI 同一份 auth.json；过期就 refresh 并原子写回（refresh_token 是单次的，不写回 = 自锁） ──
function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}
let auth = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
const BASE = (process.env.WAKU_API_BASE || auth.api_base || '').replace(/\/+$/, '');
if (!BASE) throw new Error('WAKU_API_BASE missing and auth.json has no api_base');
const OWNER = auth.user_id;

async function sessionToken() {
  if (auth.session_token && jwtExp(auth.session_token) > Date.now() + 60_000) return auth.session_token;
  if (!auth.refresh_token) throw new Error('session expired and no refresh_token; run: waku login');
  const r = await fetch(`${BASE}/cli/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: auth.refresh_token }),
  });
  if (r.status >= 400) throw new Error(`cli/auth/refresh ${r.status}; run: waku login`);
  const j = await r.json();
  auth = { ...JSON.parse(readFileSync(AUTH_PATH, 'utf8')), session_token: j.session_token, refresh_token: j.refresh_token || auth.refresh_token };
  const tmp = `${AUTH_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, AUTH_PATH);
  log('   (session refreshed and written back)');
  return auth.session_token;
}

async function api(method, route, body) {
  const token = await sessionToken();
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`${method} ${route} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ── 1. 会话 ──────────────────────────────────────────────
log(`1. dm conversation owner=${String(OWNER).slice(0, 12)}… persona=${PERSONA.slice(0, 12)}…`);
const created = await api('POST', '/chat/conversations', { kind: 'dm', peer_user_id: PERSONA });
const conversationId = created.conversation.id;
log(`   conversation=${conversationId.slice(0, 16)}… created=${created.created} members=${created.conversation.member_user_ids.length}`);

async function send(text) {
  const out = await api('POST', `/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    client_msg_id: `golden-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'text',
    body: text,
  });
  return out.message.conv_seq;
}

async function waitForReply(afterSeq, predicate) {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const page = await api('GET', `/chat/conversations/${encodeURIComponent(conversationId)}/messages?limit=30`);
    const replies = (page.messages || [])
      .filter((m) => m.sender_user_id === PERSONA && m.conv_seq > afterSeq && m.kind === 'text' && typeof m.body === 'string')
      .sort((a, b) => a.conv_seq - b.conv_seq);
    for (const m of replies) {
      if (predicate(m.body)) return m;
      log(`   (reply without the nonce: ${JSON.stringify(m.body).slice(0, 80)})`);
    }
    await sleep(2000);
  }
  throw new Error(`timeout (${TIMEOUT_MS}ms) waiting for the persona reply after conv_seq ${afterSeq}`);
}

// ── 2. 首轮：暗号 ────────────────────────────────────────
const nonce = 'ZX' + Math.floor(Math.random() * 900000 + 100000);
log(`2. turn #1 nonce=${nonce} …`);
const seq1 = await send(`请只回答这个暗号本身，不要任何其他文字：${nonce}`);
const reply1 = await waitForReply(seq1, (body) => body.includes(nonce));
log(`   REPLY#1 (conv_seq=${reply1.conv_seq}, source=${reply1.source ?? '-'}):`, JSON.stringify(reply1.body).slice(0, 120));

// ── 3. 续聊：provider session 记忆 ───────────────────────
log('3. turn #2 (memory check) …');
const seq2 = await send('我上一条消息里的暗号是什么？请只回答暗号本身。');
const reply2 = await waitForReply(seq2, (body) => body.includes(nonce));
log(`   REPLY#2 (conv_seq=${reply2.conv_seq}):`, JSON.stringify(reply2.body).slice(0, 120));

log('');
log('✅ GOLDEN PATH PASS: dm → turn(nonce) → reply → resume(memory) 全部通过');
log(`   conversation=${conversationId}`);
