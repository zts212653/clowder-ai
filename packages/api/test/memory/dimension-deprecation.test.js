import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('OQ-3 dimension:all deprecation + OQ-4 promoted_from', () => {
  let KnowledgeResolver;
  let SqliteEvidenceStore;
  let store;
  let resolver;

  beforeEach(async () => {
    ({ KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    resolver = new KnowledgeResolver({ projectStore: store });
  });

  it('returns deprecationWarnings when dimension=all is used', async () => {
    const result = await resolver.resolve('test', { dimension: 'all' });
    assert.ok(result.deprecationWarnings);
    assert.ok(result.deprecationWarnings.length > 0);
    assert.ok(result.deprecationWarnings.some((w) => w.includes('dimension')));
  });

  it('does not return deprecationWarnings for dimension=library', async () => {
    const catalog = {
      list: () => [],
      get: () => undefined,
      getRoutable: () => [],
    };
    const resolverWithCatalog = new KnowledgeResolver({
      projectStore: store,
      catalog,
      stores: new Map(),
    });
    const result = await resolverWithCatalog.resolve('test', { dimension: 'library' });
    assert.equal(result.deprecationWarnings, undefined);
  });

  it('does not return deprecationWarnings for dimension=project', async () => {
    const result = await resolver.resolve('test', { dimension: 'project' });
    assert.equal(result.deprecationWarnings, undefined);
  });

  it('promoted_from edge type accepted and retrievable', async () => {
    await store.addEdge({
      fromAnchor: 'world:lexander:doc/lesson',
      toAnchor: 'global:methods:doc/promoted-lesson',
      relation: 'promoted_from',
      fromCollectionId: 'world:lexander',
      toCollectionId: 'global:methods',
      edgeSensitivity: 'internal',
      provenance: 'promote',
    });
    const related = await store.getRelated('global:methods:doc/promoted-lesson');
    assert.equal(related.length, 1);
    assert.equal(related[0].relation, 'promoted_from');
    assert.equal(related[0].provenance, 'promote');
  });
});
