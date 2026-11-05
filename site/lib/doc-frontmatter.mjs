/**
 * Strip a leading YAML frontmatter block from repository Markdown.
 *
 * Docs in this repo carry a frontmatter block (`---` … `---`) that describes
 * the document to tooling: doc_kind, created, topics, related_features, and so
 * on. It is metadata for the repo, not content for a reader, and `marked`
 * renders it as a paragraph of raw text — so the docs viewer would show it as
 * the first thing on the page.
 *
 * Only the docs viewer strips it. community.html renders issue bodies through
 * the same sanitizer and must NOT strip: an issue whose body happens to start
 * with a `---` line is showing the author's text, not repo metadata.
 *
 * A block only counts when the opening fence is the very first line and a
 * closing fence follows, so a document that merely starts with a horizontal
 * rule keeps its rule.
 *
 * @param {string} md - raw markdown text
 * @returns {string} markdown without a leading frontmatter block
 */
export function stripFrontmatter(md) {
  if (typeof md !== 'string') return md;
  return md.replace(/^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '').replace(/^\s*\r?\n/, '');
}
