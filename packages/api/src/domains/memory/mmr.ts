// F200 Phase C: Maximal Marginal Relevance dedup (Carbonell & Goldstein 1998)

import type { EvidenceItem } from './interfaces.js';

export interface ScoredItem {
  item: EvidenceItem;
  score: number;
}

export function applyMMR(items: ScoredItem[], limit: number, lambda: number = 0.7): EvidenceItem[] {
  if (items.length < 3 * limit) return items.slice(0, limit).map((i) => i.item);

  const selected: ScoredItem[] = [];
  const remaining = [...items];

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      const maxSim =
        selected.length === 0 ? 0 : Math.max(...selected.map((s) => keywordSimilarity(remaining[i].item, s.item)));
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected.map((s) => s.item);
}

export function keywordSimilarity(a: EvidenceItem, b: EvidenceItem): number {
  const setA = new Set(a.keywords ?? []);
  const setB = new Set(b.keywords ?? []);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter((k) => setB.has(k)).length;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
