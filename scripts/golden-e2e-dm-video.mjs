// waku-dm 视频金线 E2E —— 扮演 owner（真人账号），走真 Waku 聊天域 ↔ daemon ↔ 真 Codex。
//
// 单测里 ffmpeg 是替身、Codex 是假的，所以下面这两件事**只有在这里才验得到**：
//
//   1. 入站：给马甲发一段**画面上烧着暗号**的视频 → 等它用文字把暗号念回来。
//      这一轮真正在验的是 `[VideoFrame: …]`：codex 的 turn input 没有视频块，一个 .mp4 只会退化成
//      正文里的一行 `[附件] <path>`；只有 daemon 替它抽出来的那一帧作为图片块交上去，
//      模型才**必然**看得见画面。念得出暗号 = 那一帧真的进了模型的眼睛。
//   2. 出站：让它自己做一段 3 秒视频发回来 → 等一条 `kind=video`，且
//      `payload.poster_url` 非空、`duration_ms ≤ 3500`。
//      poster 非空 = 抽封面那半边通了；时长合规 = 转码决策没把一个 3 秒片子转坏。
//
// 前置：
//   1. daemon 已起（bridge 模式：WAKU_GATEWAY_CHANNEL=waku-dm + BRIDGE_CREDENTIAL_FILE），/health 绿；
//   2. owner 的 ~/.config/waku/auth.json 已登录（`waku login`），且 owner 与马甲互相关注；
//   3. **本机与 daemon 那台机器都要有 ffmpeg**（这条金线验的就是 ffmpeg 那条链）。
//      注意只要求 ffmpeg 本体，**不要求 drawtext/libfreetype**：暗号是先渲成 PNG 再 `-loop 1` 合进视频的，
//      渲染走 scripts/lib/nonce-image.mjs 的三级降级（brew 的 ffmpeg 普遍没编 libfreetype，
//      本机 8.1 实测 `-filters | grep drawtext` 为 0；把金线钉死在一个可选编译开关上，
//      等于让环境缺件事就把整条链路判死）。
// 参数（环境变量）：
//   PERSONA_USER_ID     必填：马甲的 user_id
//   WAKU_API_BASE       可选：v1 base，默认 auth.json 的 api_base
//   WAKU_CLI_AUTH_PATH  可选：默认 ~/.config/waku/auth.json
//   GOLDEN_TIMEOUT_MS   可选：每轮等回复的上限，默认 300000
//   GOLDEN_KEEP_VIDEO   可选：=1 时保留生成的 mp4（排查"视频到底长啥样"）
// 纪律：不打印 token；只打印会话 id 前缀与回复前 120 字。
import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
// 暗号字符集与三级降级渲染与图片金线同源（scripts/lib/nonce-image.mjs），一处修好两处受益。
import { makeNonce, normalizeReply, renderNonceImage, tryRun } from './lib/nonce-image.mjs';

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

// ── 测试视频：暗号烧进画面 ────────────────────────────────────
// 暗号字符集、三级降级渲染、回复归一化都在 scripts/lib/nonce-image.mjs，与图片金线同源。

const run = (cmd, args) => tryRun(cmd, args, 120_000);

function ffprobeJson(file) {
  const out = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(out);
}

/**
 * 3 秒 720p h264，整屏就是那张暗号图。
 *
 * 为什么不用 `drawtext`：它要 libfreetype，而 brew 的 ffmpeg 普遍没编（本机 8.1 实测缺）。
 * 一旦缺，这条金线在第 0 步就死，而它本来要验的是 daemon 的抽帧 / 转码 / 封面——
 * **渲染器可用性是环境属性、不是被测对象**，不该有权把整条链路判死。
 * 所以改成：先让图片金线那套三级降级渲染器产一张暗号 PNG，再 `-loop 1` 把它合成视频。
 * 于是这里对 ffmpeg 的要求退回到"能 encode h264"这一条最基本的能力。
 *
 * 输出固定 1280x720（两边都是偶数——yuv420p 的色度二次采样要求边长可被 2 整除，
 * 奇数边会让 libx264 直接报错）：`force_original_aspect_ratio=decrease` 先把 PNG 等比缩放到
 * 框内最大，再 `pad` 白底居中补齐，无论渲染器产出多大的图，出来的都是同一个合规画布。
 */
