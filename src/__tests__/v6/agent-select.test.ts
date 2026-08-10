import { describe, it, expect } from 'vitest';
import { selectAgent } from '../../v6/agents/select.js';

describe('selectAgent — env CC2WECHAT_BACKEND > config.backend', () => {
  // 两台生产机的 env 就是这个值，所以这条断言 = "部署即常驻"
  it('生产现状 CC2WECHAT_BACKEND=codex → 常驻 app-server', () => {
    const a = selectAgent({ CC2WECHAT_BACKEND: 'codex' } as NodeJS.ProcessEnv);
    expect(a.name).toBe('codex');
    expect(a.persistent).toBe(true);
  });

  it('claude-code → 常驻 SDK 池', () => {
    const a = selectAgent({ CC2WECHAT_BACKEND: 'claude-code' } as NodeJS.ProcessEnv);
    expect(a.name).toBe('claude-code');
    expect(a.persistent).toBe(true);
  });

  it('env 没设时看 config.backend', () => {
    expect(selectAgent({} as NodeJS.ProcessEnv, { backend: 'codex' }).name).toBe('codex');
    expect(selectAgent({} as NodeJS.ProcessEnv, { backend: 'claude-code' }).name).toBe('claude-code');
  });

  it('codex-exec 是逃生口:回到一次性 spawn', () => {
    const a = selectAgent({ CC2WECHAT_BACKEND: 'codex-exec' } as NodeJS.ProcessEnv);
    expect(a.name).toBe('codex');
    expect(a.persistent).toBe(false);
  });

  it('env 覆盖 config', () => {
    expect(selectAgent({ CC2WECHAT_BACKEND: 'codex' } as NodeJS.ProcessEnv, { backend: 'claude-code' }).name).toBe('codex');
  });

  it('两边都没有时默认 claude-code(与 v5 DEFAULT_CONFIG 一致)', () => {
    expect(selectAgent({} as NodeJS.ProcessEnv).name).toBe('claude-code');
  });

  it('codex-persistent 与 codex 同义(别名,不再降级)', () => {
    const a = selectAgent({ CC2WECHAT_BACKEND: 'codex-persistent' } as NodeJS.ProcessEnv);
    expect(a.name).toBe('codex');
    expect(a.persistent).toBe(true);
  });

  it('未知值回退 claude-code 而不是崩', () => {
    expect(selectAgent({ CC2WECHAT_BACKEND: 'gemini' } as NodeJS.ProcessEnv).name).toBe('claude-code');
  });

  it('大小写/空格不敏感', () => {
    const a = selectAgent({ CC2WECHAT_BACKEND: ' CODEX ' } as NodeJS.ProcessEnv);
    expect(a.name).toBe('codex');
    expect(a.persistent).toBe(true);
  });
});
