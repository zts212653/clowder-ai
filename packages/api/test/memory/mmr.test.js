import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function makeItem(anchor, keywords = [], score = 1) {
  return {
    item: { anchor, kind: 'feature', status: 'active', title: anchor, keywords, updatedAt: new Date().toISOString() },
    score,
  };
}

describe('MMR dedup', () => {
  let applyMMR, keywordSimilarity;

  it('loads module', async () => {
    const mod = await import(`../../dist/domains/memory/mmr.js?v=${Date.now()}`);
    applyMMR = mod.applyMMR;
    keywordSimilarity = mod.keywordSimilarity;
    assert.ok(applyMMR);
  });

  it('pool < 3×limit: returns original order unchanged', () => {
    const items = [makeItem('A', ['x'], 3), makeItem('B', ['y'], 2), makeItem('C', ['z'], 1)];
    const result = applyMMR(items, 2); // pool=3 < 3*2=6
    assert.equal(result.length, 2);
    assert.equal(result[0].anchor, 'A');
    assert.equal(result[1].anchor, 'B');
  });

  it('pool >= 3×limit: MMR reranks for diversity', () => {
    // 9 items, limit=3, pool=9 >= 3*3=9
    // Tight score gaps so diversity penalty can change outcome
    const items = [
      makeItem('A', ['memory', 'search'], 5.0),
      makeItem('A-dup', ['memory', 'search'], 4.9), // similar to A, nearly same score
      makeItem('A-dup2', ['memory', 'search'], 4.8),
      makeItem('B', ['graph', 'edge'], 4.7), // diverse topic
      makeItem('B-dup', ['graph', 'edge'], 4.6),
      makeItem('C', ['auth', 'token'], 4.5), // diverse topic
      makeItem('D', ['memory', 'search'], 4.4),
      makeItem('E', ['graph', 'edge'], 4.3),
      makeItem('F', ['auth', 'token'], 4.2),
    ];
    const result = applyMMR(items, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0].anchor, 'A');
    // With tight scores (0.1 gap) and λ=0.7, diversity penalty (0.3×1.0=0.3)
    // pushes A-dup below B. Second pick: B (diverse) beats A-dup.
    const anchors = result.map((r) => r.anchor);
    assert.ok(anchors.includes('B') || anchors.includes('C'), `should include a diverse item: ${anchors}`);
  });

  it('λ=1.0: pure relevance, no diversity penalty', () => {
    const items = Array.from({ length: 9 }, (_, i) => makeItem(`item-${i}`, ['same'], 10 - i));
    const result = applyMMR(items, 3, 1.0);
    assert.equal(result[0].anchor, 'item-0');
    assert.equal(result[1].anchor, 'item-1');
    assert.equal(result[2].anchor, 'item-2');
  });

  it('λ=0.0: pure diversity, avoids similar items', () => {
    const items = [
      makeItem('A1', ['x'], 10),
      makeItem('A2', ['x'], 9),
      makeItem('B1', ['y'], 8),
      makeItem('B2', ['y'], 7),
      makeItem('C1', ['z'], 6),
      makeItem('C2', ['z'], 5),
      makeItem('D1', ['w'], 4),
      makeItem('D2', ['w'], 3),
      makeItem('E1', ['v'], 2),
    ];
    const result = applyMMR(items, 3, 0.0);
    // First pick: anything (no diversity penalty with empty selected)
    // Second pick: something maximally different from first
    // Should NOT pick A1 + A2 together (same keywords)
    const anchors = result.map((r) => r.anchor);
    const hasNoDuplicate =
      !(anchors.includes('A1') && anchors.includes('A2')) &&
      !(anchors.includes('B1') && anchors.includes('B2')) &&
      !(anchors.includes('C1') && anchors.includes('C2')) &&
      !(anchors.includes('D1') && anchors.includes('D2'));
    assert.ok(hasNoDuplicate, `λ=0 should avoid selecting items with identical keywords: ${anchors}`);
  });

  it('keywordSimilarity: Jaccard on keyword sets', () => {
    const a = { keywords: ['x', 'y', 'z'] };
    const b = { keywords: ['y', 'z', 'w'] };
    const sim = keywordSimilarity(a, b);
    // intersection={y,z}=2, union={x,y,z,w}=4
    assert.equal(sim, 0.5);
  });

  it('keywordSimilarity: both empty = 0', () => {
    const sim = keywordSimilarity({ keywords: [] }, { keywords: [] });
    assert.equal(sim, 0);
  });

  it('keywordSimilarity: one empty = 0', () => {
    const sim = keywordSimilarity({ keywords: ['a'] }, { keywords: [] });
    assert.equal(sim, 0);
  });
});
