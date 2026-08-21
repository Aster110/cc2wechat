/**
 * Core · 出站附件标记词法。
 *
 * 这是 Agent 面向的公开契约：改这里的任何一条断言，等于改 Codex 已经学会的口令。
 */
import { describe, it, expect } from 'vitest';

import {
  attachmentKindForPath,
  mergeAttachments,
  parseAttachmentMarkers,
} from '../../gateway/core/attachments.js';

describe('attachment markers · 词法', () => {
  it('五种标记都认，且从正文里剥干净', () => {
    const parsed = parseAttachmentMarkers(
      [
        '给你几样东西：',
        '[[send-image: /tmp/a.png]]',
        '[[send-video: /tmp/b.mp4]]',
        '[[send-audio: /tmp/c.m4a]]',
        '[[send-file: /tmp/d.pdf]]',
        '[[send-card: cnt_abc123]]',
        '就这些。',
      ].join('\n'),
    );

    expect(parsed.attachments).toEqual([
      { kind: 'image', path: '/tmp/a.png' },
      { kind: 'video', path: '/tmp/b.mp4' },
      { kind: 'audio', path: '/tmp/c.m4a' },
      { kind: 'file', path: '/tmp/d.pdf' },
      { kind: 'card', contentId: 'cnt_abc123' },
    ]);
    expect(parsed.text).toBe('给你几样东西：\n就这些。');
    expect(parsed.text).not.toContain('send-image');
  });

  it('行内标记也剥，剩下的正文照发', () => {
    const parsed = parseAttachmentMarkers('这是封面 [[send-image: /tmp/cover.png]] 喜欢吗？');
    expect(parsed.attachments).toEqual([{ kind: 'image', path: '/tmp/cover.png' }]);
    expect(parsed.text).toBe('这是封面 喜欢吗？');
  });

  it('card 带 launch_ctx：JSON 解析成字符串字典', () => {
    const parsed = parseAttachmentMarkers('[[send-card: cnt_x launch_ctx={"room":"ABCD","seat":"2"}]]');
    expect(parsed.attachments).toEqual([
      { kind: 'card', contentId: 'cnt_x', launchCtx: { room: 'ABCD', seat: '2' } },
    ]);
    expect(parsed.text).toBe('');
  });

  it('launch_ctx 不是合法 JSON：卡片照发，只丢这个旋钮', () => {
    const parsed = parseAttachmentMarkers('[[send-card: cnt_x launch_ctx={oops}]]');
    expect(parsed.attachments).toEqual([{ kind: 'card', contentId: 'cnt_x' }]);
  });

  it('大小写与空白容错：kind 后的冒号可以带空格', () => {
    const parsed = parseAttachmentMarkers('[[send-image :   /tmp/a b.png   ]]');
    expect(parsed.attachments).toEqual([{ kind: 'image', path: '/tmp/a b.png' }]);
  });

  it('不认识的标记原样留在正文（宁可难看也不静默吞话）', () => {
    const parsed = parseAttachmentMarkers('[[send-sticker: 123]] 还有 [[send-image:]] 空参数');
    expect(parsed.attachments).toEqual([]);
    expect(parsed.text).toContain('send-sticker');
    expect(parsed.text).toContain('[[send-image:]]');
  });

  it('没有标记时正文一字不改（除了两端空白）', () => {
    const parsed = parseAttachmentMarkers('  普通回复\n第二行  ');
    expect(parsed.attachments).toEqual([]);
    expect(parsed.text).toBe('普通回复\n第二行');
  });

  it('全是标记时正文为空串（通道据此只发附件、不发空消息）', () => {
    const parsed = parseAttachmentMarkers('[[send-image: /tmp/a.png]]');
    expect(parsed.text).toBe('');
  });
});

describe('attachment markers · mediaFiles 合流', () => {
  it('扩展名决定类型', () => {
    expect(attachmentKindForPath('/x/a.PNG')).toBe('image');
    expect(attachmentKindForPath('/x/a.m4a')).toBe('audio');
    expect(attachmentKindForPath('/x/a.mov')).toBe('video');
    expect(attachmentKindForPath('/x/a.pdf')).toBe('file');
    expect(attachmentKindForPath('/x/noext')).toBe('file');
  });

  it('mediaFiles 在前、标记在后，同一路径不发两次', () => {
    const { attachments } = parseAttachmentMarkers('[[send-image: /tmp/a.png]][[send-card: cnt_1]]');
    const merged = mergeAttachments(['/tmp/a.png', '/tmp/z.mp4'], attachments);
    expect(merged).toEqual([
      { kind: 'image', path: '/tmp/a.png' },
      { kind: 'video', path: '/tmp/z.mp4' },
      { kind: 'card', contentId: 'cnt_1' },
    ]);
  });
});
