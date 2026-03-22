import { describe, it, expect } from 'vitest';
import { extractText, userIdToSessionUUID, sleep } from '../src/utils.js';
import { MessageItemType } from '../src/types.js';
import type { WeixinMessage } from '../src/types.js';

describe('extractText', () => {
  it('extracts text from a text message', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hello world' } }],
    };
    expect(extractText(msg)).toBe('hello world');
  });

  it('returns [Image] for image messages', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.IMAGE }],
    };
    expect(extractText(msg)).toBe('[Image]');
  });

  it('extracts voice text', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.VOICE, voice_item: { text: 'voice content' } }],
    };
    expect(extractText(msg)).toBe('[Voice] voice content');
  });

  it('returns [Video] for video messages', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.VIDEO }],
    };
    expect(extractText(msg)).toBe('[Video]');
  });

  it('extracts file name', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.FILE, file_item: { file_name: 'doc.pdf' } }],
    };
    expect(extractText(msg)).toBe('[File: doc.pdf]');
  });

  it('returns [Empty message] for empty item_list', () => {
    const msg: WeixinMessage = { item_list: [] };
    expect(extractText(msg)).toBe('[Empty message]');
  });

  it('returns [Empty message] when item_list is undefined', () => {
    const msg: WeixinMessage = {};
    expect(extractText(msg)).toBe('[Empty message]');
  });

  it('joins multiple items with newline', () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: 'line1' } },
        { type: MessageItemType.IMAGE },
      ],
    };
    expect(extractText(msg)).toBe('line1\n[Image]');
  });

  it('returns [Empty message] for VOICE without text', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.VOICE, voice_item: {} }],
    };
    expect(extractText(msg)).toBe('[Empty message]');
  });

  it('returns [Empty message] for FILE without file_name', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: MessageItemType.FILE, file_item: {} }],
    };
    expect(extractText(msg)).toBe('[Empty message]');
  });

  it('skips items with unknown type', () => {
    const msg: WeixinMessage = {
      item_list: [{ type: 99 }],
    };
    expect(extractText(msg)).toBe('[Empty message]');
  });
});

describe('userIdToSessionUUID', () => {
  it('is deterministic (same input same output)', () => {
    const a = userIdToSessionUUID('user123');
    const b = userIdToSessionUUID('user123');
    expect(a).toBe(b);
  });

  it('returns valid UUID v4 format', () => {
    const uuid = userIdToSessionUUID('testuser');
    // UUID format: 8-4-4-4-12
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('produces different outputs for different inputs', () => {
    const a = userIdToSessionUUID('user_a');
    const b = userIdToSessionUUID('user_b');
    expect(a).not.toBe(b);
  });
});

describe('sleep', () => {
  it('resolves after the specified duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
  });

  it('resolves to undefined', async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});
