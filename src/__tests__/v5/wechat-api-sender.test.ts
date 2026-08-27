import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  sendMessage,
  sendTyping,
  uploadAndSendMedia,
  downloadMedia,
} from '../../v5/sender/wechat-api-sender.js';

describe('wechat-api-sender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('sendMessage', () => {
    it('posts text message with token/to/ctx to sendmessage endpoint', async () => {
      fetchMock.mockResolvedValue({ ok: true, text: async () => '{}' });

      await sendMessage('tok', 'user-1', 'hello', 'ctx-1', 'https://example.com');

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://example.com/ilink/bot/sendmessage');
      expect(init.headers['Authorization']).toBe('Bearer tok');
      const body = JSON.parse(init.body);
      expect(body.msg.to_user_id).toBe('user-1');
      expect(body.msg.context_token).toBe('ctx-1');
      expect(body.msg.item_list[0].text_item.text).toBe('hello');
    });
  });

  describe('sendTyping', () => {
    it('posts to sendtyping with user/ticket/status', async () => {
      fetchMock.mockResolvedValue({ ok: true, text: async () => '{}' });

      await sendTyping('tok', 'user-1', 'tick-1', 1, 'https://example.com');

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://example.com/ilink/bot/sendtyping');
      const body = JSON.parse(init.body);
      expect(body.ilink_user_id).toBe('user-1');
      expect(body.typing_ticket).toBe('tick-1');
      expect(body.status).toBe(1);
    });
  });

  describe('uploadAndSendMedia', () => {
    it('uploads file to CDN then sends media message', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcc-test-'));
      const filePath = path.join(tmpDir, 'pic.jpg');
      await fsp.writeFile(filePath, Buffer.from('hello-image-bytes'));

      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('getuploadurl')) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({ upload_param: 'up-param', filekey: 'server-key' }),
          };
        }
        if (u.includes('/upload?')) {
          return {
            ok: true,
            text: async () => '',
            headers: { get: (h: string) => (h === 'x-encrypted-param' ? 'dl-param' : null) },
          };
        }
        if (u.includes('sendmessage')) {
          return { ok: true, text: async () => '{}' };
        }
        throw new Error(`unexpected url ${u}`);
      });

      await uploadAndSendMedia({
        token: 'tok',
        toUser: 'user-1',
        contextToken: 'ctx-1',
        filePath,
        baseUrl: 'https://example.com',
        cdnBaseUrl: 'https://cdn.example.com',
      });

      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('getuploadurl'))).toBe(true);
      expect(urls.some((u) => u.startsWith('https://cdn.example.com/upload?'))).toBe(true);
      expect(urls.some((u) => u.includes('sendmessage'))).toBe(true);

      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('downloadMedia', () => {
    it('downloads from CDN, decrypts, writes file, returns path', async () => {
      // Build a valid encrypted payload matching decodeAesKey/decryptAesEcb logic
      const { encryptAesEcb } = await import('../../wechat-api.js');
      const key = Buffer.alloc(16, 7);
      const plaintext = Buffer.from('plain-content');
      const ciphertext = encryptAesEcb(plaintext, key);
      const aesKeyField = Buffer.from(key.toString('hex')).toString('base64');

      fetchMock.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength),
      });

      const outPath = await downloadMedia({
        token: 'tok',
        encryptQueryParam: 'enc-q',
        aesKey: aesKeyField,
        outputFileName: 'out.bin',
        baseUrl: 'https://example.com',
        cdnBaseUrl: 'https://cdn.example.com',
      });

      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('https://cdn.example.com/download?encrypted_query_param=enc-q');
      expect(outPath).toContain('out.bin');
      const written = await fsp.readFile(outPath);
      expect(written.toString()).toBe('plain-content');
    });
  });
});
