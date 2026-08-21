// waku-dm 媒体金线 E2E —— 扮演 owner（真人账号），走真 Waku 聊天域 ↔ daemon ↔ 真 Codex。
//
// 它验的是**别的测试验不到的那一段**：单测里图片是假的、Codex 是假的，所以"Codex 到底看没看见这张图"
// 只有在这里才能真验。两轮：
//
//   1. 发一张图给马甲，图里写着一个随机暗号 → 等它用文字把暗号念回来（= 它真的读到了本机文件）
//   2. 让它把那张图**原样发回来** → 等收到一条 kind=image 的消息（= 上传/发送那半边真的通了）
//
// 前置：
//   1. daemon 已起（bridge 模式：WAKU_GATEWAY_CHANNEL=waku-dm + BRIDGE_CREDENTIAL_FILE），/health 绿；
//   2. owner 的 ~/.config/waku/auth.json 已登录（`waku login`），且 owner 与马甲互相关注。
// 参数（环境变量）：
//   PERSONA_USER_ID     必填：马甲的 user_id
//   WAKU_API_BASE       可选：v1 base，默认 auth.json 的 api_base
//   WAKU_CLI_AUTH_PATH  可选：默认 ~/.config/waku/auth.json
//   GOLDEN_TIMEOUT_MS   可选：每轮等回复的上限，默认 300000
// 纪律：不打印 token；只打印会话 id 前缀与回复前 120 字。
import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// ── 画一张写着暗号的 PNG（无依赖：自己拼 5x7 点阵 + zlib deflate） ─────────────
import zlib from 'node:zlib';

const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
};

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 大号黑字白底 PNG：Codex 必须能一眼读出这串暗号。 */
function nonceImage(text, scale = 12) {
  const pad = scale * 2;
  const width = pad * 2 + text.length * 6 * scale;
  const height = pad * 2 + 7 * scale;
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0; // filter=None

  const plot = (px, py) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = py * (1 + width * 3) + 1 + px * 3;
    raw[offset] = 0;
    raw[offset + 1] = 0;
    raw[offset + 2] = 0;
  };

  text.split('').forEach((ch, index) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row][col] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            plot(pad + index * 6 * scale + col * scale + dx, pad + row * scale + dy);
          }
        }
      }
    }
  });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
const nonce = `ZX${Math.floor(Math.random() * 900000 + 100000)}`;
const imagePath = path.join(os.tmpdir(), `waku-golden-${nonce}.png`);
const png = nonceImage(nonce);
writeFileSync(imagePath, png);
log(`2. turn #1 image nonce=${nonce} bytes=${png.length} …`);

const assetId = await uploadAsset(imagePath, 'image/png');
const seq1 = await sendImage(assetId, 0, 0);
await sendText('这张图片里写着一串暗号，请只回答那串暗号本身，不要任何其他文字。');
const reply1 = await waitForReply(
  seq1,
  (m) => m.kind === 'text' && typeof m.body === 'string' && m.body.includes(nonce),
  'the persona to read the nonce out of the image',
);
log(`   REPLY#1 (conv_seq=${reply1.conv_seq}):`, JSON.stringify(reply1.body).slice(0, 120));

// ── 3. 让它把那张图原样发回来（验出站上传/发送） ────────────
log('3. turn #2 (send the image back) …');
const seq2 = await sendText('请把我刚才发给你的那张图原样发回给我，并在文字里附上一句 done。');
const reply2 = await waitForReply(seq2, (m) => m.kind === 'image', 'the persona to send an image back');
log(`   REPLY#2 (conv_seq=${reply2.conv_seq}, kind=${reply2.kind}, asset=${String(reply2.image?.asset_id ?? '-').slice(0, 16)}…)`);

unlinkSync(imagePath);
log('');
log('✅ GOLDEN PATH PASS: image in → Codex reads it → image out');
log(`   conversation=${conversationId}`);
