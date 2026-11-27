/** Extract feature ID from tags. Supports `feature:f058` (import format) and bare `F058`. */
export function extractFeatureId(tags: readonly string[]): string {
  for (const tag of tags) {
    // Primary: `feature:f058` format from backlog-doc-import
    const prefixed = tag.match(/^feature:(f\d+)$/i);
    if (prefixed) return prefixed[1].toUpperCase();
    // Fallback: bare `F058`
    if (/^F\d+$/i.test(tag)) return tag.toUpperCase();
  }
  return 'Untagged';
}
