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
    '  • Use intent=coverage for system-level multi-scope coverage search with matrix output.',
    '  • Or follow memory-search-best-practices skill for manual multi-query coverage.',
  ].join('\n');
}
