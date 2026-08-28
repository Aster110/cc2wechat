import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../../wechat-api.js', () => ({
  getUpdates: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue({}),
  uploadAndSendMedia: vi.fn().mockResolvedValue(undefined),
  downloadMedia: vi.fn(),
}));

vi.mock('../../../v5/receiver/media.js', () => ({
  downloadMediaItems: vi.fn().mockResolvedValue(new Map()),
}));

import { WeChatChannel } from '../../../v6/channels/wechat-channel.js';
import { isTurnAware, type ChannelMessage } from '../../../v6/channels/contracts.js';
import { getUpdates, sendMessage, sendTyping, getConfig, uploadAndSendMedia } from '../../../wechat-api.js';
import { downloadMediaItems } from '../../../v5/receiver/media.js';
import { MessageItemType } from '../../../types.js';

/**
 * 微信通道 —— 疤组织验收。
 *
 * 这里每一条都是真实事故换来的:-14 暂停、连败分级退避、日志四件套、
 * 「循环不 await 派发」(await 会让微信端显示"暂时无法连接")、
 * typing ticket 必须 getConfig 拿。搬家可以,丢一条都不行。
 */

const account = {
  accountId: 'acc-1',
  token: 'tok',
  baseUrl: 'https://example.com',
  savedAt: '2026-01-01',
  port: 19001,
} as any;

let home: string;
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

