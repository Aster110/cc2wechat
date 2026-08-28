// 金线共用的「暗号图」渲染器。
//
// 图片金线与视频金线都要问同一个问题：**模型到底看没看见画面**。答案要可信，测试图就必须
// 「人眼一秒能读」——第 1 轮判的是"看见没有"，不是"OCR 强不强"。所以这里做两件事：
//
//   1. 暗号字符集剔掉所有成对易混字形（0/O/D、1/I/l/J、2/Z、5/S、6/G、8/B、U/V），
//      剩下的都是"错认了也不像另一个合法字符"的形 ⇒ 第 1 轮失败就一定是没看见，而不是看花了；
//   2. 渲染走三级降级（ffmpeg drawtext → ImageMagick → 内置点阵），因为**渲染器可用性是环境属性、
//      不是被测对象**：brew 的 ffmpeg 普遍没编 libfreetype（本机 8.1 实测 `-filters | grep drawtext`
//      为 0），要是把金线钉死在 drawtext 上，环境缺个可选编译开关就能把整条链路判死。
//
// 视频金线复用同一个渲染器：先渲一张 PNG，再 `-loop 1` 合成视频（见 golden-e2e-dm-video.mjs），
// 于是两条金线的"暗号长什么样"完全同源，一处修好两处受益。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

export const NONCE_ALPHABET = '3479ACEHKMNPRTWXY';
export const NONCE_LENGTH = 6;

export function makeNonce() {
  let out = '';
  for (let i = 0; i < NONCE_LENGTH; i += 1) {
    out += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)];
  }
  return out;
}

/** 回复里只要出现暗号即可：忽略大小写、空格与任何标点/分隔符。 */
export const normalizeReply = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** 从 PNG 的 IHDR 读真实宽高——三种渲染器都产标准 PNG，IHDR 恒在 offset 8。 */
export function pngSize(buf) {
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
export const systemFont = () => FONT_CANDIDATES.find((p) => existsSync(p)) || null;

export function tryRun(cmd, args, timeoutMs = 30_000) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
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
export function bitmapNonceImage(text, scale = 18) {
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
export function renderNonceImage(text, outPath) {
  let renderer = 'bitmap';
  if (renderWithFfmpeg(text, outPath)) renderer = 'ffmpeg-drawtext';
  else if (renderWithMagick(text, outPath)) renderer = 'imagemagick';
  else writeFileSync(outPath, bitmapNonceImage(text));
  const buf = readFileSync(outPath);
  const { width, height } = pngSize(buf);
  return { renderer, width, height, bytes: buf.length };
}
