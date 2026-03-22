import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  encryptAesEcb,
  aesEcbPaddedSize,
  getUpdates,
  sendMessage,
  getQRCode,
  pollQRStatus,
  sendTyping,
  getConfig,
} from '../src/wechat-api.js';

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function mockFetchJson(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: () => Promise.resolve(JSON.stringify(data)),
    json: () => Promise.resolve(data),
    headers: new Headers(),
  });
}

function mockFetchText(text: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
    headers: new Headers(),
  });
}

function mockFetchAbort() {
  return vi.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
}

// ---------------------------------------------------------------------------
// API function tests
// ---------------------------------------------------------------------------

describe('getUpdates', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns parsed messages on success', async () => {
    const resp = { ret: 0, msgs: [{ message_id: 1 }], get_updates_buf: 'buf2' };
    vi.stubGlobal('fetch', mockFetchText(JSON.stringify(resp)));

    const result = await getUpdates('tok', 'buf1');
    expect(result.ret).toBe(0);
    expect(result.msgs).toHaveLength(1);
    expect(result.get_updates_buf).toBe('buf2');
  });

  it('returns default value on AbortError (timeout)', async () => {
    vi.stubGlobal('fetch', mockFetchAbort());

    const result = await getUpdates('tok', 'buf1');
    expect(result.ret).toBe(0);
    expect(result.msgs).toEqual([]);
    expect(result.get_updates_buf).toBe('buf1');
  });
});

describe('sendMessage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends message successfully (no throw)', async () => {
    vi.stubGlobal('fetch', mockFetchText('{"ret":0}'));
    await expect(sendMessage('tok', 'user1', 'hello', 'ctx1')).resolves.toBeUndefined();
  });
});

describe('getQRCode', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns qrcode and qrcode_img_content', async () => {
    const data = { qrcode: 'qr123', qrcode_img_content: 'base64img' };
    vi.stubGlobal('fetch', mockFetchJson(data));

    const result = await getQRCode();
    expect(result.qrcode).toBe('qr123');
    expect(result.qrcode_img_content).toBe('base64img');
  });
});

describe('pollQRStatus', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns wait status', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ status: 'wait' }));
    const result = await pollQRStatus('qr123');
    expect(result.status).toBe('wait');
  });

  it('returns confirmed status with token', async () => {
    const data = { status: 'confirmed', bot_token: 'tok_abc', ilink_bot_id: 'bot1' };
    vi.stubGlobal('fetch', mockFetchJson(data));
    const result = await pollQRStatus('qr123');
    expect(result.status).toBe('confirmed');
    expect(result.bot_token).toBe('tok_abc');
  });

  it('returns { status: "wait" } on AbortError (timeout)', async () => {
    vi.stubGlobal('fetch', mockFetchAbort());
    const result = await pollQRStatus('qr123');
    expect(result.status).toBe('wait');
  });
});

describe('sendTyping', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends typing successfully (no throw)', async () => {
    vi.stubGlobal('fetch', mockFetchText('{"ret":0}'));
    await expect(sendTyping('tok', 'user1', 'ticket1')).resolves.toBeUndefined();
  });
});

describe('getConfig', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns typing_ticket', async () => {
    const data = { ret: 0, typing_ticket: 'ticket_xyz' };
    vi.stubGlobal('fetch', mockFetchText(JSON.stringify(data)));

    const result = await getConfig('tok', 'user1');
    expect(result.typing_ticket).toBe('ticket_xyz');
  });
});

// ---------------------------------------------------------------------------
// Crypto tests
// ---------------------------------------------------------------------------

describe('encryptAesEcb', () => {
  it('encrypt then decrypt produces original plaintext', () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from('Hello, WeChat!');

    const ciphertext = encryptAesEcb(plaintext, key);

    // Decrypt with node:crypto to verify
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    expect(decrypted.toString()).toBe('Hello, WeChat!');
  });

  it('produces ciphertext different from plaintext', () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from('test data here');
    const ciphertext = encryptAesEcb(plaintext, key);
    expect(ciphertext.equals(plaintext)).toBe(false);
  });

  it('different keys produce different ciphertext', () => {
    const key1 = crypto.randomBytes(16);
    const key2 = crypto.randomBytes(16);
    const plaintext = Buffer.from('same input');

    const c1 = encryptAesEcb(plaintext, key1);
    const c2 = encryptAesEcb(plaintext, key2);
    expect(c1.equals(c2)).toBe(false);
  });

  it('ciphertext length matches aesEcbPaddedSize', () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from('variable length content');
    const ciphertext = encryptAesEcb(plaintext, key);
    expect(ciphertext.length).toBe(aesEcbPaddedSize(plaintext.length));
  });

  it('encrypts empty buffer without error', () => {
    const key = crypto.randomBytes(16);
    const ciphertext = encryptAesEcb(Buffer.alloc(0), key);
    expect(ciphertext.length).toBe(16); // one full padding block

    // Decrypt to verify
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(decrypted.length).toBe(0);
  });
});

describe('aesEcbPaddedSize', () => {
  it('returns 16 for empty input (0 bytes)', () => {
    // 0 bytes plaintext → 16 bytes padding (full block of padding)
    expect(aesEcbPaddedSize(0)).toBe(16);
  });

  it('returns 16 for 1 byte', () => {
    expect(aesEcbPaddedSize(1)).toBe(16);
  });

  it('returns 16 for 15 bytes', () => {
    // 15 bytes + 1 padding = 16
    expect(aesEcbPaddedSize(15)).toBe(16);
  });

  it('returns 32 for 16 bytes (needs full padding block)', () => {
    // 16 bytes plaintext → needs extra block for PKCS7 padding
    expect(aesEcbPaddedSize(16)).toBe(32);
  });

  it('returns 32 for 17 bytes', () => {
    expect(aesEcbPaddedSize(17)).toBe(32);
  });

  it('returns 32 for 31 bytes', () => {
    expect(aesEcbPaddedSize(31)).toBe(32);
  });

  it('returns 48 for 32 bytes', () => {
    expect(aesEcbPaddedSize(32)).toBe(48);
  });
});