let msgIdCounter = 1000;
function textMsg(text: string, userId = 'user-1', id?: number): any {
  return {
    message_type: 1,
    message_id: id ?? ++msgIdCounter,
    from_user_id: userId,
    context_token: 'ctx-1',
    create_time_ms: 1700000000000,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

interface Harness {
  channel: WeChatChannel;
  delivered: ChannelMessage[];
  start(over?: { isDuplicate?(id: string): boolean }): Promise<void>;
  saveSyncBuf: ReturnType<typeof vi.fn>;
}

function harness(opts: Record<string, unknown> = {}): Harness {
  const saveSyncBuf = vi.fn();
  const channel = new WeChatChannel({
    account,
    home,
    loadSyncBuf: () => 'buf-1',
    saveSyncBuf,
    ...opts,
  } as any);
  const delivered: ChannelMessage[] = [];
  return {
    channel,
    delivered,
    saveSyncBuf,
    start: (over = {}) => channel.start({ deliver: (m) => delivered.push(m), ...over }),
  };
}

/** getUpdates 依次返回这些;用完之后一直挂着(模拟长轮询没消息) */
function scriptUpdates(...responses: any[]): void {
  let i = 0;
  (getUpdates as any).mockImplementation(async () => {
    if (i < responses.length) {
      const r = responses[i++];
      return typeof r === 'function' ? r() : r;
    }
    return new Promise(() => {});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (downloadMediaItems as any).mockResolvedValue(new Map());
  (getConfig as any).mockResolvedValue({});
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-channel-'));
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
  errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errs.push(String(m)));
  delete process.env.CC2WECHAT_ACK_MS;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  fs.rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('WeChatChannel — 契约形状', () => {
  it('name / descriptor / 五个方法齐全,且实现了 turn 生命周期', () => {
    const { channel } = harness();
    expect(channel.name).toBe('wechat');
    expect(channel.descriptor.sourceLabel).toBe('[微信]');
    expect(isTurnAware(channel)).toBe(true);
  });

  it('start() 立刻 resolve —— 收信循环在后台跑,不能把 bootstrap 挂住', async () => {
    scriptUpdates();
    const h = harness();
    await expect(Promise.race([h.start(), new Promise((r) => setTimeout(() => r('timeout'), 200))])).resolves.not.toBe(
      'timeout',
    );
    await h.channel.stop();
  });
});

describe('WeChatChannel — 入站标准化', () => {
  it('一条文本消息变成 ChannelMessage(不含 conversationId)', async () => {
    scriptUpdates({ ret: 0, msgs: [textMsg('hi', 'user-1', 5001)], get_updates_buf: 'buf-2' });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

    const m = h.delivered[0]!;
    expect(m.channel).toBe('wechat');
    expect(m.endpointId).toBe('user-1');
    expect(m.text).toBe('hi');
    expect(m.id).toBe('id:5001');
    expect(m.mediaPaths).toEqual([]);
    expect(typeof m.receivedAt).toBe('number');
    expect('conversationId' in m).toBe(false);
    await h.channel.stop();
  });

  it('没有 message_id 时用 用户+时间+内容hash 兜底(沿用现网 dedupeKey 语义)', async () => {
    const base = { ...textMsg('hi'), message_id: undefined };
    scriptUpdates({ ret: 0, msgs: [base, { ...base, item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'other' } }] }] });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.delivered).toHaveLength(2));

    expect(h.delivered[0]!.id).toMatch(/^fb:user-1\|1700000000000\|[0-9a-f]{16}$/);
    // 内容不同 = 不同 id
    expect(h.delivered[0]!.id).not.toBe(h.delivered[1]!.id);
    await h.channel.stop();
  });

  it('非用户消息(message_type !== 1)直接忽略,也不下载媒体', async () => {
    scriptUpdates({ ret: 0, msgs: [{ ...textMsg('x'), message_type: 2 }] });
    const h = harness();
    await h.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.delivered).toHaveLength(0);
    expect(downloadMediaItems).not.toHaveBeenCalled();
    await h.channel.stop();
  });

  it('媒体下载后路径进 mediaPaths,文本里带上本地路径', async () => {
    (downloadMediaItems as any).mockResolvedValue(new Map([[0, '/tmp/pic-0.jpg']]));
    scriptUpdates({
      ret: 0,
      msgs: [
        {
          message_type: 1,
          message_id: 7001,
          from_user_id: 'user-1',
          context_token: 'ctx-1',
          item_list: [{ type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'q', aes_key: 'k' } } }],
        },
      ],
    });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

    expect(h.delivered[0]!.mediaPaths).toEqual(['/tmp/pic-0.jpg']);
    expect(h.delivered[0]!.text).toContain('/tmp/pic-0.jpg');
    await h.channel.stop();
  });

  it('ctx.isDuplicate 命中时连媒体都不下载(重传风暴不该变成下载风暴)', async () => {
    scriptUpdates({ ret: 0, msgs: [textMsg('hi', 'user-1', 5002)] });
    const h = harness();
    await h.start({ isDuplicate: (id) => id === 'id:5002' });
    await new Promise((r) => setTimeout(r, 30));

    expect(downloadMediaItems).not.toHaveBeenCalled();
    expect(h.delivered).toHaveLength(0);
    await h.channel.stop();
  });

  it('写 ctx 路由文件给 reply-cli,且里面绝不含 token / baseUrl', async () => {
    scriptUpdates({ ret: 0, msgs: [textMsg('hi', 'user-1', 5003)] });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

    const dir = path.join(home, '.cc2wechat', 'ctx');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf-8');
    expect(raw).not.toContain('tok');
    expect(raw).not.toContain('example.com');
    expect(JSON.parse(raw)).toEqual({ userId: 'user-1', contextToken: 'ctx-1', port: 19001, accountId: 'acc-1' });
    await h.channel.stop();
  });

  it('账号记录里没写 port 时退回本进程端口(不然 reply-cli 查不到 token)', async () => {
    process.env.CC2WECHAT_PORT = '19007';
    try {
      scriptUpdates({ ret: 0, msgs: [textMsg('hi', 'user-1', 5004)] });
      const h = harness({ account: { ...account, port: undefined } });
      await h.start();
      await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

      const dir = path.join(home, '.cc2wechat', 'ctx');
      const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf-8');
      expect(JSON.parse(raw).port).toBe(19007);
      await h.channel.stop();
    } finally {
      delete process.env.CC2WECHAT_PORT;
    }
  });

  it('syncBuf:起手用 loadSyncBuf,服务端给新 buf 就存并带进下一次请求', async () => {
    scriptUpdates(
      { ret: 0, msgs: [], get_updates_buf: 'buf-2' },
      { ret: 0, msgs: [], get_updates_buf: 'buf-3' },
    );
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.saveSyncBuf).toHaveBeenCalledTimes(2));

    expect((getUpdates as any).mock.calls[0][1]).toBe('buf-1');
    expect((getUpdates as any).mock.calls[1][1]).toBe('buf-2');
    expect(h.saveSyncBuf).toHaveBeenNthCalledWith(1, 'acc-1', 'buf-2');
    await h.channel.stop();
  });

  it('longpolling_timeout_ms 跟随服务端', async () => {
    scriptUpdates({ ret: 0, msgs: [], longpolling_timeout_ms: 40_000 }, { ret: 0, msgs: [] });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect((getUpdates as any).mock.calls.length).toBeGreaterThanOrEqual(2));

    expect((getUpdates as any).mock.calls[0][3]).toBe(35_000);
    expect((getUpdates as any).mock.calls[1][3]).toBe(40_000);
    await h.channel.stop();
  });
});

