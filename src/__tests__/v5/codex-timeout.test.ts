import { afterEach, describe, expect, it } from 'vitest';

import { legacyCodexChatTimeoutMs } from '../../v5/backends/codex.js';

const savedTimeout = process.env.CC2WECHAT_TURN_TIMEOUT_MS;

afterEach(() => {
  if (savedTimeout == null) delete process.env.CC2WECHAT_TURN_TIMEOUT_MS;
  else process.env.CC2WECHAT_TURN_TIMEOUT_MS = savedTimeout;
});

describe('legacy CodexBackend turn timeout', () => {
  it('默认禁用机械墙钟超时', () => {
    delete process.env.CC2WECHAT_TURN_TIMEOUT_MS;
    expect(legacyCodexChatTimeoutMs()).toBe(0);
  });

  it('仍可显式配置运维安全阀', () => {
    process.env.CC2WECHAT_TURN_TIMEOUT_MS = '900000';
    expect(legacyCodexChatTimeoutMs()).toBe(900000);
  });
});
