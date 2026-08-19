import type { EvidenceItem } from './interfaces.js';

const PULL_ONLY_RANK_WEIGHT = 0.95;

/**
 * Public reflection candidates are deliberately searchable, but a near-tied
 * ordinary result must remain ahead even when the optional F163 authority
 * experiment is disabled. The positional weight is a soft penalty: a
 * substantially stronger pull-only match can still outrank a weak result.
 */
export function applyPullOnlyDownrank(results: EvidenceItem[]): void {
  if (results.length < 2 || !results.some((item) => item.activation === 'pull_only')) return;

  const rankOffset = 60;
  const ranked = results.map((item, index) => ({
    item,
    index,
    score: (1 / (index + rankOffset)) * (item.activation === 'pull_only' ? PULL_ONLY_RANK_WEIGHT : 1),
  }));
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  for (let index = 0; index < ranked.length; index += 1) {
    results[index] = ranked[index].item;
  }
}
