import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('memory interfaces — type exports', () => {
  it('exports all 6 interface guard symbols', async () => {
    const mod = await import('../../dist/domains/memory/interfaces.js');

    // Guard symbols for runtime interface checking
    assert.ok(mod.IEvidenceStoreSymbol, 'IEvidenceStore guard');
    assert.ok(mod.IIndexBuilderSymbol, 'IIndexBuilder guard');
    assert.ok(mod.IMarkerQueueSymbol, 'IMarkerQueue guard');
    assert.ok(mod.IMaterializationServiceSymbol, 'IMaterializationService guard');
    assert.ok(mod.IReflectionServiceSymbol, 'IReflectionService guard');
    assert.ok(mod.IKnowledgeResolverSymbol, 'IKnowledgeResolver guard');
  });

  it('exports MarkerStatus values', async () => {
    const mod = await import('../../dist/domains/memory/interfaces.js');

    assert.deepEqual(mod.MARKER_STATUSES, [
      'captured',
      'normalized',
      'approved',
      'rejected',
      'needs_review',
      'materialized',
      'indexed',
    ]);
  });

  it('exports EvidenceKind values', async () => {
    const mod = await import('../../dist/domains/memory/interfaces.js');

    assert.deepEqual(mod.EVIDENCE_KINDS, [
      'feature',
      'decision',
      'plan',
      'session',
      'lesson',
      'thread',
      'discussion',
      'research',
      'pack-knowledge',
    ]);
  });
});
