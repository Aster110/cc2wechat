import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { WeChatApiError, CdnError, assertNoBodyError, assertNoCdnError } from '../../v6/wechat/errcode.js';
import { apiFetch, extractMessageId } from '../../v5/shared/wechat-api-core.js';
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

  // 2026-08-27 f13-47:-2 "prepare failed" 曾被当成"图片发送坏了"查了一整轮,
  // 真相是微信侧对话不收 bot 推送了,纯文字一样发不出去。错误里必须直接写出下一步动作。
  it('prepare failed 带对话唤醒提示,并明说文字/图片同挡', () => {
    try {
      assertNoBodyError('sendMediaMessage', '{"ret":-2,"errmsg":"prepare failed"}');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WeChatApiError);
      const e = err as WeChatApiError;
      expect(e.code).toBe(-2);
      expect(e.hint).toBeTruthy();
      expect(e.message).toContain('对话');
      expect(e.message).toContain('发一条消息');
      expect(e.message).toContain('文字');
      // 把已证伪的岔路写进错误里，省得下一个人再去查 token
      expect(e.message).toContain('context_token');
    }
  });

  it('同样是 -2,别的 errmsg 不套对话提示(别乱指路)', () => {
    try {
      assertNoBodyError('getConfig', '{"ret":-2,"errmsg":"ilink_user_id required"}');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as WeChatApiError;
      expect(e.code).toBe(-2);
      expect(e.hint).toBeUndefined();
      expect(e.message).not.toContain('对话');
    }
  });
});

// CDN(novac2c)不回 body,错误全在响应头里 —— 只报 "500" 等于什么都没说。
describe('assertNoCdnError:CDN 的错在响应头 x-error-code / x-error-message', () => {
  const resp = (init: { status: number; ok: boolean; code?: string; msg?: string }) => ({
    ok: init.ok,
    status: init.status,
    headers: {
      get: (h: string) => {
        const k = h.toLowerCase();
        if (k === 'x-error-code') return init.code ?? null;
        if (k === 'x-error-message') return init.msg ?? null;
        return null;
      },
    },
  });

  it('非 2xx 时把 x-error-code / x-error-message 抬进错误消息', () => {
    try {
      assertNoCdnError('CDN upload', resp({
        ok: false, status: 500, code: '-5102008',
        msg: 'filekey mismatch between request and decrypted params [host=11.142.77.214]',
      }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CdnError);
      const e = err as CdnError;
      expect(e.status).toBe(500);
      expect(e.errorCode).toBe('-5102008');
      expect(e.message).toContain('-5102008');
      expect(e.message).toContain('filekey mismatch');
    }
  });

  it('HTTP 200 但头里带非 0 错误码,照样算失败', () => {
    expect(() => assertNoCdnError('CDN upload', resp({
      ok: true, status: 200, code: '-5102001', msg: 'missing required parameter',
    }))).toThrow(CdnError);
  });

  it('200 + 无错误头 = 放行;错误码是 0 也放行', () => {
    expect(() => assertNoCdnError('CDN upload', resp({ ok: true, status: 200 }))).not.toThrow();
    expect(() => assertNoCdnError('CDN upload', resp({ ok: true, status: 200, code: '0' }))).not.toThrow();
  });

  it('响应体有内容就一起带上(CDN 偶尔回文本)', () => {
    expect(() => assertNoCdnError('CDN download', resp({ ok: false, status: 404 }), 'not found'))
      .toThrow(/not found/);
  });

  it('测试替身没给 headers 也不能自己先崩(老用例兼容)', () => {
    expect(() => assertNoCdnError('CDN download', { ok: false, status: 403 } as never, 'forbidden'))
      .toThrow(/403/);
  });
});

// message_id 是 int64(7498796439671022216 > Number.MAX_SAFE_INTEGER),
// JSON.parse 会把尾数抹平 —— 只能从原始文本抠。
describe('extractMessageId:int64 不能过 JSON.parse', () => {
  it('从原始响应文本里原样取出大整数', () => {
    expect(extractMessageId('{"message_id":7498796439671022216}')).toBe('7498796439671022216');
  });

  it('字符串形式也认', () => {
    expect(extractMessageId('{"message_id":"7498796439671022216"}')).toBe('7498796439671022216');
  });

  it('没有就返回 undefined', () => {
    expect(extractMessageId('{"ret":0}')).toBeUndefined();
    expect(extractMessageId('')).toBeUndefined();
  });

  it('JSON.parse 会失真,这就是不用它的原因', () => {
    expect(String(JSON.parse('{"message_id":7498796439671022216}').message_id))
      .not.toBe('7498796439671022216');
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
        // 头要按名字回答:一律回同一个值会被当成 x-error-code,CDN 那关就先炸了
        return {
          ok: true,
          status: 200,
          text: async () => '',
          headers: { get: (h: string) => (h.toLowerCase() === 'x-encrypted-param' ? 'dl-param' : null) },
        };
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
    await expect(sendMessage('tok', 'u', 'hi', 'ctx', 'https://e.com')).resolves.toEqual({ messageId: undefined });
  });

  it('发成功时把 message_id 交回调用方(唯一能证明"真发了"的凭据)', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"message_id":7498796439671022216}' });
    await expect(sendMessage('tok', 'u', 'hi', 'ctx', 'https://e.com'))
      .resolves.toEqual({ messageId: '7498796439671022216' });
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

  it('CDN 的原因写在响应头里,必须原样抬出来', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '',
      headers: {
        get: (h: string) => {
          const k = h.toLowerCase();
          if (k === 'x-error-code') return '-5102008';
          if (k === 'x-error-message') return 'invalid encrypted_param: data too short or base64 decode failed';
          return null;
        },
      },
    });
    await expect(
      downloadMedia({ token: 't', encryptQueryParam: 'q', aesKey: 'k', outputFileName: 'o.bin', cdnBaseUrl: 'https://cdn.e.com' }),
    ).rejects.toThrow(/-5102008.*data too short/s);
  });
});

