/**
 * 「这个本机文件能不能作为**文件**发出去」——平台上传门白名单的本机镜像。
 *
 * Waku 私聊**没有 `file` 消息类型**（`SUPPORTED_MESSAGE_KINDS` = text / playable_card /
 * image / video / sticker / voice，且平台侧不为此新增：多一个 kind 要动三端渲染 + 通知摘要 +
 * 会话预览）。所以文件走的是一条绕路：**上传到 bridge 上传门拿一条公开 URL，再以一条
 * `kind=text` 的消息把链接发过去**。用户点开就能下载，客户端零改动。
 *
 * 于是「能不能发」= 「平台的上传门收不收」。判据只有一条：
 * **这串字节从公开桶直连时会不会被浏览器执行 / 渲染**。会的一律不收——`.html` / `.svg` /
 * `.js` 不在表里（HTML 产物有自己的正路：`waku ship` 成 playable 进受控 runtime）。
 *
 * **为什么本机也要判一次，而不是直接传上去让平台拒**：
 * 平台侧的 415 是 `permanent-failure`，用户屏幕上什么都不会出现；而且每一发都要烧一次
 * 每日配额和一整个文件的上行带宽。本机先判 = 拒得起、拒得快、拒得出人话。
 *
 * **本机判错了怎么办**（表与平台漂移了）：两个方向都收敛在安全侧——
 * 表比平台**窄** ⇒ 用户拿到「文件留在本机」，信息没丢；
 * 表比平台**宽** ⇒ 上传吃一个 415，发送方把它降级成同一句人话（不是 `permanent-failure`）。
 *
 * 本模块**零 I/O**：只认扩展名与一段头部字节，因此能被纯函数单测钉死。
 */
import path from 'node:path';

/** 扩展名 → 平台白名单里的 mime。不在表里 = 这个文件发不出去。 */
const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.tsv': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jsonl': 'application/json',
  '.ndjson': 'application/json',
};

/** 平台白名单里的文档类 mime 全集（`AGENT_BRIDGE_ASSET_MIME_ALLOWLIST` 的文档半边）。 */
export const DOCUMENT_MIMES: ReadonlySet<string> = new Set(Object.values(DOCUMENT_MIME_BY_EXT));

/** 判 UTF-8 时最多看这么多头部字节。平台那端判的是全量，这里只求「一眼就不像文本」的先拒。 */
export const DOCUMENT_HEAD_BYTES = 64 * 1024;

export function documentMimeForPath(filePath: string): string | null {
  return DOCUMENT_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

/**
 * UTF-8 扫描器（不含 NUL）。
 *
 * 为什么不用 `TextDecoder({fatal:true})`：我们只拿到**头部**若干字节，最后一个多字节字符很可能
 * 被截断——那不是「不是文本」，只是「还没读完」。所以自己扫：截断处的半个合法序列放行，
 * 真正的非法字节（0xC0/0xC1/0xF5+、错误的续字节、超范围码点、代理区）才判死。
 *
 * NUL 单独判：它是「二进制冒充文本」最廉价的判据（ELF / dylib / 加密载荷改名 .txt）。
 */
export function looksLikeUtf8Text(head: Uint8Array, options: { truncated?: boolean } = {}): boolean {
  const truncated = options.truncated ?? false;
  const length = head.length;
  let i = 0;
  while (i < length) {
    const byte = head[i];
    if (byte === 0x00) return false;
    if (byte < 0x80) {
      i += 1;
      continue;
    }
    let need: number;
    let codepoint: number;
    if (byte >= 0xc2 && byte <= 0xdf) {
      need = 1;
      codepoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      need = 2;
      codepoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      need = 3;
      codepoint = byte & 0x07;
    } else {
      return false; // 0x80..0xC1 独立出现 / 0xF5.. 都不是合法起始字节
    }
    if (i + need >= length) {
      // 序列跨过了我们看到的末尾：只有在「确实是被截断的头部」时才算无罪。
      return truncated;
    }
    for (let k = 1; k <= need; k += 1) {
      const cont = head[i + k];
      if ((cont & 0xc0) !== 0x80) return false;
      codepoint = (codepoint << 6) | (cont & 0x3f);
    }
    if (codepoint > 0x10ffff) return false;
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) return false; // 代理区不是合法标量值
    if (need === 2 && codepoint < 0x800) return false; // overlong
    if (need === 3 && codepoint < 0x10000) return false;
    i += need + 1;
  }
  return true;
}

/**
 * 头部字节与声明 mime 对不对得上。对不上 = 别传了，平台那端也会 415。
 *
 * 与平台 `_MAGIC` 表逐条同源：pdf `%PDF-`、zip `PK\x03\x04`（空归档 `PK\x05\x06` 两端都不收——
 * 零条目没有东西可送达）、文本类 UTF-8 且无 NUL。
 */
export function documentBytesMatch(head: Uint8Array, mime: string, options: { truncated?: boolean } = {}): boolean {
  if (mime === 'application/pdf') {
    return head.length >= 5 && Buffer.from(head.subarray(0, 5)).toString('latin1') === '%PDF-';
  }
  if (mime === 'application/zip') {
    return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  }
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/csv' || mime === 'application/json') {
    return looksLikeUtf8Text(head, options);
  }
  return false;
}

/** `1023 B` / `47 KiB` / `3.4 MiB` / `128 MiB`。给用户看的，不是给机器解析的。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  const mib = bytes / (1024 * 1024);
  return `${mib >= 10 ? Math.round(mib) : Number(mib.toFixed(1))} MiB`;
}

/** 文件消息的正文：`📎 <文件名>（<大小>）\n<url>`。caption 有就顶在最前面。 */
export function fileLinkText(input: { filename: string; sizeBytes: number; url: string; caption?: string }): string {
  const line = `📎 ${input.filename}（${formatBytes(input.sizeBytes)}）\n${input.url}`;
  const caption = (input.caption ?? '').trim();
  return caption.length === 0 ? line : `${caption}\n${line}`;
}

/** 发不出去时的那句人话。**逐字节是契约**：金线脚本与 SKILL.md 都照着它对。 */
export function fileNotSendableNotice(filePath: string): string {
  return `这个类型的文件发不了（只能发 pdf / zip / txt / md / csv / json），先留在本机：${filePath}`;
}
