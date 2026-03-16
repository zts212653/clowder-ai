import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('SemanticReranker', () => {
  it('reranks candidates by pre-computed vector distance', async () => {
    const { SemanticReranker } = await import('../../dist/domains/memory/SemanticReranker.js');
    const reranker = new SemanticReranker();
    const candidates = [
      { anchor: 'F102', kind: 'feature', title: 'Memory', status: 'active', updatedAt: '' },
      { anchor: 'F042', kind: 'feature', title: 'Arch', status: 'active', updatedAt: '' },
      { anchor: 'F088', kind: 'feature', title: 'GW', status: 'active', updatedAt: '' },
    ];
    const vecResults = [
      { anchor: 'F042', distance: 0.1 },
      { anchor: 'F102', distance: 0.5 },
      { anchor: 'F088', distance: 0.9 },
    ];
    const result = reranker.rerankWithDistances(candidates, vecResults);
    assert.equal(result[0].anchor, 'F042');
    assert.equal(result[1].anchor, 'F102');
    assert.equal(result[2].anchor, 'F088');
  });

  it('preserves candidates not in vector results (appended at end)', async () => {
    const { SemanticReranker } = await import('../../dist/domains/memory/SemanticReranker.js');
    const reranker = new SemanticReranker();
    const candidates = [
      { anchor: 'F999', kind: 'feature', title: 'Unknown', status: 'active', updatedAt: '' },
      { anchor: 'F042', kind: 'feature', title: 'Arch', status: 'active', updatedAt: '' },
    ];
    const vecResults = [{ anchor: 'F042', distance: 0.1 }];
    const result = reranker.rerankWithDistances(candidates, vecResults);
    assert.equal(result.length, 2);
    assert.equal(result[0].anchor, 'F042');
    assert.equal(result[1].anchor, 'F999');
  });

  it('returns candidates unchanged when vecResults is empty', async () => {
    const { SemanticReranker } = await import('../../dist/domains/memory/SemanticReranker.js');
    const reranker = new SemanticReranker();
    const candidates = [{ anchor: 'F102', kind: 'feature', title: 'Memory', status: 'active', updatedAt: '' }];
    const result = reranker.rerankWithDistances(candidates, []);
    assert.equal(result[0].anchor, 'F102');
  });

  it('returns single candidate unchanged', async () => {
    const { SemanticReranker } = await import('../../dist/domains/memory/SemanticReranker.js');
    const reranker = new SemanticReranker();
    const candidates = [{ anchor: 'F042', kind: 'feature', title: 'Arch', status: 'active', updatedAt: '' }];
    const result = reranker.rerankWithDistances(candidates, [{ anchor: 'F042', distance: 0.5 }]);
    assert.equal(result[0].anchor, 'F042');
  });

  it('preserves original order for no-vec candidates', async () => {
    const { SemanticReranker } = await import('../../dist/domains/memory/SemanticReranker.js');
    const reranker = new SemanticReranker();
    const candidates = [
      { anchor: 'A', kind: 'feature', title: 'A', status: 'active', updatedAt: '' },
      { anchor: 'B', kind: 'feature', title: 'B', status: 'active', updatedAt: '' },
      { anchor: 'C', kind: 'feature', title: 'C', status: 'active', updatedAt: '' },
    ];
    // Only C has a vector; A and B should keep their relative order
    const result = reranker.rerankWithDistances(candidates, [{ anchor: 'C', distance: 0.1 }]);
    assert.equal(result[0].anchor, 'C'); // has vec → first
    assert.equal(result[1].anchor, 'A'); // no vec → original order
    assert.equal(result[2].anchor, 'B');
  });
});
