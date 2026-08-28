/**
 * waku-dm · 「这个本机文件能不能作为文件发出去」的纯判据（`file-kinds.ts`）。
 *
 * 这张表是平台上传门白名单的**本机镜像**，两边漂移的代价是真实的（用户看到「文件留在本机」
 * 或者白烧一次配额），所以逐条钉：收什么、不收什么、内容对不上怎么办、只看得到头部怎么办。
 */
import { describe, it, expect } from 'vitest';

import {
  DOCUMENT_MIMES,
  documentBytesMatch,
  documentMimeForPath,
  fileLinkText,
  fileNotSendableNotice,
  formatBytes,
  looksLikeUtf8Text,
} from '../../gateway/channels/waku-dm/file-kinds.js';

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('waku-dm · 文件类型白名单（平台上传门的本机镜像）', () => {
  it('扩展名 → mime：六种文档类都认，且只认这六种 mime', () => {
    expect(documentMimeForPath('/a/report.pdf')).toBe('application/pdf');
    expect(documentMimeForPath('/a/bundle.ZIP')).toBe('application/zip'); // 大小写不敏感
    expect(documentMimeForPath('/a/notes.txt')).toBe('text/plain');
    expect(documentMimeForPath('/a/run.log')).toBe('text/plain');
    expect(documentMimeForPath('/a/AGENTS.md')).toBe('text/markdown');
    expect(documentMimeForPath('/a/x.markdown')).toBe('text/markdown');
    expect(documentMimeForPath('/a/rows.csv')).toBe('text/csv');
    expect(documentMimeForPath('/a/data.json')).toBe('application/json');
    expect(documentMimeForPath('/a/events.jsonl')).toBe('application/json');
    expect(documentMimeForPath('/a/events.ndjson')).toBe('application/json');

    expect([...DOCUMENT_MIMES].sort()).toEqual([
      'application/json',
      'application/pdf',
      'application/zip',
      'text/csv',
      'text/markdown',
      'text/plain',
    ]);
  });

  it('会被浏览器执行 / 渲染的东西一个都不认——公开桶不裸托管脚本', () => {
    for (const name of ['/a/x.html', '/a/x.htm', '/a/x.svg', '/a/x.js', '/a/x.mjs', '/a/x.py', '/a/x.sh', '/a/x.bin', '/a/noext']) {
      expect(documentMimeForPath(name)).toBeNull();
    }
  });

  it('魔数：pdf 认 %PDF-，zip 认 PK\\x03\\x04（空归档 PK\\x05\\x06 刻意不收）', () => {
    expect(documentBytesMatch(utf8('%PDF-1.7\nrest'), 'application/pdf')).toBe(true);
    expect(documentBytesMatch(utf8('PDF-1.7'), 'application/pdf')).toBe(false);
    expect(documentBytesMatch(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'application/pdf')).toBe(false);

    expect(documentBytesMatch(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'application/zip')).toBe(true);
    expect(documentBytesMatch(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]), 'application/zip')).toBe(false);
    expect(documentBytesMatch(utf8('not a zip'), 'application/zip')).toBe(false);
  });

  it('文本类：UTF-8 可解码且不含 NUL —— 挡的是冒充文本的二进制，不是正文里的 <script>', () => {
    for (const mime of ['text/plain', 'text/markdown', 'text/csv', 'application/json']) {
      expect(documentBytesMatch(utf8('读我：一段中文 + ascii\n'), mime)).toBe(true);
      expect(documentBytesMatch(utf8('<html><script>alert(1)</script></html>'), mime)).toBe(true);
      expect(documentBytesMatch(Buffer.from([0x68, 0x00, 0x69]), mime)).toBe(false); // NUL
      expect(documentBytesMatch(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime)).toBe(false); // jpeg 头
    }
  });

  it('未知 mime 一律判否（表比调用方宽的时候不至于放行）', () => {
    expect(documentBytesMatch(utf8('anything'), 'text/html')).toBe(false);
    expect(documentBytesMatch(utf8('anything'), 'application/octet-stream')).toBe(false);
  });
});

describe('waku-dm · UTF-8 扫描器', () => {
  it('合法的多字节序列都放行（中文 / emoji / 边界码点）', () => {
    expect(looksLikeUtf8Text(utf8('a中文😀\n'))).toBe(true);
    expect(looksLikeUtf8Text(Buffer.from([0xc2, 0x80]))).toBe(true); // U+0080 最小二字节
    expect(looksLikeUtf8Text(Buffer.from([0xf4, 0x8f, 0xbf, 0xbf]))).toBe(true); // U+10FFFF
  });

  it('非法字节 / overlong / 代理区 / 超范围一律判死', () => {
    expect(looksLikeUtf8Text(Buffer.from([0x80]))).toBe(false); // 独立续字节
    expect(looksLikeUtf8Text(Buffer.from([0xc0, 0xaf]))).toBe(false); // overlong '/'
    expect(looksLikeUtf8Text(Buffer.from([0xc2, 0x41]))).toBe(false); // 续字节不是 10xxxxxx
    expect(looksLikeUtf8Text(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false); // U+D800 代理区
    expect(looksLikeUtf8Text(Buffer.from([0xf5, 0x80, 0x80, 0x80]))).toBe(false); // > U+10FFFF
    expect(looksLikeUtf8Text(Buffer.from([0xe0, 0x80, 0x80]))).toBe(false); // overlong 三字节
  });

  it('**只看到头部**时，末尾被截断的半个字符不算错（这是本模块存在的边界）', () => {
    const cut = utf8('中').subarray(0, 2); // 三字节字符只拿到两字节
    expect(looksLikeUtf8Text(cut, { truncated: true })).toBe(true);
    // 但如果这就是整个文件，那它确实不是合法 UTF-8。
    expect(looksLikeUtf8Text(cut, { truncated: false })).toBe(false);
    // 截断豁免只对「跨过末尾」的那一个序列生效，不是对整段放行。
    expect(looksLikeUtf8Text(Buffer.from([0x80, 0xe4, 0xb8]), { truncated: true })).toBe(false);
  });
});

describe('waku-dm · 文件消息的正文', () => {
  it('体积按人话写', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(2048)).toBe('2 KiB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MiB');
    expect(formatBytes(128 * 1024 * 1024)).toBe('128 MiB');
  });

  it('形态固定：📎 名字（大小）换行 URL；caption 顶在最前面', () => {
    expect(fileLinkText({ filename: 'report.pdf', sizeBytes: 2048, url: 'https://cdn/x.pdf' })).toBe(
      '📎 report.pdf（2 KiB）\nhttps://cdn/x.pdf',
    );
    expect(fileLinkText({ filename: 'a.txt', sizeBytes: 10, url: 'https://cdn/a', caption: '给你' })).toBe(
      '给你\n📎 a.txt（10 B）\nhttps://cdn/a',
    );
    // 空白 caption 不占一行
    expect(fileLinkText({ filename: 'a.txt', sizeBytes: 10, url: 'https://cdn/a', caption: '   ' })).toBe(
      '📎 a.txt（10 B）\nhttps://cdn/a',
    );
  });

  it('发不出去那句人话里必须带绝对路径（用户得知道东西在哪）', () => {
    expect(fileNotSendableNotice('/Users/me/x.py')).toContain('/Users/me/x.py');
  });
});
