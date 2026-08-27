import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/wechat-api.js', () => ({
  getUpdates: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue({}),
  uploadAndSendMedia: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock('../../src/store.js', () => ({ loadSyncBuf: vi.fn().mockReturnValue(''), saveSyncBuf: vi.fn() }));
vi.mock('../../src/utils.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  extractText: (m: any) => m?.item_list?.[0]?.text_item?.text ?? '',
  userIdToSessionUUID: (u: string) => `uuid-${u}`,
}));
vi.mock('../../src/v5/receiver/media.js', () => ({ downloadMediaItems: vi.fn().mockResolvedValue(new Map()) }));

import { processMessage } from '../../src/v5/core/poller.js';
import { sendMessage } from '../../src/wechat-api.js';

const account = { accountId: 'a', token: 'tok', baseUrl: 'https://example.com', savedAt: '2026-01-01' } as any;
const msg = {
  message_type: 1,
  from_user_id: 'u1',
  context_token: 'ctx',
  item_list: [{ type: 1, text_item: { text: 'hi' } }],
} as any;

function deps(handleMs: number) {
  return {
    account,
    router: { handle: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, handleMs))) } as any,
    delivery: { name: 'sdk', closeSession: vi.fn(), createSession: vi.fn() } as any,
    backend: { name: 'codex' } as any,
    gateway: { tryHandle: vi.fn().mockResolvedValue(false) } as any,
    cwd: '/w',
  };
}

const saved = process.env.CC2WECHAT_ACK_MS;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (saved == null) delete process.env.CC2WECHAT_ACK_MS;
  else process.env.CC2WECHAT_ACK_MS = saved;
});

describe('慢任务提示（CC2WECHAT_ACK_MS）', () => {
  it('阈值内答完就不打扰用户', async () => {
    process.env.CC2WECHAT_ACK_MS = '200';
    await processMessage(msg, deps(10));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('超过阈值才回一句"正在处理"，且只回一次', async () => {
    process.env.CC2WECHAT_ACK_MS = '20';
    await processMessage(msg, deps(120));
    const acks = (sendMessage as any).mock.calls.filter((c: any[]) => String(c[2]).includes('正在处理'));
    expect(acks).toHaveLength(1);
  });

  it('设成 0 = 彻底关掉', async () => {
    process.env.CC2WECHAT_ACK_MS = '0';
    await processMessage(msg, deps(120));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
