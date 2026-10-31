import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySalienceRerank } from '../../dist/domains/memory/f163-types.js';

// Production anchors are short IDs (F163, ADR-009) not full paths.
// always_on docs are injected separately, not part of search results.
const goldRelevant = new Set(['f163', 'adr-009', 'doc:docs/discussions/2026-04-15-harness-engineering']);

const simulatedResults = [
  { anchor: 'F088', authority: 'validated', keywords: ['F088', 'chat'] },
  { anchor: 'F163', authority: 'validated', keywords: ['F163', 'memory'] },
  { anchor: 'ADR-009', authority: 'validated', keywords: ['ADR-009'] },
  { anchor: 'F042', authority: 'validated', keywords: ['F042'] },
  {
    anchor: 'doc:docs/discussions/2026-04-15-harness-engineering',
    authority: 'candidate',
    keywords: ['harness', 'F163'],
  },
  { anchor: 'F101', authority: 'validated', keywords: ['F101'] },
  { anchor: 'F124', authority: 'validated', keywords: ['F124'] },
  { anchor: 'doc:docs/research/karpathy', authority: 'candidate', keywords: ['karpathy'] },
];

function ndcgAt10(rankedAnchors, relevant) {
  const dcg = rankedAnchors.slice(0, 10).reduce((sum, anchor, i) => {
    const rel = relevant.has(anchor.toLowerCase()) ? 1 : 0;
    return sum + rel / Math.log2(i + 2);
  }, 0);
  const idealOrder = rankedAnchors.slice().sort((a, b) => {
    const relA = relevant.has(a.toLowerCase()) ? 1 : 0;
    const relB = relevant.has(b.toLowerCase()) ? 1 : 0;
    return relB - relA;
  });
  const idcg = idealOrder.slice(0, 10).reduce((sum, anchor, i) => {
    const rel = relevant.has(anchor.toLowerCase()) ? 1 : 0;
    return sum + rel / Math.log2(i + 2);
  }, 0);
  return idcg === 0 ? 1.0 : dcg / idcg;
}

describe('NDCG@10 regression (AC-F5)', () => {
  const ctx = {
    activeFeatureIds: ['F163'],
    truthSourceRef: 'docs/features/F163-memory-entropy-reduction.md',
    recentArtifactRefs: ['docs/decisions/ADR-009.md'],
  };

  it('salience rerank NDCG@10 >= Phase E baseline', () => {
    const baselineAnchors = simulatedResults.map((r) => r.anchor);
    const baselineNDCG = ndcgAt10(baselineAnchors, goldRelevant);

    const reranked = applySalienceRerank(simulatedResults, ctx);
    const rerankedAnchors = reranked.items.map((r) => r.anchor);
    const rerankedNDCG = ndcgAt10(rerankedAnchors, goldRelevant);

    assert.ok(
      rerankedNDCG >= baselineNDCG,
      `NDCG regression: baseline=${baselineNDCG.toFixed(4)}, reranked=${rerankedNDCG.toFixed(4)}`,
    );
  });

  it('salience rerank improves NDCG (relevant docs promoted)', () => {
    const baselineAnchors = simulatedResults.map((r) => r.anchor);
    const baselineNDCG = ndcgAt10(baselineAnchors, goldRelevant);

    const reranked = applySalienceRerank(simulatedResults, ctx);
    const rerankedAnchors = reranked.items.map((r) => r.anchor);
    const rerankedNDCG = ndcgAt10(rerankedAnchors, goldRelevant);

    assert.ok(
      rerankedNDCG > baselineNDCG,
      `Expected improvement: baseline=${baselineNDCG.toFixed(4)}, reranked=${rerankedNDCG.toFixed(4)}`,
    );
  });

  it('does not remove any results (recall preserved)', () => {
    const reranked = applySalienceRerank(simulatedResults, ctx);
    assert.equal(reranked.items.length, simulatedResults.length);
    for (const original of simulatedResults) {
      assert.ok(
        reranked.items.some((r) => r.anchor === original.anchor),
        `missing: ${original.anchor}`,
      );
    }
  });

  it('no-op without context preserves NDCG exactly', () => {
    const emptyCtx = { activeFeatureIds: [], truthSourceRef: null, recentArtifactRefs: [] };
    const baselineAnchors = simulatedResults.map((r) => r.anchor);
    const baselineNDCG = ndcgAt10(baselineAnchors, goldRelevant);

    const reranked = applySalienceRerank(simulatedResults, emptyCtx);
    const rerankedAnchors = reranked.items.map((r) => r.anchor);
    const rerankedNDCG = ndcgAt10(rerankedAnchors, goldRelevant);

    assert.equal(rerankedNDCG, baselineNDCG);
  });
});
