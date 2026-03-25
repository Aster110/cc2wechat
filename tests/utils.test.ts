import { describe, it, expect } from 'vitest';
import { userIdToSessionUUID, extractText } from '../src/utils.js';
import { MessageItemType } from '../src/types.js';
import type { WeixinMessage } from '../src/types.js';

describe('userIdToSessionUUID', () => {
  it('returns a valid UUID v4 format', () => {
    const uuid = userIdToSessionUUID('test-user');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is deterministic — same input gives same output', () => {
    const a = userIdToSessionUUID('user-123');
    const b = userIdToSessionUUID('user-123');
    expect(a).toBe(b);
  });

  it('different users get different UUIDs', () => {
    const a = userIdToSessionUUID('user-a');
    const b = userIdToSessionUUID('user-b');
    expect(a).not.toBe(b);
  });
});

describe('extractText', () => {
  it('extracts text from text items', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hello' } }],
    };
    expect(extractText(msg)).toBe('hello');
  });

  it('extracts multiple text items joined by newlines', () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: 'line 1' } },
        { type: MessageItemType.TEXT, text_item: { text: 'line 2' } },
      ],
    };
    expect(extractText(msg)).toBe('line 1\nline 2');
  });

  it('returns [Image] for image items without download path', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.IMAGE }],
    };
    expect(extractText(msg)).toBe('[Image]');
  });

  it('returns [Image: path] for image items with download path', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.IMAGE }],
    };
    const mediaPaths = new Map([[0, '/tmp/photo.jpg']]);
    expect(extractText(msg, mediaPaths)).toBe('[Image: /tmp/photo.jpg]');
  });

  it('extracts voice text', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.VOICE, voice_item: { text: 'hello voice' } }],
    };
    expect(extractText(msg)).toBe('[Voice] hello voice');
  });

  it('extracts file name', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.FILE, file_item: { file_name: 'doc.pdf' } }],
    };
    expect(extractText(msg)).toBe('[File: doc.pdf]');
  });

  it('returns [Video] for video items', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.VIDEO }],
    };
    expect(extractText(msg)).toBe('[Video]');
  });

  it('returns [Empty message] for empty item list', () => {
    const msg: WeixinMessage = { item_list: [] };
    expect(extractText(msg)).toBe('[Empty message]');
  });

  it('returns [Empty message] for missing item list', () => {
    const msg: WeixinMessage = {};
    expect(extractText(msg)).toBe('[Empty message]');
  });
});