describe('WeChatChannel — 错误路径 parity(疤组织)', () => {
  it('errcode=-14 会话过期:暂停 5 分钟,且不计入连败', async () => {
    vi.useFakeTimers();
    const h = harness({ retryDelayMs: 2000 });
    scriptUpdates(
      { ret: 0, errcode: -14, errmsg: 'session expired' },
      { ret: 0, errcode: -14 },
      { ret: 500, errmsg: 'boom' },
    );
    await h.start();

    await vi.advanceTimersByTimeAsync(1);
    expect(logs.some((l) => l.includes('Session expired') && l.includes('5 min'))).toBe(true);
    // 5 分钟没到,不会打第二次
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect((getUpdates as any).mock.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000 + 5);
    expect((getUpdates as any).mock.calls.length).toBe(2);

    // 连败计数没被 -14 污染:后面第一次真错误应该是 (1/3)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5);
    expect(errs.some((l) => l.includes('(1/3)'))).toBe(true);
    await h.channel.stop();
  });

  it('ret=-14 与 errcode=-14 同等对待', async () => {
    vi.useFakeTimers();
    const h = harness();
    scriptUpdates({ ret: -14, errmsg: 'session expired' });
    await h.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(logs.some((l) => l.includes('Session expired'))).toBe(true);
    await h.channel.stop();
  });

  it('API 错误:前两次 2s 重试,第三次 30s 退避,日志带 ret/errcode/errmsg 与 (n/3)', async () => {
    vi.useFakeTimers();
    const h = harness({ retryDelayMs: 2000 });
    (getUpdates as any).mockResolvedValue({ ret: 500, errcode: 7, errmsg: 'server oops' });
    await h.start();

    await vi.advanceTimersByTimeAsync(1);
    expect((getUpdates as any).mock.calls.length).toBe(1);
    expect(errs.some((l) => l.includes('getUpdates error: ret=500 errcode=7 errmsg=server oops (1/3)'))).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect((getUpdates as any).mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((getUpdates as any).mock.calls.length).toBe(3);
    expect(errs.some((l) => l.includes('(3/3)'))).toBe(true);

    // 第三次之后是 30s,2s 时还不该动
    await vi.advanceTimersByTimeAsync(2_000);
    expect((getUpdates as any).mock.calls.length).toBe(3);
    await vi.advanceTimersByTimeAsync(28_000);
    expect((getUpdates as any).mock.calls.length).toBe(4);
    // 退避后计数归零,重新从 (1/3) 数起
    expect(errs.filter((l) => l.includes('(1/3)')).length).toBe(2);
    await h.channel.stop();
  });

  it('一次成功就把连败清零', async () => {
    vi.useFakeTimers();
    const h = harness({ retryDelayMs: 2000 });
    scriptUpdates({ ret: 500, errmsg: 'x' }, { ret: 0, msgs: [] }, { ret: 500, errmsg: 'x' });
    await h.start();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(errs.filter((l) => l.includes('(1/3)')).length).toBe(2);
    expect(errs.some((l) => l.includes('(2/3)'))).toBe(false);
    await h.channel.stop();
  });

  it('抛异常路径:Poll error (n/3) 带 cause 与 stack 摘要,循环不崩', async () => {
    vi.useFakeTimers();
    const h = harness({ retryDelayMs: 2000 });
    const err = new Error('fetch failed');
    (err as any).cause = new Error('ECONNREFUSED 1.2.3.4:443');
    (getUpdates as any).mockRejectedValue(err);
    await h.start();

    await vi.advanceTimersByTimeAsync(1);
    const line = errs.find((l) => l.includes('Poll error (1/3)'));
    expect(line).toBeDefined();
    expect(line).toContain('fetch failed');
    expect(line).toContain('cause: Error: ECONNREFUSED 1.2.3.4:443');
    expect(line).toContain('at ');

    // 循环还活着
    await vi.advanceTimersByTimeAsync(2_000);
    expect((getUpdates as any).mock.calls.length).toBe(2);
    await h.channel.stop();
  });

  it('派发失败不崩循环,打 dispatch failed', async () => {
    (downloadMediaItems as any).mockRejectedValue(new Error('media boom'));
    scriptUpdates({ ret: 0, msgs: [textMsg('hi', 'user-1', 5101)] }, { ret: 0, msgs: [] });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(errs.some((l) => l.includes('dispatch failed'))).toBe(true));
    expect(errs.some((l) => l.includes('media boom'))).toBe(true);
    await h.channel.stop();
  });

  it('循环**不 await 派发**:媒体下载卡住时长轮询照样往下走', async () => {
    (downloadMediaItems as any).mockImplementation(() => new Promise(() => {})); // 永不 resolve
    let calls = 0;
    (getUpdates as any).mockImplementation(async () => {
      calls++;
      // 三轮之后挂住,模拟"没有新消息"的正常长轮询 —— 否则这个测试自己会把内存跑爆
      if (calls > 3) return new Promise(() => {});
      return { ret: 0, msgs: [textMsg('hi', `user-${calls}`, 5200 + calls)], get_updates_buf: `buf-${calls}` };
    });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    await h.channel.stop();
  });

  it('stop() 在 -14 暂停中也能及时返回(不等满 5 分钟)', async () => {
    (getUpdates as any).mockResolvedValue({ ret: 0, errcode: -14 });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(logs.some((l) => l.includes('Session expired'))).toBe(true));

    const stopped = await Promise.race([
      h.channel.stop().then(() => 'stopped'),
      new Promise((r) => setTimeout(() => r('hung'), 500)),
    ]);
    expect(stopped).toBe('stopped');
  });
});

