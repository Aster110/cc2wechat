import { describe, it, expect } from 'vitest';
import { selectAgent } from '../../v6/agents/select.js';

describe('selectAgent — env CC2WECHAT_BACKEND > config.backend', () => {
  it('生产现状 CC2WECHAT_BACKEND=codex → 一次性 spawn 的 codex', () => {
    const a = selectAgent({ CC2WECHAT_BACKEND: 'codex' } as NodeJS.ProcessEnv);
    expect(a.name).toBe('codex');
    expect(a.persistent).toBe(false);
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

  it('env 覆盖 config', () => {
    expect(selectAgent({ CC2WECHAT_BACKEND: 'codex' } as NodeJS.ProcessEnv, { backend: 'claude-code' }).name).toBe('codex');
  });

  it('两边都没有时默认 claude-code(与 v5 DEFAULT_CONFIG 一致)', () => {
    expect(selectAgent({} as NodeJS.ProcessEnv).name).toBe('claude-code');
  });

  // 常驻 codex 的实现在另一条线上,这里是它的接缝
  it('codex-persistent 暂时退回一次性 spawn,不炸', () => {
    const a = selectAgent({ CC2WECHAT_BACKEND: 'codex-persistent' } as NodeJS.ProcessEnv);
    expect(a.name).toBe('codex');
    expect(a.persistent).toBe(false);
  });

  it('未知值回退 claude-code 而不是崩', () => {
    expect(selectAgent({ CC2WECHAT_BACKEND: 'gemini' } as NodeJS.ProcessEnv).name).toBe('claude-code');
  });

  it('大小写/空格不敏感', () => {
    expect(selectAgent({ CC2WECHAT_BACKEND: ' CODEX ' } as NodeJS.ProcessEnv).name).toBe('codex');
  });
});
