import { describe, it, expect } from 'vitest';
import { stripMarkdown } from '../src/v5/shared/strip-markdown.js';

describe('stripMarkdown', () => {
  it('strips fenced code blocks but keeps content', () => {
    const input = '```javascript\nconsole.log("hello");\n```';
    expect(stripMarkdown(input)).toBe('console.log("hello");');
  });

  it('strips inline code backticks', () => {
    expect(stripMarkdown('Use `npm install` to install')).toBe('Use npm install to install');
  });

  it('removes images entirely', () => {
    expect(stripMarkdown('See ![alt](https://example.com/img.png) here')).toBe('See  here');
  });

  it('strips links but keeps display text', () => {
    expect(stripMarkdown('Visit [Google](https://google.com)')).toBe('Visit Google');
  });

  it('strips bold markers', () => {
    expect(stripMarkdown('This is **bold** text')).toBe('This is bold text');
    expect(stripMarkdown('This is __bold__ text')).toBe('This is bold text');
  });

  it('strips italic markers', () => {
    expect(stripMarkdown('This is *italic* text')).toBe('This is italic text');
    expect(stripMarkdown('This is _italic_ text')).toBe('This is italic text');
  });

  it('strips strikethrough', () => {
    expect(stripMarkdown('This is ~~deleted~~ text')).toBe('This is deleted text');
  });

  it('strips headings', () => {
    expect(stripMarkdown('# Title\n## Subtitle\nBody')).toBe('Title\nSubtitle\nBody');
  });

  it('strips horizontal rules', () => {
    expect(stripMarkdown('above\n---\nbelow')).toBe('above\n\nbelow');
  });

  it('strips blockquotes', () => {
    expect(stripMarkdown('> quoted text\n> more')).toBe('quoted text\nmore');
  });

  it('handles mixed markdown', () => {
    const input = [
      '# Hello World',
      '',
      '**Bold** and *italic* with [a link](http://example.com)',
      '',
      '> A quote',
      '',
      '```',
      'code here',
      '```',
    ].join('\n');
    const result = stripMarkdown(input);
    expect(result).toContain('Hello World');
    expect(result).toContain('Bold');
    expect(result).toContain('italic');
    expect(result).toContain('a link');
    expect(result).toContain('A quote');
    expect(result).toContain('code here');
    expect(result).not.toContain('**');
    expect(result).not.toContain('```');
    expect(result).not.toContain('](');
  });

  it('returns empty string for empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('handles plain text without markdown', () => {
    expect(stripMarkdown('Just plain text')).toBe('Just plain text');
  });
});
