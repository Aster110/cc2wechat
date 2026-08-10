import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { selectEngine, startEngine, ENGINE_ENTRY } from '../../v6/engine-select.js';

describe('selectEngine — 环境变量矩阵', () => {
  it('两台生产机的现状(DELIVERY=sdk)走 v6', () => {
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'sdk' } as NodeJS.ProcessEnv)).toBe('v6');
  });

  it('tmux / terminal 投递继续走 v5(Web 终端场景只有 v5 有)', () => {
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'tmux' } as NodeJS.ProcessEnv)).toBe('v5');
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'terminal' } as NodeJS.ProcessEnv)).toBe('v5');
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'TMUX' } as NodeJS.ProcessEnv)).toBe('v5');
  });

  it('pipe / auto / 没设都走 v6', () => {
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'pipe' } as NodeJS.ProcessEnv)).toBe('v6');
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'auto' } as NodeJS.ProcessEnv)).toBe('v6');
    expect(selectEngine({} as NodeJS.ProcessEnv)).toBe('v6');
  });

  it('env 没设时看 config.delivery', () => {
    expect(selectEngine({} as NodeJS.ProcessEnv, { delivery: 'tmux' })).toBe('v5');
    expect(selectEngine({} as NodeJS.ProcessEnv, { delivery: 'sdk' })).toBe('v6');
  });

  it('env 覆盖 config', () => {
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'sdk' } as NodeJS.ProcessEnv, { delivery: 'tmux' })).toBe('v6');
    expect(selectEngine({ CC2WECHAT_DELIVERY: 'tmux' } as NodeJS.ProcessEnv, { delivery: 'sdk' })).toBe('v5');
  });

  it('CC2WECHAT_ENGINE 一票定音(出事时的止血开关)', () => {
    expect(selectEngine({ CC2WECHAT_ENGINE: 'v5', CC2WECHAT_DELIVERY: 'sdk' } as NodeJS.ProcessEnv)).toBe('v5');
    expect(selectEngine({ CC2WECHAT_ENGINE: 'v6', CC2WECHAT_DELIVERY: 'tmux' } as NodeJS.ProcessEnv)).toBe('v6');
    expect(selectEngine({ CC2WECHAT_ENGINE: ' V5 ', CC2WECHAT_DELIVERY: 'sdk' } as NodeJS.ProcessEnv)).toBe('v5');
  });

  it('CC2WECHAT_ENGINE 写了不认识的值就当没写', () => {
    expect(selectEngine({ CC2WECHAT_ENGINE: 'v7', CC2WECHAT_DELIVERY: 'tmux' } as NodeJS.ProcessEnv)).toBe('v5');
  });
});

describe('startEngine — 真正 import 的是哪个入口', () => {
  it('sdk → import v6/main.js', async () => {
    const importer = vi.fn().mockResolvedValue(undefined);
    const engine = await startEngine({ env: { CC2WECHAT_DELIVERY: 'sdk' } as NodeJS.ProcessEnv, importer });
    expect(engine).toBe('v6');
    expect(importer).toHaveBeenCalledWith('./v6/main.js');
  });

  it('tmux → import v5/main.js', async () => {
    const importer = vi.fn().mockResolvedValue(undefined);
    const engine = await startEngine({ env: { CC2WECHAT_DELIVERY: 'tmux' } as NodeJS.ProcessEnv, importer });
    expect(engine).toBe('v5');
    expect(importer).toHaveBeenCalledWith('./v5/main.js');
  });

  it('CC2WECHAT_ENGINE=v5 强制回退', async () => {
    const importer = vi.fn().mockResolvedValue(undefined);
    await startEngine({ env: { CC2WECHAT_ENGINE: 'v5', CC2WECHAT_DELIVERY: 'sdk' } as NodeJS.ProcessEnv, importer });
    expect(importer).toHaveBeenCalledWith('./v5/main.js');
  });

  it('两个入口路径就是 cli.ts 里写的那两个', () => {
    expect(ENGINE_ENTRY).toEqual({ v5: './v5/main.js', v6: './v6/main.js' });
  });
});

describe('cli.ts startOne 接上了这个路由', () => {
  it('不再写死 import v5/main.js', () => {
    const src = fs.readFileSync(new URL('../../cli.ts', import.meta.url).pathname, 'utf-8');
    const startOne = src.slice(src.indexOf('function startOne'), src.indexOf('function stopOne'));
    expect(startOne).toContain('startEngine');
    expect(startOne).not.toMatch(/import\(['"]\.\/v5\/main\.js['"]\)/);
  });
});
