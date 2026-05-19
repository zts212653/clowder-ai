import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('computeEdgeWeight', () => {
  let computeEdgeWeight;

  it('loads module', async () => {
    const mod = await import(`../../dist/domains/memory/graph-edge-weight.js?v=${Date.now()}`);
    computeEdgeWeight = mod.computeEdgeWeight;
    assert.ok(computeEdgeWeight);
  });

  it('wikilink base weight = 1.0', () => {
    const w = computeEdgeWeight('wikilink', 0, null);
    assert.equal(w.typeBase, 1.0);
    assert.equal(w.traversalBoost, 0);
    assert.equal(w.total, 1.0);
  });

  it('feature_ref base weight = 1.1', () => {
    const w = computeEdgeWeight('feature_ref', 0, null);
    assert.equal(w.typeBase, 1.1);
    assert.equal(w.total, 1.1);
  });

  it('doc_link base weight = 0.9', () => {
    const w = computeEdgeWeight('doc_link', 0, null);
    assert.equal(w.typeBase, 0.9);
  });

  it('unknown relation defaults to base=1.0', () => {
    const w = computeEdgeWeight('some_custom', 0, null);
    assert.equal(w.typeBase, 1.0);
  });

  it('traversal_count boost scales with 30d count', () => {
    const w = computeEdgeWeight('wikilink', 10, 0);
    // recencyDecay = 30/(30+0) = 1.0, boost = 0.05 * 10 * 1.0 = 0.5
    assert.equal(w.traversalBoost, 0.5);
    assert.equal(w.total, 1.5);
  });

  it('edge recency decay: recent traversal → higher weight', () => {
    const recent = computeEdgeWeight('wikilink', 10, 1);
    const old = computeEdgeWeight('wikilink', 10, 60);
    assert.ok(recent.total > old.total, `recent (${recent.total}) should > old (${old.total})`);
  });

  it('null daysSinceLastTraversal: no boost', () => {
    const w = computeEdgeWeight('wikilink', 10, null);
    assert.equal(w.traversalBoost, 0);
    assert.equal(w.recencyDecay, 0);
  });

  it('zero traversals: weight = type_base only', () => {
    const w = computeEdgeWeight('wikilink', 0, 5);
    assert.equal(w.traversalBoost, 0);
    assert.equal(w.total, 1.0);
  });

  it('edge decay half-life is 30d', () => {
    const w = computeEdgeWeight('wikilink', 20, 30);
    // recencyDecay = 30/(30+30) = 0.5
    assert.ok(Math.abs(w.recencyDecay - 0.5) < 0.001);
    // boost = 0.05 * 20 * 0.5 = 0.5
    assert.ok(Math.abs(w.traversalBoost - 0.5) < 0.001);
  });
});
