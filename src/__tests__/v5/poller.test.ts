import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../wechat-api.js', () => ({
  getUpdates: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue({}),
  uploadAndSendMedia: vi.fn(),
  downloadMedia: vi.fn(),
}));

vi.mock('../../store.js', () => ({
  loadSyncBuf: vi.fn().mockReturnValue(''),
  saveSyncBuf: vi.fn(),
}));

vi.mock('../../utils.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  extractText: (msg: any) => msg?.item_list?.[0]?.text_item?.text ?? '',
  userIdToSessionUUID: (u: string) => `uuid-${u}`,
}));

vi.mock('../../v5/receiver/media.js', () => ({
  downloadMediaItems: vi.fn().mockResolvedValue(new Map()),
}));

import { processMessage } from '../../v5/core/poller.js';
import { sendTyping, getConfig } from '../../wechat-api.js';
import { downloadMediaItems } from '../../v5/receiver/media.js';
// NOTE: pollLoop itself is a while(true) loop — we test processMessage, the
// extracted per-message handler. Integration coverage for the full loop lives
// under a follow-up smoke test (TODO: add tests/integration/poller.smoke.ts
// that stubs getUpdates with a queue of canned responses, including:
//   - normal message batch
//   - API error + backoff after MAX_CONSECUTIVE_FAILURES
//   - errcode -14 session expired => SESSION_PAUSE_MS sleep
//   - command gateway hit => router.handle NOT called).
import { MessageItemType } from '../../types.js';

const account = {
  accountId: 'acc-1',
  token: 'tok',
  baseUrl: 'https://example.com',
  savedAt: '2026-01-01',
  port: 18081,
} as any;

let msgIdCounter = 1000;
function makeTextMsg(text: string, userId = 'user-1') {
  return {
    message_type: 1,
    message_id: ++msgIdCounter,
    from_user_id: userId,
    context_token: 'ctx-1',
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

function makeImageMsg(userId = 'user-1') {
  return {
    message_type: 1,
    message_id: ++msgIdCounter,
    from_user_id: userId,
    context_token: 'ctx-1',
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } },
      },
    ],
  };
}

describe('processMessage', () => {
  let router: { handle: ReturnType<typeof vi.fn> };
  let delivery: any;
  let backend: any;
  let gateway: { tryHandle: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    router = { handle: vi.fn().mockResolvedValue(undefined) };
    delivery = {
      name: 'tmux',
      closeSession: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(undefined),
    };
    backend = { name: 'claude-code' };
    gateway = { tryHandle: vi.fn().mockResolvedValue(false) };
  });

  it('routes normal user message through router.handle', async () => {
    await processMessage(makeTextMsg('hi'), {
      account,
      router: router as any,
      delivery,
      backend,
      gateway: gateway as any,
      cwd: '/work',
      accountName: 'main',
    });
    expect(router.handle).toHaveBeenCalledTimes(1);
    const ctx = router.handle.mock.calls[0][0];
    expect(ctx.text).toBe('hi');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.contextToken).toBe('ctx-1');
    expect(ctx.cwd).toBe('/work');
    expect(ctx.accountName).toBe('main');
  });

  // typing 必须带 getConfig 拿来的真 ticket——空 ticket 发过去是静默无效，
  // 早期版本就是这么"发了一整年却从没显示过"的。没 ticket 时宁可不发。
  it('does not send typing when getConfig returns no ticket', async () => {
    (getConfig as any).mockResolvedValue({});
    await processMessage(makeTextMsg('hi'), {
      account, router: router as any, delivery, backend,
      gateway: gateway as any, cwd: '/work',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it('sends typing with the real ticket while the turn is running', async () => {
    (getConfig as any).mockResolvedValue({ typing_ticket: 'tk-1' });
    router.handle = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 30)));

    await processMessage(makeTextMsg('hi'), {
      account, router: router as any, delivery, backend,
      gateway: gateway as any, cwd: '/work',
    });

    // 开始时 status=1，结束时 status=2
    expect(sendTyping).toHaveBeenCalledWith('tok', 'user-1', 'tk-1', 1, 'https://example.com');
    expect(sendTyping).toHaveBeenCalledWith('tok', 'user-1', 'tk-1', 2, 'https://example.com');
  });

  it('downloads media and injects mediaPaths into ctx for IMAGE message', async () => {
    const paths = new Map<number, string>([[0, '/tmp/abc-0.jpg']]);
    (downloadMediaItems as any).mockResolvedValueOnce(paths);
    await processMessage(makeImageMsg(), {
      account,
      router: router as any,
      delivery,
      backend,
      gateway: gateway as any,
      cwd: '/work',
      accountName: 'main',
    });
    expect(downloadMediaItems).toHaveBeenCalledTimes(1);
    expect(router.handle).toHaveBeenCalledTimes(1);
    const ctx = router.handle.mock.calls[0][0];
    expect(ctx.mediaPaths).toBe(paths);
  });

  it('skips when command gateway handles the message', async () => {
    gateway.tryHandle.mockResolvedValue(true);
    await processMessage(makeTextMsg('/help'), {
      account,
      router: router as any,
      delivery,
      backend,
      gateway: gateway as any,
      cwd: '/work',
    });
    expect(gateway.tryHandle).toHaveBeenCalledTimes(1);
    expect(router.handle).not.toHaveBeenCalled();
  });

  it('ignores non-user messages (message_type !== 1)', async () => {
    const msg = { ...makeTextMsg('x'), message_type: 2 };
    await processMessage(msg, {
      account,
      router: router as any,
      delivery,
      backend,
      gateway: gateway as any,
      cwd: '/work',
    });
    expect(router.handle).not.toHaveBeenCalled();
    expect(gateway.tryHandle).not.toHaveBeenCalled();
  });
});
