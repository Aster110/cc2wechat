import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getUpdates, getConfig } from '../../v5/receiver/wechat-receiver.js';

describe('wechat-receiver', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getUpdates', () => {
    it('posts to getupdates endpoint with token and buf, returns parsed msgs', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ ret: 0, msgs: [{ id: 1 }], get_updates_buf: 'next-buf' }),
      });

      const resp = await getUpdates('tok', 'buf-1', 'https://example.com', 1000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://example.com/ilink/bot/getupdates');
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer tok');
      const body = JSON.parse(init.body);
      expect(body.get_updates_buf).toBe('buf-1');
      expect(body.base_info).toBeDefined();
      expect(resp.msgs).toEqual([{ id: 1 }]);
      expect(resp.get_updates_buf).toBe('next-buf');
    });

    it('returns empty msgs on AbortError', async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      fetchMock.mockRejectedValue(err);

      const resp = await getUpdates('tok', 'buf-x', undefined, 10);
      expect(resp).toEqual({ ret: 0, msgs: [], get_updates_buf: 'buf-x' });
    });
  });

  describe('getConfig', () => {
    it('posts to getconfig endpoint, forwards userId and contextToken', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ context_token: 'new-ctx' }),
      });

      const resp = await getConfig('tok', 'user-1', 'ctx-1', 'https://example.com');

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://example.com/ilink/bot/getconfig');
      expect(init.headers['Authorization']).toBe('Bearer tok');
      const body = JSON.parse(init.body);
      expect(body.ilink_user_id).toBe('user-1');
      expect(body.context_token).toBe('ctx-1');
      expect(resp).toEqual({ context_token: 'new-ctx' });
    });
  });
});
