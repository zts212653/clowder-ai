const COVERAGE_INTENT_PATTERNS = [
  /哪些/u,
  /所有(?!权)/u,
  /历史上/u,
  /提过/u,
  /沉淀/u,
  /\bwhich\s+(?:threads?|docs?|documents?|files?|md|mentions?|references?|places?)\b/i,
  /\ball\s+(?:threads?|docs?|documents?|files?|md|mentions?|references?|places?)\b/i,
  /\bhistory\b/i,
  /\bmention(?:s|ed)?\b/i,
  /\bcoverage\b/i,
  /\bsource[- ]?map\b/i,
  /\bprovenance\b/i,
];

export function composeCoverageIntentNudge(query: string): string | null {
  if (!COVERAGE_INTENT_PATTERNS.some((pattern) => pattern.test(query))) return null;
  return [
    '📚 Coverage task — single top-k search is not exhaustive.',
    '  • For "哪些/所有/历史上/提过/沉淀" questions, use memory-search-best-practices.',
    '  • Run docs + threads as separate scopes, expand terms yourself, then Read canonical docs and source threads.',
  ].join('\n');
}
