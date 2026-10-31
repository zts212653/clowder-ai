import type { ThreadOverview } from './ThreadOverviewRepository.js';

/** Capacity partitions preserve every byte; they never filter a source for relevance. */
export function partitionCompleteOverviews(items: Array<{ overview: ThreadOverview; reason: string }>) {
  return items.flatMap((item) => {
    const pieces = [];
    for (let offset = 0; offset < item.overview.summary.length; offset += 80_000) {
      pieces.push({
        ...item,
        overview: { ...item.overview, summary: item.overview.summary.slice(offset, offset + 80_000) },
      });
    }
    return pieces;
  });
}
