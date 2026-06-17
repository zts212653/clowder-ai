/**
 * Community Link Parser (F168 Phase B — Task 3)
 *
 * Parses PR body text for GitHub closing keywords and extracts referenced issue numbers.
 * Only same-repository bare #N references are extracted; cross-repo owner/repo#N syntax
 * is intentionally ignored (Phase B scope; reconciler handles edge cases in Phase D).
 *
 * Supports GitHub official closing keywords (case-insensitive):
 *   fix / fixes / fixed / close / closes / closed / resolve / resolves / resolved
 * followed by optional colon and #<number>.
 *
 * Reference: https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 */

/**
 * Regex matching GitHub closing keywords followed by a bare #N reference.
 * Cross-repo references (owner/repo#N) are excluded by requiring whitespace or
 * start-of-string before the keyword — the `\b` word boundary before the keyword
 * combined with `\s+#` ensures we only match bare issue numbers, not `repo#N`.
 */
const CLOSING_RE = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

/**
 * Extract issue numbers referenced by closing keywords in a PR body.
 * Returns a deduplicated, sorted array of issue numbers.
 * Returns [] for null/undefined/empty body.
 */
export function parseLinkedIssues(body: string | null | undefined): number[] {
  if (!body) return [];

  const seen = new Set<number>();
  CLOSING_RE.lastIndex = 0; // reset stateful regex for safe re-use

  let match: RegExpExecArray | null;
  while ((match = CLOSING_RE.exec(body)) !== null) {
    const n = parseInt(match[1], 10);
    if (!Number.isNaN(n)) seen.add(n);
  }

  return [...seen].sort((a, b) => a - b);
}
