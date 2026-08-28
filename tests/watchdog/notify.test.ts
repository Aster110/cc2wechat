import { describe, it, expect, afterEach } from 'vitest';

import { createFeishuNotifier } from '../../src/watchdog/notify.js';
import { collectorMock, startMock, type MockServer } from './harness.js';

const servers: MockServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function hook(respond: { status?: number; json?: unknown } = {}) {
  const received: Array<{ url: string; body: string }> = [];
  const s = await startMock(collectorMock(received, respond));
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}/open-apis/bot/v2/hook/fake`, received };
}

describe('飞书带外通道', () => {
  it('POST 的 payload 就是飞书文本消息格式', async () => {
    const { url, received } = await hook();
    await createFeishuNotifier(url).send('🔴 [mini] codex-18087 异常');

    expect(received).toHaveLength(1);
    expect(received[0].url).toContain('/open-apis/bot/v2/hook/');
    expect(JSON.parse(received[0].body)).toEqual({
      msg_type: 'text',
      content: { text: '🔴 [mini] codex-18087 异常' },
    });
  });

  it('HTTP 非 2xx → 抛（由调用方记日志重试）', async () => {
    const { url } = await hook({ status: 500 });
    await expect(createFeishuNotifier(url).send('x')).rejects.toThrow(/500/);
  });

  it('HTTP 200 但 code!=0 也算失败（webhook 写错就是这样）', async () => {
    const { url } = await hook({ json: { code: 19021, msg: 'sign match fail' } });
    await expect(createFeishuNotifier(url).send('x')).rejects.toThrow(/19021/);
  });

  it('webhook 根本连不上 → 抛而不是挂死', async () => {
    const n = createFeishuNotifier('http://127.0.0.1:1/hook', { timeoutMs: 500 });
    await expect(n.send('x')).rejects.toBeTruthy();
  });
});
