/**
 * F163: Gold set evaluation script tests
 * Covers: NDCG@10 computation, MRR computation, empty gold set handling
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import eval utilities (will fail until implemented)
import { computeMRR, computeNDCG, runEvaluation } from '../../dist/domains/memory/f163-eval-utils.js';

describe('F163 Eval Utilities', () => {
  it('computeNDCG returns 1.0 for perfect ranking', () => {
    // Gold: anchor-a (relevance=3), anchor-b (relevance=2)
    // Returned: [anchor-a, anchor-b] — perfect order
    const relevance = { 'anchor-a': 3, 'anchor-b': 2 };
    const ranked = ['anchor-a', 'anchor-b'];
    const ndcg = computeNDCG(ranked, relevance, 10);
    assert.ok(ndcg > 0.99, `expected ~1.0 but got ${ndcg}`);
  });

  it('computeNDCG returns < 1.0 for imperfect ranking', () => {
    // Gold: anchor-a (relevance=3), anchor-b (relevance=2)
    // Returned: [anchor-b, anchor-a] — swapped
    const relevance = { 'anchor-a': 3, 'anchor-b': 2 };
    const ranked = ['anchor-b', 'anchor-a'];
    const ndcg = computeNDCG(ranked, relevance, 10);
    assert.ok(ndcg < 1.0, `expected < 1.0 but got ${ndcg}`);
    assert.ok(ndcg > 0.5, `expected > 0.5 but got ${ndcg}`);
  });

  it('computeNDCG returns 0 when no relevant results found', () => {
    const relevance = { 'anchor-a': 3 };
    const ranked = ['anchor-x', 'anchor-y'];
    const ndcg = computeNDCG(ranked, relevance, 10);
    assert.equal(ndcg, 0);
  });

  it('computeMRR returns 1.0 when first result is relevant', () => {
    const relevantAnchors = ['anchor-a', 'anchor-b'];
    const ranked = ['anchor-a', 'anchor-c'];
    const mrr = computeMRR(ranked, relevantAnchors);
    assert.equal(mrr, 1.0);
  });

  it('computeMRR returns 0.5 when first relevant is at position 2', () => {
    const relevantAnchors = ['anchor-a'];
    const ranked = ['anchor-x', 'anchor-a', 'anchor-y'];
    const mrr = computeMRR(ranked, relevantAnchors);
    assert.equal(mrr, 0.5);
  });

  it('computeMRR returns 0 when no relevant results found', () => {
    const relevantAnchors = ['anchor-a'];
    const ranked = ['anchor-x', 'anchor-y'];
    const mrr = computeMRR(ranked, relevantAnchors);
    assert.equal(mrr, 0);
  });

  it('runEvaluation handles empty gold set', async () => {
    const goldSet = { version: 1, queries: [] };
    const mockSearch = async () => [];
    const result = await runEvaluation(goldSet, mockSearch);
    assert.equal(result.queryCount, 0);
    assert.equal(result.meanNDCG, 0);
    assert.equal(result.meanMRR, 0);
  });

  it('runEvaluation computes aggregate metrics', async () => {
    const goldSet = {
      version: 1,
      queries: [
        {
          query: 'test query',
          relevantAnchors: ['a1', 'a2'],
          relevance: { a1: 3, a2: 2 },
        },
      ],
    };
    const mockSearch = async () => [
      { anchor: 'a1', title: 'A1', kind: 'decision', status: 'active', updatedAt: '2026-01-01' },
      { anchor: 'a2', title: 'A2', kind: 'plan', status: 'active', updatedAt: '2026-01-01' },
    ];
    const result = await runEvaluation(goldSet, mockSearch);
    assert.equal(result.queryCount, 1);
    assert.ok(result.meanNDCG > 0.99, `expected ~1.0 but got ${result.meanNDCG}`);
    assert.equal(result.meanMRR, 1.0);
  });
});
