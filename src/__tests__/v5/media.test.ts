import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../wechat-api.js', () => ({
  downloadMedia: vi.fn(),
}));

vi.mock('../../utils.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import { downloadMediaItems } from '../../v5/receiver/media.js';
import { downloadMedia } from '../../wechat-api.js';
import { MessageItemType } from '../../types.js';
import type { WeixinMessage } from '../../types.js';
import type { AccountData } from '../../store.js';

const account: AccountData = {
  accountId: 'acc-1',
  token: 'tok',
  baseUrl: 'https://example.com',
  savedAt: '2026-01-01',
  port: 18081,
} as AccountData;

function makeMsg(items: any[], message_id = 100): WeixinMessage {
  return { message_id, item_list: items } as unknown as WeixinMessage;
}

describe('downloadMediaItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads image/video/file items', async () => {
    (downloadMedia as any).mockImplementation(async ({ outputFileName }: any) => `/tmp/${outputFileName}`);
    const msg = makeMsg([
      { type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } },
      { type: MessageItemType.VIDEO, video_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } },
      { type: MessageItemType.FILE, file_item: { file_name: 'doc.pdf', media: { encrypt_query_param: 'q', aes_key: 'k' } } },
    ]);

    const result = await downloadMediaItems(msg, account);

    expect(result.size).toBe(3);
    expect(result.get(0)).toMatch(/\.jpg$/);
    expect(result.get(1)).toMatch(/\.mp4$/);
    expect(result.get(2)).toMatch(/\.pdf$/);
    expect(downloadMedia).toHaveBeenCalledTimes(3);
    expect(downloadMedia).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ outputFileName: expect.stringMatching(/^100-0\./) }),
    );
    expect(downloadMedia).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ outputFileName: expect.stringMatching(/^100-1\./) }),
    );
    expect(downloadMedia).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ outputFileName: expect.stringMatching(/^100-2\./) }),
    );
  });

  it('skips non-media items like text', async () => {
    const msg = makeMsg([
      { type: MessageItemType.TEXT, text_item: { text: 'hi' } },
    ]);
    const result = await downloadMediaItems(msg, account);
    expect(result.size).toBe(0);
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('returns empty Map for empty item_list', async () => {
    const result = await downloadMediaItems(makeMsg([]), account);
    expect(result.size).toBe(0);
  });

  it('skips items missing aes_key or encrypt_query_param', async () => {
    const msg = makeMsg([
      { type: MessageItemType.IMAGE, image_item: { media: { aes_key: 'k' } } },
      { type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'q' } } },
      { type: MessageItemType.IMAGE, image_item: {} },
    ]);
    const result = await downloadMediaItems(msg, account);
    expect(result.size).toBe(0);
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('does not abort when a download fails; keeps successful ones', async () => {
    (downloadMedia as any)
      .mockResolvedValueOnce('/tmp/ok-0.jpg')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('/tmp/ok-2.jpg');

    const mk = () => ({
      type: MessageItemType.IMAGE,
      image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } },
    });
    const msg = makeMsg([mk(), mk(), mk()]);

    const result = await downloadMediaItems(msg, account);
    expect(result.size).toBe(2);
    expect(result.get(0)).toBe('/tmp/ok-0.jpg');
    expect(result.has(1)).toBe(false);
    expect(result.get(2)).toBe('/tmp/ok-2.jpg');
  });
});
