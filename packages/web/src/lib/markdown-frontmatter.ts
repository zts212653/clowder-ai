/**
 * Hide closed, leading YAML frontmatter without changing Markdown source offsets.
 * Readers, listen sentences and paper previews share this presentation rule.
 */
export function maskLeadingMarkdownFrontmatter(markdown: string): string {
  const match = markdown.match(/^(?:\uFEFF)?---[\t ]*\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/);
  if (!match) return markdown;
  const masked = match[0].replace(/[^\r\n]/g, ' ');
  return masked + markdown.slice(match[0].length);
}