describe('WeChatChannel — 发送', () => {
  it('send() 走 Replier 语义:长文本分块,逐块 sendMessage', async () => {
    scriptUpdates({ ret: 0, msgs: [textMsg('hi', 'user-1', 5301)] });
    const h = harness({ reply: { maxChunkSize: 10 } });
    await h.start();
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

    await h.channel.send('user-1', { text: '1234567890abcdefghij' });
    expect((sendMessage as any).mock.calls.length).toBe(2);
    expect((sendMessage as any).mock.calls[0][0]).toBe('tok');
    expect((sendMessage as any).mock.calls[0][1]).toBe('user-1');
    expect((sendMessage as any).mock.calls[0][3]).toBe('ctx-1'); // 用最近一条入站消息的 contextToken
    expect((sendMessage as any).mock.calls[0][4]).toBe('https://example.com');
    await h.channel.stop();
  });

  it('send() 带 mediaFiles 时逐个上传', async () => {
    scriptUpdates({ ret: 0, msgs: [textMsg('hi', 'user-1', 5302)] });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

    await h.channel.send('user-1', { text: '给你图', mediaFiles: ['/tmp/a.png', '/tmp/b.png'] });
    expect((uploadAndSendMedia as any).mock.calls.length).toBe(2);
    expect((uploadAndSendMedia as any).mock.calls[0][0]).toMatchObject({
      token: 'tok',
      toUser: 'user-1',
      contextToken: 'ctx-1',
      filePath: '/tmp/a.png',
    });
    await h.channel.stop();
  });

  it('sendMessage 抛错(errcode 检查没丢)会冒出来给 Core,不装成功', async () => {
    (sendMessage as any).mockRejectedValueOnce(new Error('sendMessage failed: errcode=-2 prepare failed'));
    const h = harness();
    await expect(h.channel.send('user-1', { text: 'x' })).rejects.toThrow('errcode=-2');
  });

  it('没收到过入站消息时 contextToken 用空串(不编一个假的)', async () => {
    const h = harness();
    await h.channel.send('user-unknown', { text: 'hi' });
    expect((sendMessage as any).mock.calls[0][3]).toBe('');
  });
});

