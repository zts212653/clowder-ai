/**
 * Sanitize markdown content into safe HTML.
 *
 * Single source of truth for the sanitization pipeline used by
 * community.html (issue bodies) and docs.html (doc content).
 * Tests import the same function — no parallel implementation.
 *
 * DOMPurify and marked are injected so the caller controls versions:
 * production passes in CDN globals, tests pass workspace instances.
 *
 * @param {string} md      - raw markdown text
 * @param {object} deps
 * @param {object} deps.DOMPurify - DOMPurify instance (or factory return)
 * @param {object} deps.marked    - marked namespace with parse()
 * @returns {string} sanitized HTML
 */
export function sanitizeMarkdown(md, { DOMPurify, marked }) {
  return DOMPurify.sanitize(marked.parse(md));
}
