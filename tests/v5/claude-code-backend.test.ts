import { describe, it, expect } from 'vitest';

/**
 * ClaudeCodeBackend 单测
 * 验证命令生成 + 结果提取逻辑
 */

// ---- 内联接口 ----

interface LaunchOpts {
  sessionId: string;
  cwd: string;
}

interface PipeOpts {
  prompt: string;
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
}

interface BackendEvent {
  type: string;
  [key: string]: unknown;
}

// ---- 内联实现（从架构文档复制核心逻辑，测试验证行为正确性）----

class ClaudeCodeBackend {
  readonly name = 'claude-code';

  buildLaunchCommand(opts: LaunchOpts): string {
    return `cd ${opts.cwd} && claude --resume ${opts.sessionId} --dangerously-skip-permissions`;
  }

  buildPipeCommand(opts: PipeOpts): string {
    const prompt = JSON.stringify(opts.prompt);
    return `claude -p ${prompt} --resume ${opts.sessionId} --output-format text --permission-mode bypassPermissions`;
  }

  extractResult(events: BackendEvent[]): string {
    for (const event of [...events].reverse()) {
      if (event.type === 'result' && typeof event.result === 'string') return event.result;
      if (event.type === 'assistant') {
        const msg = event.message as { content?: unknown } | undefined;
        if (typeof msg?.content === 'string') return msg.content;
        if (Array.isArray(msg?.content)) {
          return (msg!.content as Array<{ type?: string; text?: string }>)
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text)
            .join('\n');
        }
      }
    }
    return '';
  }
}

// ---- Tests ----

describe('ClaudeCodeBackend', () => {
  const backend = new ClaudeCodeBackend();

  describe('buildLaunchCommand', () => {
    it('includes "claude --resume" with sessionId', () => {
      const cmd = backend.buildLaunchCommand({ sessionId: 'abc', cwd: '/tmp' });
      expect(cmd).toContain('claude --resume abc');
    });

    it('includes cd to cwd', () => {
      const cmd = backend.buildLaunchCommand({ sessionId: 'abc', cwd: '/home/user/project' });
      expect(cmd).toContain('cd /home/user/project');
    });

    it('includes --dangerously-skip-permissions', () => {
      const cmd = backend.buildLaunchCommand({ sessionId: 'abc', cwd: '/tmp' });
      expect(cmd).toContain('--dangerously-skip-permissions');
    });
  });

  describe('buildPipeCommand', () => {
    it('includes "claude -p"', () => {
      const cmd = backend.buildPipeCommand({ prompt: 'hello', sessionId: 'abc', cwd: '/tmp' });
      expect(cmd).toContain('claude -p');
    });

    it('includes --resume with sessionId', () => {
      const cmd = backend.buildPipeCommand({ prompt: 'hello', sessionId: 'abc', cwd: '/tmp' });
      expect(cmd).toContain('--resume abc');
    });

    it('includes --output-format text', () => {
      const cmd = backend.buildPipeCommand({ prompt: 'hello', sessionId: 'abc', cwd: '/tmp' });
      expect(cmd).toContain('--output-format text');
    });

    it('JSON-escapes the prompt', () => {
      const cmd = backend.buildPipeCommand({ prompt: 'say "hello"', sessionId: 'abc', cwd: '/tmp' });
      expect(cmd).toContain('"say \\"hello\\""');
    });
  });

  describe('extractResult', () => {
    it('extracts text from result event', () => {
      const events: BackendEvent[] = [
        { type: 'result', result: 'hello' },
      ];
      expect(backend.extractResult(events)).toBe('hello');
    });

    it('extracts text from assistant event with string content', () => {
      const events: BackendEvent[] = [
        { type: 'assistant', message: { content: 'hi' } },
      ];
      expect(backend.extractResult(events)).toBe('hi');
    });

    it('extracts and joins text blocks from assistant event with array content', () => {
      const events: BackendEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        },
      ];
      expect(backend.extractResult(events)).toBe('a\nb');
    });

    it('filters out non-text blocks from array content', () => {
      const events: BackendEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'hello' },
              { type: 'tool_use', id: 'x' },
              { type: 'text', text: 'world' },
            ],
          },
        },
      ];
      expect(backend.extractResult(events)).toBe('hello\nworld');
    });

    it('returns empty string for empty events array', () => {
      expect(backend.extractResult([])).toBe('');
    });

    it('prefers later result event (reverse order)', () => {
      const events: BackendEvent[] = [
        { type: 'result', result: 'first' },
        { type: 'assistant', message: { content: 'middle' } },
        { type: 'result', result: 'last' },
      ];
      expect(backend.extractResult(events)).toBe('last');
    });

    it('falls back to assistant if result has non-string value', () => {
      const events: BackendEvent[] = [
        { type: 'assistant', message: { content: 'fallback' } },
        { type: 'result', result: 42 },
      ];
      expect(backend.extractResult(events)).toBe('fallback');
    });

    it('returns empty string when no matching event types', () => {
      const events: BackendEvent[] = [
        { type: 'tool_use', id: 'abc' },
        { type: 'system', text: 'init' },
      ];
      expect(backend.extractResult(events)).toBe('');
    });
  });
});