// 星尘桥当时只看到 "CDN upload failed: 500",body 是空的,等于没有线索。
describe('uploadAndSendMedia:CDN 上传失败要说得清', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'v6-cdn-'));
    filePath = path.join(tmpDir, 'pic.jpg');
    await fsp.writeFile(filePath, Buffer.from('some-image-bytes'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const cdnHeaders = (code: string | null, msg: string | null) => ({
    get: (h: string) => {
      const k = h.toLowerCase();
      if (k === 'x-error-code') return code;
      if (k === 'x-error-message') return msg;
      if (k === 'x-encrypted-param') return 'dl-param';
      return null;
    },
  });

  const run = () => uploadAndSendMedia({
    token: 'tok', toUser: 'u', contextToken: 'ctx', filePath,
    baseUrl: 'https://e.com', cdnBaseUrl: 'https://cdn.e.com',
  });

  it('500 时带上 x-error-code / x-error-message', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('getuploadurl')) {
        return { ok: true, text: async () => JSON.stringify({ upload_param: 'up' }) };
      }
      return {
        ok: false, status: 500, text: async () => '',
        headers: cdnHeaders('-5102008', 'filekey mismatch between request and decrypted params'),
      };
    });
    await expect(run()).rejects.toThrow(/CDN upload.*500.*-5102008.*filekey mismatch/s);
  });

  it('HTTP 200 但头里有错误码也不许放过', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('getuploadurl')) {
        return { ok: true, text: async () => JSON.stringify({ upload_param: 'up' }) };
      }
      return {
        ok: true, status: 200, text: async () => '',
        headers: cdnHeaders('-5102001', 'missing required parameter: encrypted_param'),
      };
    });
    await expect(run()).rejects.toThrow(/-5102001/);
  });

  it('一路顺利时回传 message_id', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('getuploadurl')) {
        return { ok: true, text: async () => JSON.stringify({ upload_param: 'up' }) };
      }
      if (u.includes('/upload?')) {
        return { ok: true, status: 200, text: async () => '', headers: cdnHeaders(null, null) };
      }
      return { ok: true, text: async () => '{"message_id":7498796439671022216}' };
    });
    await expect(run()).resolves.toEqual({ messageId: '7498796439671022216' });
  });

  it('CDN 没给 x-encrypted-param 时报错要提到这个头', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('getuploadurl')) {
        return { ok: true, text: async () => JSON.stringify({ upload_param: 'up' }) };
      }
      return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    });
    await expect(run()).rejects.toThrow(/x-encrypted-param/);
  });
});
