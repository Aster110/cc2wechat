// waku-dm 文件金线 E2E —— 扮演 owner（真人账号），走真 Waku 聊天域 ↔ daemon ↔ 真 Codex。
//
// 验的是「AI 好友把本机文件递过来」这条链，而它的形态很特别：
// **Waku 私聊没有 file 消息类型**，所以文件不是一条附件消息，而是
// 「传上传门拿 public_url → 发一条 kind=text：`📎 <名字>（<大小>）\n<url>`」。
//
// 单测能钉的是 daemon 那半边（白名单、魔数、缓存、415 降级）。这里钉的是**只有真链路才成立**的两件事：
//   1. Codex 真的会用 `[[send-file: …]]`（skill 里写的词法它认不认）；
//   2. 那条 URL **真的能匿名 GET 下来**（上传门 → 公开桶 → CDN 这一路通不通）。
//
// 前置：
//   1. daemon 已起（bridge 模式：WAKU_GATEWAY_CHANNEL=waku-dm + BRIDGE_CREDENTIAL_FILE），/health 绿；
//   2. owner 的 ~/.config/waku/auth.json 已登录（`waku login`），且 owner 与马甲互相关注；
//   3. daemon 那台机器上存在 `~/.codex/AGENTS.md`（默认要它发的就是这个文件；用 GOLDEN_FILE_PATH 换别的）。
// 参数（环境变量）：
//   PERSONA_USER_ID     必填：马甲的 user_id
//   GOLDEN_FILE_PATH    可选：让它发哪个文件，默认 ~/.codex/AGENTS.md
//   WAKU_API_BASE       可选：v1 base，默认 auth.json 的 api_base
//   WAKU_CLI_AUTH_PATH  可选：默认 ~/.config/waku/auth.json
//   GOLDEN_TIMEOUT_MS   可选：等回复的上限，默认 300000
// 纪律：不打印 token；只打印会话 id 前缀与回复前 200 字。
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERSONA = process.env.PERSONA_USER_ID;
if (!PERSONA) {
  console.error('PERSONA_USER_ID is required (the agent persona user id)');
  process.exit(2);
}
const AUTH_PATH = process.env.WAKU_CLI_AUTH_PATH || path.join(os.homedir(), '.config', 'waku', 'auth.json');
const TIMEOUT_MS = Number(process.env.GOLDEN_TIMEOUT_MS || 300000);
// 默认挑 ~/.codex/AGENTS.md：它一定是 .md（在白名单里）、一定是纯文本、而且**一定在 daemon 那台机器上**。
const FILE_PATH = process.env.GOLDEN_FILE_PATH || '~/.codex/AGENTS.md';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 凭证：与 waku CLI 同一份 auth.json；refresh_token 是单次的，必须原子写回 ──
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
log(`   conversation=${conversationId.slice(0, 16)}… created=${created.created}`);

async function sendText(text) {
  const out = await api('POST', `/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    client_msg_id: `golden-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'text',
    body: text,
  });
  return out.message.conv_seq;
}

async function waitForReply(afterSeq, predicate, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const page = await api('GET', `/chat/conversations/${encodeURIComponent(conversationId)}/messages?limit=30`);
    const replies = (page.messages || [])
      .filter((m) => m.sender_user_id === PERSONA && m.conv_seq > afterSeq)
      .sort((a, b) => a.conv_seq - b.conv_seq);
    for (const m of replies) {
      if (predicate(m)) return m;
      log(`   (skipped ${m.kind}: ${JSON.stringify(m.body ?? '').slice(0, 60)})`);
    }
    await sleep(2000);
  }
  throw new Error(`timeout (${TIMEOUT_MS}ms) waiting for ${label} after conv_seq ${afterSeq}`);
}

// ── 2. 让它把一个本机文件发过来 ────────────────────────────
log(`2. asking the persona to send ${FILE_PATH} as a file …`);
const seq = await sendText(`请把你这台机器上的 ${FILE_PATH} 作为文件发给我。`);
// 📎 是 daemon 拼的那条链接消息的固定前缀（`file-kinds.ts::fileLinkText`）——
// 认它而不是认「消息里有 http」，可以把 Codex 自己贴的随便一条 URL 排除掉。
const reply = await waitForReply(
  seq,
  (m) => m.kind === 'text' && typeof m.body === 'string' && m.body.includes('📎') && /https?:\/\/\S+/.test(m.body),
  'the persona to send a file link message',
);
log(`   REPLY (conv_seq=${reply.conv_seq}):`, JSON.stringify(reply.body).slice(0, 200));

// ── 3. 那条 URL 必须真的能匿名 GET 下来 ─────────────────────
const url = /https?:\/\/\S+/.exec(reply.body)[0].replace(/[)\]，。,.]+$/, '');
log(`3. fetching the link anonymously (no Authorization header) …`);
// 刻意**不带**任何凭证：这条链接是要发给用户点开的，带上 token 验的就不是它了。
const head = await fetch(url, { method: 'GET' });
const contentType = (head.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
const bytes = head.ok ? (await head.arrayBuffer()).byteLength : 0;
log(`   HTTP ${head.status} content-type=${contentType || '-'} bytes=${bytes}`);

const problems = [];
if (!head.ok) problems.push(`GET ${url} → HTTP ${head.status} (the public link is not fetchable)`);
if (head.ok && bytes === 0) problems.push('the link returned an empty body');
// 会被浏览器执行的 Content-Type 绝不该从这条链路出来（平台上传门恒 415，这里是最后一道现场核对）。
if (['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript', 'text/javascript'].includes(contentType)) {
  problems.push(`served as ${contentType} — the upload door must never accept a browser-executable type`);
}

if (problems.length > 0) {
  console.error('');
  console.error('❌ GOLDEN PATH FAIL');
  for (const p of problems) console.error(`   - ${p}`);
  console.error(`   conversation=${conversationId}`);
  process.exit(1);
}

log('');
log('✅ GOLDEN PATH PASS: "send me that file" → upload door → a text message with 📎 and a fetchable public URL');
log(`   conversation=${conversationId}`);
