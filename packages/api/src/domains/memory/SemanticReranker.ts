// F102 Phase C: SemanticReranker — distance-sorted merge for FTS candidates
// AC-C8: rerank doesn't replace lexical recall, only reorders

import type { EvidenceItem } from './interfaces.js';

export class SemanticReranker {
  /**
   * Rerank FTS candidates using pre-computed vector distances.
   * Candidates not found in vecResults are appended at the end (preserving original order).
   * Pure function — no side effects, no async, no external dependencies.
   */
  rerankWithDistances(
    candidates: EvidenceItem[],
    vecResults: Array<{ anchor: string; distance: number }>,
  ): EvidenceItem[] {
    if (candidates.length <= 1 || vecResults.length === 0) return candidates;

    const distMap = new Map(vecResults.map((v) => [v.anchor, v.distance]));
    const withDist: Array<{ item: EvidenceItem; dist: number }> = [];
    const noVec: EvidenceItem[] = [];

    for (const c of candidates) {
      const d = distMap.get(c.anchor);
      if (d !== undefined) {
        withDist.push({ item: c, dist: d });
      } else {
        noVec.push(c);
      }
    }

    withDist.sort((a, b) => a.dist - b.dist);
    return [...withDist.map((w) => w.item), ...noVec];
  }
}
