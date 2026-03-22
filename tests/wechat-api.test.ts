import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encryptAesEcb, aesEcbPaddedSize } from '../src/wechat-api.js';

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
