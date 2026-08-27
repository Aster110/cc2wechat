import { describe, it, expect } from 'vitest';
import * as api from '../../wechat-api.js';

describe('wechat-api barrel re-export', () => {
  it('re-exports receiver functions', () => {
    expect(typeof api.getUpdates).toBe('function');
    expect(typeof api.getConfig).toBe('function');
  });

  it('re-exports sender functions', () => {
    expect(typeof api.sendMessage).toBe('function');
    expect(typeof api.sendTyping).toBe('function');
    expect(typeof api.uploadAndSendMedia).toBe('function');
    expect(typeof api.downloadMedia).toBe('function');
  });

  it('still exports QR and crypto helpers', () => {
    expect(typeof api.getQRCode).toBe('function');
    expect(typeof api.pollQRStatus).toBe('function');
    expect(typeof api.encryptAesEcb).toBe('function');
    expect(typeof api.decryptAesEcb).toBe('function');
    expect(typeof api.decodeAesKey).toBe('function');
    expect(typeof api.aesEcbPaddedSize).toBe('function');
  });

  it('named imports work via barrel', async () => {
    const { getUpdates, sendMessage, getConfig, sendTyping, uploadAndSendMedia, downloadMedia } =
      await import('../../wechat-api.js');
    expect(getUpdates).toBeDefined();
    expect(sendMessage).toBeDefined();
    expect(getConfig).toBeDefined();
    expect(sendTyping).toBeDefined();
    expect(uploadAndSendMedia).toBeDefined();
    expect(downloadMedia).toBeDefined();
  });
});
