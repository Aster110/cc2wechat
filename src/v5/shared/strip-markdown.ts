/**
 * Strip Markdown formatting for WeChat plain-text display.
 *
 * Handles: code blocks, inline code, images, links, bold, italic,
 * headings, horizontal rules, and blockquotes.
 */
export function stripMarkdown(text: string): string {
  let result = text;
  // Fenced code blocks: strip fences, keep content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Inline code: keep content
  result = result.replace(/`([^`]+)`/g, '$1');
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Links: keep display text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  // Italic
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '$1');
  // Headings
  result = result.replace(/^#{1,6}\s+/gm, '');
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '');
  // Blockquotes
  result = result.replace(/^>\s?/gm, '');
  return result.trim();
}
