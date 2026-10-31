import type { CoverageMatrixItem, CoverageSource } from './coverage-search-types.js';
import type { EvidenceItem } from './interfaces.js';

export function addCoverageDirectHits(
  items: EvidenceItem[],
  source: CoverageSource,
  seen: Set<string>,
  matrix: CoverageMatrixItem[],
  maxItems = Number.POSITIVE_INFINITY,
): void {
  let added = 0;
  for (const item of items) {
    if (added >= maxItems) break;
    const key = item.anchor.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    matrix.push({
      anchor: item.anchor,
      title: item.title,
      kind: item.kind,
      matchType: 'direct',
      retrievalScore: item.retrievalScore,
      source,
      sourcePath: item.sourcePath,
      drillDown: item.drillDown,
    });
    added++;
  }
}