function makeNonceVideo(nonce, outPath) {
  const pngPath = outPath.replace(/\.mp4$/, '.png');
  const rendered = renderNonceImage(nonce, pngPath);
  const ok = run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-loop', '1', '-i', pngPath,
    '-t', '3', '-r', '30',
    '-vf', 'scale=w=1280:h=720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    // 每秒一个关键帧：静止画面的 GOP 会拉得很长，而对面要按时间戳抽封面帧。
    '-g', '30',
    '-movflags', '+faststart',
    outPath,
  ]);
  try {
    unlinkSync(pngPath);
  } catch {
    /* 渲染中间产物，删不掉也不影响判定 */
  }
  if (!ok || !existsSync(outPath) || statSync(outPath).size === 0) {
    console.error('ffmpeg could not encode the nonce video (can this ffmpeg do libx264?)');
    console.error('  try: ffmpeg -hide_banner -encoders | grep libx264');
    process.exit(2);
  }
  const probe = ffprobeJson(outPath);
  const v = (probe.streams || []).find((s) => s.codec_type === 'video') || {};
  return {
    renderer: rendered.renderer,
    bytes: statSync(outPath).size,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    durationMs: Math.round(Number(probe.format?.duration || 0) * 1000),
  };
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

// ── 0. 前置：本机必须有 ffmpeg ────────────────────────────
if (!run('ffprobe', ['-version']) || !run('ffmpeg', ['-version'])) {
  console.error('ffmpeg/ffprobe not found on this box — this golden path is exactly about the ffmpeg link');
  process.exit(2);
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

async function sendVideo(assetId, meta) {
  const out = await api('POST', `/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    client_msg_id: `golden-vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'video',
    payload: { asset_id: assetId, width: meta.width, height: meta.height, duration_ms: meta.durationMs },
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

// ── 2. 发一段画面上写着暗号的视频，等它把暗号念回来 ─────────
const nonce = makeNonce();
const videoPath = path.join(os.tmpdir(), `waku-golden-${nonce}.mp4`);
const meta = makeNonceVideo(nonce, videoPath);
log(
  `2. turn #1 video nonce=${nonce} renderer=${meta.renderer} ` +
    `${meta.width}x${meta.height} ${meta.durationMs}ms bytes=${meta.bytes} …`,
);
if (meta.renderer === 'bitmap') {
  log('   (no ffmpeg/drawtext and no ImageMagick on this box — fell back to the built-in bitmap font)');
}

const assetId = await uploadAsset(videoPath, 'video/mp4');
const seq1 = await sendVideo(assetId, meta);
await sendText('这段视频的画面中央写着一串暗号，请只回答那串暗号本身，不要任何其他文字。');
const reply1 = await waitForReply(
  seq1,
  (m) => m.kind === 'text' && normalizeReply(m.body).includes(nonce),
  'the persona to read the nonce off the video frame',
);
log(`   REPLY#1 (conv_seq=${reply1.conv_seq}):`, JSON.stringify(reply1.body).slice(0, 120));

// ── 3. 让它自己做一段 3 秒视频发回来（验出站转码 + 封面） ────
const outNonce = makeNonce();
log(`3. turn #2 (ask it to produce a 3s video with nonce=${outNonce}) …`);
const seq2 = await sendText(
  `请用 ffmpeg 做一个 3 秒的视频，画面上用大号字写着 ${outNonce}，然后把这个视频发给我。`,
);
const reply2 = await waitForReply(seq2, (m) => m.kind === 'video', 'the persona to send a video back');
const payload = reply2.payload || {};
log(
  `   REPLY#2 (conv_seq=${reply2.conv_seq}, kind=${reply2.kind}, ` +
    `${payload.width ?? '?'}x${payload.height ?? '?'}, duration_ms=${payload.duration_ms ?? '?'}, ` +
    `poster=${payload.poster_url ? 'yes' : 'NO'})`,
);

const problems = [];
// 封面：抽帧 + 上传 + payload 回填这三节任何一节断了，这里就是空的。
if (!payload.poster_url) problems.push('payload.poster_url is empty (poster extraction/upload/wiring broke)');
// 时长：3 秒的片子不该被转成别的长度；给 500ms 余量兜住关键帧对齐。
if (typeof payload.duration_ms !== 'number') problems.push('payload.duration_ms missing');
else if (payload.duration_ms > 3500) problems.push(`payload.duration_ms=${payload.duration_ms} > 3500`);
// 分辨率：转码上限是 1280x720，超了说明转码决策或参数漂了。
if (typeof payload.width === 'number' && payload.width > 1280) problems.push(`width=${payload.width} > 1280`);
if (typeof payload.height === 'number' && payload.height > 720) problems.push(`height=${payload.height} > 720`);

if (problems.length > 0) {
  console.error('');
  console.error('❌ GOLDEN PATH FAIL: the outbound video is not in playable shape');
  for (const p of problems) console.error(`   - ${p}`);
  console.error(`   conversation=${conversationId}`);
  process.exit(1);
}

if (process.env.GOLDEN_KEEP_VIDEO === '1') log(`   (kept test video at ${videoPath})`);
else unlinkSync(videoPath);
log('');
log('✅ GOLDEN PATH PASS: video in → Codex reads the burned-in nonce off the extracted frame → playable video out with a poster');
log(`   conversation=${conversationId}`);
