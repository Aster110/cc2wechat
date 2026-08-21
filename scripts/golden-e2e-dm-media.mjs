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
import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// ── 测试图：暗号字符集 + 三级渲染降级 ────────────────────────────
// 字符集刻意剔除所有成对易混字形：0/O/D、1/I/l/J、2/Z、5/S、6/G、8/B、U/V。
// 剩下的都是"错认了也不像另一个合法字符"的形，第 1 轮失败就一定是没看见，而不是看花了。
const NONCE_ALPHABET = '3479ACEHKMNPRTWXY';
const NONCE_LENGTH = 6;

function makeNonce() {
  let out = '';
  for (let i = 0; i < NONCE_LENGTH; i += 1) {
    out += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)];
  }
  return out;
}

/** 回复里只要出现暗号即可：忽略大小写、空格与任何标点/分隔符。 */
const normalizeReply = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** 从 PNG 的 IHDR 读真实宽高——三种渲染器都产标准 PNG，IHDR 恒在 offset 8。 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('rendered file is not a PNG');
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG has no leading IHDR chunk');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) throw new Error(`PNG IHDR has zero dimension ${width}x${height}`);
  return { width, height };
}

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
];
const systemFont = () => FONT_CANDIDATES.find((p) => existsSync(p)) || null;

function tryRun(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** 渲染成功 = 文件存在、非空、且能解出合法 IHDR。 */
function renderedOk(outPath) {
  try {
    if (!existsSync(outPath) || statSync(outPath).size === 0) return false;
    pngSize(readFileSync(outPath));
    return true;
  } catch {
    return false;
  }
}

// 1) ffmpeg drawtext——最好的一档，但很多 brew ffmpeg 没编 libfreetype，drawtext 会缺失，
//    所以这里只"试"，失败就往下降级，不做任何版本假设。
function renderWithFfmpeg(text, outPath) {
  const font = systemFont();
  // 画布按最宽字形留足余量（drawtext 会把超出画布的部分直接切掉，宁可四周多留白）。
  const canvasW = text.length * 170 + 260;
  const draw = ['drawtext=text=' + text, font ? `fontfile=${font}` : null, 'fontsize=180', 'fontcolor=black', 'x=(w-text_w)/2', 'y=(h-text_h)/2']
    .filter(Boolean)
    .join(':');
  const ok = tryRun('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=white:s=${canvasW}x320`,
    '-vf', draw, '-frames:v', '1', '-y', outPath,
  ]);
  return ok && renderedOk(outPath);
}

// 2) ImageMagick（7 的 `magick` / 6 的 `convert`）——macOS 上默认没配 font，必须显式 -font。
function renderWithMagick(text, outPath) {
  const font = systemFont();
  // 用 label: 让画布跟着文字自动长，再统一加白边——固定 -size 画布会把最后一个字切掉。
  const args = ['-background', 'white', '-fill', 'black', '-pointsize', '200', '-kerning', '16'];
  if (font) args.push('-font', font);
  args.push(`label:${text}`, '-bordercolor', 'white', '-border', '60', outPath);
  for (const cmd of ['magick', 'convert']) {
    if (tryRun(cmd, args) && renderedOk(outPath)) return true;
  }
  return false;
}

// 3) 纯 Node 兜底点阵：7x10（不是 5x7）+ scale 18 + 字间距一整格，无依赖但仍然人眼可读。
import zlib from 'node:zlib';

const GLYPH_W = 7;
const GLYPH_H = 10;
const GLYPHS = {
  3: ['0111100', '1100110', '0000110', '0001100', '0011100', '0000110', '0000011', '1000011', '1100110', '0111100'],
  4: ['0000110', '0001110', '0011110', '0110110', '1100110', '1111111', '1111111', '0000110', '0000110', '0000110'],
  7: ['1111111', '1111111', '0000110', '0001100', '0011000', '0110000', '0110000', '0110000', '0110000', '0110000'],
  9: ['0111110', '1100011', '1100011', '1100011', '0111111', '0000011', '0000110', '0001100', '0011000', '0110000'],
  A: ['0011100', '0111110', '1100011', '1100011', '1100011', '1111111', '1111111', '1100011', '1100011', '1100011'],
  C: ['0111110', '1100011', '1100000', '1100000', '1100000', '1100000', '1100000', '1100000', '1100011', '0111110'],
  E: ['1111111', '1111111', '1100000', '1100000', '1111100', '1111100', '1100000', '1100000', '1111111', '1111111'],
  H: ['1100011', '1100011', '1100011', '1100011', '1111111', '1111111', '1100011', '1100011', '1100011', '1100011'],
  K: ['1100011', '1100110', '1101100', '1111000', '1110000', '1110000', '1111000', '1101100', '1100110', '1100011'],
  M: ['1100011', '1110111', '1111111', '1101011', '1100011', '1100011', '1100011', '1100011', '1100011', '1100011'],
  N: ['1100011', '1110011', '1111011', '1111011', '1101111', '1101111', '1100111', '1100011', '1100011', '1100011'],
  P: ['1111110', '1100011', '1100011', '1100011', '1111110', '1100000', '1100000', '1100000', '1100000', '1100000'],
  R: ['1111110', '1100011', '1100011', '1100011', '1111110', '1111000', '1101100', '1100110', '1100011', '1100011'],
  T: ['1111111', '1111111', '0011100', '0011100', '0011100', '0011100', '0011100', '0011100', '0011100', '0011100'],
  W: ['1100011', '1100011', '1100011', '1100011', '1100011', '1101011', '1101011', '1111111', '1110111', '1100011'],
  X: ['1100011', '1100011', '0110110', '0011100', '0011100', '0011100', '0011100', '0110110', '1100011', '1100011'],
  Y: ['1100011', '1100011', '0110110', '0011100', '0011100', '0011100', '0011100', '0011100', '0011100', '0011100'],
};

// 兜底字体必须覆盖整个暗号字符集，否则会静默画出空白格子——那是"看不见"里最难查的一种。
for (const ch of NONCE_ALPHABET) {
  const glyph = GLYPHS[ch];
  if (!glyph || glyph.length !== GLYPH_H || glyph.some((row) => row.length !== GLYPH_W)) {
    throw new Error(`bitmap fallback font is missing or malformed for nonce char '${ch}'`);
  }
}

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
function bitmapNonceImage(text, scale = 18) {
  const advance = GLYPH_W + 1; // 字间留一整格，避免相邻笔画黏成一团
  const pad = scale * 2;
  const width = pad * 2 + (text.length * advance - 1) * scale;
  const height = pad * 2 + GLYPH_H * scale;
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
    for (let row = 0; row < GLYPH_H; row += 1) {
      for (let col = 0; col < GLYPH_W; col += 1) {
        if (glyph[row][col] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            plot(pad + index * advance * scale + col * scale + dx, pad + row * scale + dy);
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

/** 三级降级渲染，返回真实宽高（一律从落盘 PNG 的 IHDR 读，不猜）。 */
function renderNonceImage(text, outPath) {
  let renderer = 'bitmap';
  if (renderWithFfmpeg(text, outPath)) renderer = 'ffmpeg-drawtext';
  else if (renderWithMagick(text, outPath)) renderer = 'imagemagick';
  else writeFileSync(outPath, bitmapNonceImage(text));
  const buf = readFileSync(outPath);
  const { width, height } = pngSize(buf);
  return { renderer, width, height, bytes: buf.length };
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
