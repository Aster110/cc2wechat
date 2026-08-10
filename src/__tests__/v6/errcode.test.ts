import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { WeChatApiError, assertNoBodyError } from '../../v6/wechat/errcode.js';
import { apiFetch } from '../../v5/shared/wechat-api-core.js';
import { sendMessage, sendTyping, uploadAndSendMedia, downloadMedia } from '../../v5/sender/wechat-api-sender.js';
import { getConfig, getUpdates } from '../../v5/receiver/wechat-receiver.js';

describe('assertNoBodyError', () => {
  it('errcode/ret 为 0 或缺失都放行', () => {
    expect(() => assertNoBodyError('x', '{}')).not.toThrow();
    expect(() => assertNoBodyError('x', '{"errcode":0}')).not.toThrow();
    expect(() => assertNoBodyError('x', '{"ret":0}')).not.toThrow();
    expect(() => assertNoBodyError('x', '{"ret":0,"errcode":0,"typing_ticket":"tk"}')).not.toThrow();
  });

  it('非 0 的 errcode / ret 都抛 WeChatApiError,带 code/errmsg/label', () => {
    try {
      assertNoBodyError('sendMessage', '{"errcode":40001,"errmsg":"invalid credential"}');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WeChatApiError);
      const e = err as WeChatApiError;
      expect(e.code).toBe(40001);
      expect(e.errmsg).toBe('invalid credential');
      expect(e.label).toBe('sendMessage');
      expect(e.message).toContain('40001');
    }
  });

  it('ret 与 errcode 同时存在时哪个非 0 报哪个', () => {
    expect(() => assertNoBodyError('x', '{"ret":-14,"errcode":0}')).toThrow(WeChatApiError);
    expect(() => assertNoBodyError('x', '{"ret":0,"errcode":-1}')).toThrow(WeChatApiError);
  });

  it('body 不是 JSON 就放过(有些接口返回空串/纯文本)', () => {
    expect(() => assertNoBodyError('x', '')).not.toThrow();
    expect(() => assertNoBodyError('x', 'OK')).not.toThrow();
    expect(() => assertNoBodyError('x', '[1,2,3]')).not.toThrow();
  });
});

describe('apiFetch failOnBodyError', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('不带这个开关时维持旧行为:HTTP 200 就算成功', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"errcode":40001,"errmsg":"bad"}' });
    await expect(
      apiFetch({ endpoint: 'x', body: '{}', timeoutMs: 100, label: 'legacy' }),
    ).resolves.toContain('40001');
  });

  it('带上开关后应用层错误码会抛', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"errcode":40001,"errmsg":"bad"}' });
    await expect(
      apiFetch({ endpoint: 'x', body: '{}', timeoutMs: 100, label: 'strict', failOnBodyError: true }),
    ).rejects.toBeInstanceOf(WeChatApiError);
  });
});

describe('发送路径:HTTP 200 + errcode 非 0 必须报错(修复"发送失败装成功")', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sendMessage', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"errcode":-14,"errmsg":"session expired"}' });
    await expect(sendMessage('tok', 'u', 'hi', 'ctx', 'https://e.com')).rejects.toBeInstanceOf(WeChatApiError);
  });

  it('sendTyping', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"ret":1,"errmsg":"bad ticket"}' });
    await expect(sendTyping('tok', 'u', 'tk', 1, 'https://e.com')).rejects.toBeInstanceOf(WeChatApiError);
  });

  it('getConfig', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"ret":10001,"errmsg":"nope"}' });
    await expect(getConfig('tok', 'u', 'ctx', 'https://e.com')).rejects.toBeInstanceOf(WeChatApiError);
  });

  it('uploadAndSendMedia 的 getuploadurl 一步就拦住', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'v6-errcode-'));
    const filePath = path.join(tmpDir, 'pic.jpg');
    await fsp.writeFile(filePath, Buffer.from('bytes'));
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"errcode":45009,"errmsg":"quota"}' });

    await expect(
      uploadAndSendMedia({ token: 'tok', toUser: 'u', contextToken: 'ctx', filePath, baseUrl: 'https://e.com' }),
    ).rejects.toBeInstanceOf(WeChatApiError);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('uploadAndSendMedia 的最后一步 sendmessage 也拦', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'v6-errcode-'));
    const filePath = path.join(tmpDir, 'pic.jpg');
    await fsp.writeFile(filePath, Buffer.from('bytes'));

    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('getuploadurl')) {
        return { ok: true, text: async () => JSON.stringify({ upload_param: 'up', filekey: 'k' }) };
      }
      if (u.includes('/upload?')) {
        return { ok: true, text: async () => '', headers: { get: () => 'dl-param' } };
      }
      return { ok: true, text: async () => '{"errcode":40003,"errmsg":"invalid user"}' };
    });

    await expect(
      uploadAndSendMedia({
        token: 'tok', toUser: 'u', contextToken: 'ctx', filePath,
        baseUrl: 'https://e.com', cdnBaseUrl: 'https://cdn.e.com',
      }),
    ).rejects.toBeInstanceOf(WeChatApiError);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('正常 body 照常放行(不误伤)', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"errcode":0}' });
    await expect(sendMessage('tok', 'u', 'hi', 'ctx', 'https://e.com')).resolves.toBeUndefined();
  });
});

describe('getUpdates 绝对不能带 failOnBodyError', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // poller 自己处理 -14(暂停 5 分钟)和连续失败退避,把错误码变成异常会毁掉这套语义
  it('errcode -14 依然作为正常返回值交给 poller 判断', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"errcode":-14,"errmsg":"expired"}' });
    const resp = await getUpdates('tok', '', 'https://e.com', 100);
    expect(resp.errcode).toBe(-14);
  });

  it('任意非 0 ret 也不抛', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"ret":99,"errmsg":"whatever"}' });
    await expect(getUpdates('tok', '', 'https://e.com', 100)).resolves.toMatchObject({ ret: 99 });
  });
});

describe('downloadMedia 走 CDN 不走 apiFetch,错误靠 HTTP 状态', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('CDN 返回非 2xx 时抛错', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(
      downloadMedia({ token: 't', encryptQueryParam: 'q', aesKey: 'k', outputFileName: 'o.bin', cdnBaseUrl: 'https://cdn.e.com' }),
    ).rejects.toThrow(/403/);
  });
});