describe('WeChatChannel — typing 心跳与慢提示(通道级 turn 生命周期)', () => {
  function chanMsg(over: Partial<ChannelMessage> = {}): ChannelMessage {
    return { id: 'id:1', channel: 'wechat', endpointId: 'user-1', text: 'hi', mediaPaths: [], receivedAt: Date.now(), ...over };
  }

  it('ticket 必须从 getConfig 拿;拿到后立刻发一次,15s 续一次,结束发 status 2', async () => {
    vi.useFakeTimers();
    (getConfig as any).mockResolvedValue({ typing_ticket: 'ticket-1' });
    const h = harness();

    const end = h.channel.beginTurn(chanMsg());
    await vi.advanceTimersByTimeAsync(1);
    expect(getConfig).toHaveBeenCalledWith('tok', 'user-1', '', 'https://example.com');
    expect((sendTyping as any).mock.calls.at(-1)).toEqual(['tok', 'user-1', 'ticket-1', 1, 'https://example.com']);

    await vi.advanceTimersByTimeAsync(15_000);
    expect((sendTyping as any).mock.calls.filter((c: any[]) => c[3] === 1).length).toBe(2);

    end();
    expect((sendTyping as any).mock.calls.at(-1)![3]).toBe(2);
    // 结束后心跳停了
    const before = (sendTyping as any).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((sendTyping as any).mock.calls.length).toBe(before);
  });

  it('ticket 拿不到就安静放弃,一条 typing 都不发', async () => {
    vi.useFakeTimers();
    (getConfig as any).mockResolvedValue({});
    const h = harness();
    const end = h.channel.beginTurn(chanMsg());
    await vi.advanceTimersByTimeAsync(30_000);
    end();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it('getConfig 抛错也不影响这一轮', async () => {
    vi.useFakeTimers();
    (getConfig as any).mockRejectedValue(new Error('nope'));
    const h = harness();
    const end = h.channel.beginTurn(chanMsg());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(() => end()).not.toThrow();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it('慢提示:默认 60s 后补一句"收到，正在处理…"', async () => {
    vi.useFakeTimers();
    const h = harness();
    const end = h.channel.beginTurn(chanMsg());
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect((sendMessage as any).mock.calls[0][2]).toBe('收到，正在处理…');
    end();
  });

  it('这轮在 60s 内结束就不发慢提示', async () => {
    vi.useFakeTimers();
    const h = harness();
    const end = h.channel.beginTurn(chanMsg());
    await vi.advanceTimersByTimeAsync(1_000);
    end();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('CC2WECHAT_ACK_MS=0 彻底关掉慢提示', async () => {
    vi.useFakeTimers();
    process.env.CC2WECHAT_ACK_MS = '0';
    try {
      const h = harness();
      const end = h.channel.beginTurn(chanMsg());
      await vi.advanceTimersByTimeAsync(300_000);
      end();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      delete process.env.CC2WECHAT_ACK_MS;
    }
  });

  it('CC2WECHAT_ACK_MS 能改阈值', async () => {
    vi.useFakeTimers();
    process.env.CC2WECHAT_ACK_MS = '5000';
    try {
      const h = harness();
      const end = h.channel.beginTurn(chanMsg());
      await vi.advanceTimersByTimeAsync(5_500);
      expect((sendMessage as any).mock.calls[0][2]).toBe('收到，正在处理…');
      end();
    } finally {
      delete process.env.CC2WECHAT_ACK_MS;
    }
  });

  it('typing 用的是这条消息的 contextToken(入站时记下的)', async () => {
    vi.useFakeTimers();
    (getConfig as any).mockResolvedValue({ typing_ticket: 't' });
    scriptUpdates({ ret: 0, msgs: [{ ...textMsg('hi', 'user-9', 5401), context_token: 'ctx-9' }] });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));

    const end = h.channel.beginTurn(h.delivered[0]!);
    await vi.advanceTimersByTimeAsync(1);
    expect(getConfig).toHaveBeenCalledWith('tok', 'user-9', 'ctx-9', 'https://example.com');
    end();
    await h.channel.stop();
  });
});

describe('WeChatChannel — health()', () => {
  it('同步返回;跑通一次长轮询后 ok=true 且有 lastOkAt', async () => {
    scriptUpdates({ ret: 0, msgs: [] });
    const h = harness();
    expect(h.channel.health().ok).toBe(false); // 还没 start
    await h.start();
    await vi.waitFor(() => expect(h.channel.health().ok).toBe(true));
    expect(h.channel.health().lastOkAt).toBeGreaterThan(0);
    await h.channel.stop();
  });

  it('连败到阈值时 ok=false,detail 说人话', async () => {
    vi.useFakeTimers();
    (getUpdates as any).mockResolvedValue({ ret: 500, errmsg: 'oops' });
    const h = harness({ retryDelayMs: 10 });
    await h.start();
    await vi.advanceTimersByTimeAsync(100);
    const health = h.channel.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('连续失败');
    await h.channel.stop();
  });

  it('-14 暂停期间 detail 点名会话过期', async () => {
    vi.useFakeTimers();
    (getUpdates as any).mockResolvedValue({ ret: 0, errcode: -14 });
    const h = harness();
    await h.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.channel.health().detail).toContain('会话过期');
    await h.channel.stop();
  });

  it('stop() 之后 ok=false', async () => {
    scriptUpdates({ ret: 0, msgs: [] });
    const h = harness();
    await h.start();
    await vi.waitFor(() => expect(h.channel.health().ok).toBe(true));
    await h.channel.stop();
    expect(h.channel.health().ok).toBe(false);
    expect(h.channel.health().detail).toContain('已停止');
  });
});
