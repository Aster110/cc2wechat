// waku-dm 媒体金线 E2E —— 扮演 owner（真人账号），走真 Waku 聊天域 ↔ daemon ↔ 真 Codex。
//
// 它验的是**别的测试验不到的那一段**：单测里图片是假的、Codex 是假的，所以"Codex 到底看没看见这张图"
// 只有在这里才能真验。两轮：
//
//   1. 发一张图给马甲，图里写着一个随机暗号 → 等它用文字把暗号念回来（= 它真的读到了本机文件）
//   2. 让它把那张图**原样发回来** → 等收到一条 kind=image 的消息（= 上传/发送那半边真的通了）
//
// 测试图必须**人眼一秒能读**：第 1 轮判的是"看见没有"，不是"OCR 强不强"。所以渲染走三级降级
// （真字体优先，自绘点阵只是最后兜底），暗号也只用不易混淆的字符集。
//
// 前置：
//   1. daemon 已起（bridge 模式：WAKU_GATEWAY_CHANNEL=waku-dm + BRIDGE_CREDENTIAL_FILE），/health 绿；
//   2. owner 的 ~/.config/waku/auth.json 已登录（`waku login`），且 owner 与马甲互相关注。
// 参数（环境变量）：
//   PERSONA_USER_ID     必填：马甲的 user_id
//   WAKU_API_BASE       可选：v1 base，默认 auth.json 的 api_base
//   WAKU_CLI_AUTH_PATH  可选：默认 ~/.config/waku/auth.json
//   GOLDEN_TIMEOUT_MS   可选：每轮等回复的上限，默认 300000
//   GOLDEN_KEEP_IMAGE   可选：=1 时保留生成的 PNG（排查"图到底长啥样"）
// 纪律：不打印 token；只打印会话 id 前缀与回复前 120 字。
import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 暗号字符集与三级降级渲染与视频金线同源（scripts/lib/nonce-image.mjs），一处修好两处受益。
import { makeNonce, normalizeReply, renderNonceImage } from './lib/nonce-image.mjs';

const PERSONA = process.env.PERSONA_USER_ID;
if (!PERSONA) {
  console.error('PERSONA_USER_ID is required (the agent persona user id)');
  process.exit(2);
}
const AUTH_PATH = process.env.WAKU_CLI_AUTH_PATH || path.join(os.homedir(), '.config', 'waku', 'auth.json');
const TIMEOUT_MS = Number(process.env.GOLDEN_TIMEOUT_MS || 300000);

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

async function uploadAsset(filePath, mime) {
  const token = await sessionToken();
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)], { type: mime }), path.basename(filePath));
  const r = await fetch(`${BASE}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`POST /assets ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const assetId = j?.asset_id ?? j?.id;
  if (!assetId) throw new Error(`POST /assets did not return an asset id: ${JSON.stringify(j).slice(0, 200)}`);
  return assetId;
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

async function sendImage(assetId, width, height) {
  const out = await api('POST', `/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    client_msg_id: `golden-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'image',
    image_asset_id: assetId,
    image_width: width,
    image_height: height,
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

// ── 2. 发一张写着暗号的图，等它把暗号念回来 ─────────────────
const nonce = makeNonce();
const imagePath = path.join(os.tmpdir(), `waku-golden-${nonce}.png`);
const rendered = renderNonceImage(nonce, imagePath);
log(`2. turn #1 image nonce=${nonce} renderer=${rendered.renderer} ${rendered.width}x${rendered.height} bytes=${rendered.bytes} …`);
if (rendered.renderer === 'bitmap') {
  log('   (no ffmpeg/drawtext and no ImageMagick on this box — fell back to the built-in bitmap font)');
}

const assetId = await uploadAsset(imagePath, 'image/png');
const seq1 = await sendImage(assetId, rendered.width, rendered.height);
await sendText('这张图片里写着一串暗号，请只回答那串暗号本身，不要任何其他文字。');
const reply1 = await waitForReply(
  seq1,
  (m) => m.kind === 'text' && normalizeReply(m.body).includes(nonce),
  'the persona to read the nonce out of the image',
);
log(`   REPLY#1 (conv_seq=${reply1.conv_seq}):`, JSON.stringify(reply1.body).slice(0, 120));

// ── 3. 让它把那张图原样发回来（验出站上传/发送） ────────────
log('3. turn #2 (send the image back) …');
const seq2 = await sendText('请把我刚才发给你的那张图原样发回给我，并在文字里附上一句 done。');
const reply2 = await waitForReply(seq2, (m) => m.kind === 'image', 'the persona to send an image back');
log(`   REPLY#2 (conv_seq=${reply2.conv_seq}, kind=${reply2.kind}, asset=${String(reply2.image?.asset_id ?? '-').slice(0, 16)}…)`);

if (process.env.GOLDEN_KEEP_IMAGE === '1') log(`   (kept test image at ${imagePath})`);
else unlinkSync(imagePath);
log('');
log('✅ GOLDEN PATH PASS: image in → Codex reads it → image out');
log(`   conversation=${conversationId}`);
