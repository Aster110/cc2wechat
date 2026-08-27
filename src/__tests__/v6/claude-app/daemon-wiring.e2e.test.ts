import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';

import { setupE2e, type E2eEnv } from '../e2e/harness.js';

/**
 * 接线 e2e:真的把 `dist/v6/main.js` 用 `CC2WECHAT_BACKEND=claude-app` 起起来,
 * 验证 main.ts 那段 isHttpAttachable 接线确实把网关总线挂上了。
 *
 * 单测里 attachHttp 是拿假 server 打的,只有这里能证明"daemon 起来之后
 * curl 那个 SSE 真的连得上" —— 而这正是网关值班的第一步。
 *
 * **跑之前先 npm run build**(harness spawn 的是 dist,不是 src)。
 */

let env: E2eEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('daemon 接线 —— CC2WECHAT_BACKEND=claude-app', () => {
  it('/health 报 claude-app,且如实说不健康(还没播种收件箱)', async () => {
    env = await setupE2e({ backend: 'claude-app' });
    const d = await env.startDaemon();
    const h = await d.health();
    expect(h.agent).toBe('claude-app');
    expect(h.persistent).toBe(true);
    expect(h.agentHealth.ok).toBe(false);
    expect(String(h.agentHealth.detail)).toContain('seed');
  }, 60_000);

  it('网关端点在同一个端口上活着(curl -N 连得上)', async () => {
    env = await setupE2e({ backend: 'claude-app' });
    const d = await env.startDaemon();

    const st = await get(d.port, '/claude-app/status');
    expect(st.status).toBe(200);
    expect(JSON.parse(st.body)).toMatchObject({ connected: false, testSend: true });

    // SSE:连上应该立刻收到 hello
    const hello = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: d.port, path: '/claude-app/events', method: 'GET' },
        (res) => {
          res.setEncoding('utf-8');
          res.once('data', (chunk: string) => {
            req.destroy();
            resolve(chunk);
          });
        },
      );
      req.on('error', reject);
      req.end();
      setTimeout(() => reject(new Error('SSE 5s 内没有 hello')), 5_000);
    });
    expect(hello).toContain('"type":"hello"');

    await new Promise((r) => setTimeout(r, 100));
    const st2 = await get(d.port, '/claude-app/status');
    expect(JSON.parse(st2.body).connections).toBe(0); // 断开后连接数归零
  }, 60_000);

  it('codex 后端下不该冒出 claude-app 端点(接线只对认领它的后端生效)', async () => {
    env = await setupE2e({ backend: 'codex' });
    const d = await env.startDaemon();
    expect((await get(d.port, '/claude-app/status')).status).toBe(404);
  }, 60_000);
});
