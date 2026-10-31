// F186 Phase A: Collection type contract tests (AC-A1, AC-A4, AC-A6)
// Verifies: CollectionManifest shape, SearchOptions extension, ReviewStatus orthogonality

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F186 Collection contract', () => {
  it('CollectionManifest has required fields and validates', async () => {
    const { COLLECTION_KINDS } = await import('../../dist/domains/memory/interfaces.js');
    assert.deepEqual([...COLLECTION_KINDS], ['project', 'world', 'domain', 'research', 'global']);
  });

  it('CollectionManifest id format is kind:name', async () => {
    const { validateCollectionId } = await import('../../dist/domains/memory/interfaces.js');
    assert.doesNotThrow(() => validateCollectionId('project:cat-cafe'));
    assert.doesNotThrow(() => validateCollectionId('world:lexander'));
    assert.doesNotThrow(() => validateCollectionId('global:methods'));
    assert.throws(() => validateCollectionId('invalid-no-colon'), /format/);
    assert.throws(() => validateCollectionId(''), /format/);
    assert.throws(() => validateCollectionId('Project:CamelCase'), /format/);
  });

  it('SearchOptions.dimension includes library and collection', async () => {
    const { SEARCH_DIMENSIONS } = await import('../../dist/domains/memory/interfaces.js');
    assert.ok(SEARCH_DIMENSIONS.includes('library'), 'missing library');
    assert.ok(SEARCH_DIMENSIONS.includes('collection'), 'missing collection');
    assert.ok(SEARCH_DIMENSIONS.includes('project'), 'missing legacy project');
    assert.ok(SEARCH_DIMENSIONS.includes('global'), 'missing legacy global');
    assert.ok(SEARCH_DIMENSIONS.includes('all'), 'missing legacy all');
  });

  it('ReviewStatus values are orthogonal to ProvenanceTier and F163Authority', async () => {
    const { REVIEW_STATUSES, MARKER_STATUSES } = await import('../../dist/domains/memory/interfaces.js');
    assert.ok(Array.isArray(REVIEW_STATUSES), 'REVIEW_STATUSES must be an array');
    assert.ok(REVIEW_STATUSES.length >= 4, 'REVIEW_STATUSES must have at least 4 values');
    const reviewSet = new Set(REVIEW_STATUSES);
    // ProvenanceTier values
    const provenance = ['authoritative', 'derived', 'soft_clue'];
    // F163 Authority values
    const authority = ['constitutional', 'validated', 'candidate', 'observed'];

    for (const p of provenance) {
      assert.ok(!reviewSet.has(p), `ReviewStatus collides with ProvenanceTier "${p}"`);
    }
    for (const a of authority) {
      assert.ok(!reviewSet.has(a), `ReviewStatus collides with F163Authority "${a}"`);
    }
    // Also not collide with MarkerStatus
    for (const m of MARKER_STATUSES) {
      assert.ok(!reviewSet.has(m), `ReviewStatus collides with MarkerStatus "${m}"`);
    }
  });

  it('COLLECTION_SENSITIVITY_ORDER defines privacy ordering', async () => {
    const { COLLECTION_SENSITIVITY_ORDER } = await import('../../dist/domains/memory/interfaces.js');
    assert.ok(COLLECTION_SENSITIVITY_ORDER.restricted < COLLECTION_SENSITIVITY_ORDER.private);
    assert.ok(COLLECTION_SENSITIVITY_ORDER.private < COLLECTION_SENSITIVITY_ORDER.internal);
    assert.ok(COLLECTION_SENSITIVITY_ORDER.internal < COLLECTION_SENSITIVITY_ORDER.public);
  });
});
