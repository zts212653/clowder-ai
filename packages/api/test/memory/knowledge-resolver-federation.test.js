// F186 Phase A Task 3: KnowledgeResolver N-collection federation
// Covers AC-A2 (N-store fan-out), AC-A5 (collectionGroups in result)

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function mockStore(items) {
  return {
    search: async () => items,
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    health: async () => true,
    initialize: async () => {},
  };
}

function item(anchor, title) {
  return { anchor, kind: 'feature', status: 'active', title, updatedAt: '2026-05-03' };
}

describe('KnowledgeResolver N-collection federation', () => {
  let KnowledgeResolver, LibraryCatalog;

  beforeEach(async () => {
    ({ KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
  });

  function manifest(id, kind, sensitivity) {
    return {
      id,
      kind,
      name: id.split(':')[1],
      displayName: id,
      root: '/tmp',
      sensitivity,
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    };
  }

  it('dimension=library fans out to non-private collections', async () => {
    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:a', 'project', 'internal'));
    catalog.register(manifest('world:secret', 'world', 'private'));
    catalog.register(manifest('global:g', 'global', 'public'));

    const stores = new Map();
    stores.set('project:a', mockStore([item('p1', 'Project hit')]));
    stores.set('world:secret', mockStore([item('w1', 'Secret hit')]));
    stores.set('global:g', mockStore([item('g1', 'Global hit')]));

    const resolver = new KnowledgeResolver({
      projectStore: mockStore([]),
      catalog,
      stores,
    });

    const result = await resolver.resolve('test', { dimension: 'library' });
    const anchors = result.results.map((r) => r.anchor);
    assert.ok(anchors.includes('p1'), 'should include project:a items');
    assert.ok(anchors.includes('g1'), 'should include global:g items');
    assert.ok(!anchors.includes('w1'), 'should NOT include private world items');
    assert.ok(result.collectionGroups, 'should have collectionGroups');
    assert.equal(result.collectionGroups.length, 2);
  });

  it('dimension=collection routes to explicit IDs regardless of sensitivity', async () => {
    const catalog = new LibraryCatalog();
    catalog.register(manifest('world:secret', 'world', 'private'));

    const stores = new Map();
    stores.set('world:secret', mockStore([item('w1', 'Secret')]));

    const resolver = new KnowledgeResolver({
      projectStore: mockStore([]),
      catalog,
      stores,
    });

    const result = await resolver.resolve('test', {
      dimension: 'collection',
      collections: ['world:secret'],
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].anchor, 'w1');
    assert.ok(result.collectionGroups);
    assert.equal(result.collectionGroups[0].collectionId, 'world:secret');
    assert.equal(result.collectionGroups[0].status, 'ok');
  });

  it('collectionGroups include per-collection metadata', async () => {
    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:a', 'project', 'internal'));
    catalog.register(manifest('global:g', 'global', 'public'));

    const stores = new Map();
    stores.set('project:a', mockStore([item('p1', 'P')]));
    stores.set('global:g', mockStore([item('g1', 'G')]));

    const resolver = new KnowledgeResolver({
      projectStore: mockStore([]),
      catalog,
      stores,
    });

    const result = await resolver.resolve('test', { dimension: 'library' });
    for (const group of result.collectionGroups) {
      assert.ok(typeof group.durationMs === 'number');
      assert.ok(group.sensitivity);
      assert.ok(['ok', 'timeout', 'skipped', 'error'].includes(group.status));
    }
  });

  it('RRF fuses results across N collections', async () => {
    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:a', 'project', 'internal'));
    catalog.register(manifest('domain:d', 'domain', 'internal'));

    const stores = new Map();
    stores.set('project:a', mockStore([item('shared', 'From project'), item('p-only', 'P')]));
    stores.set('domain:d', mockStore([item('shared', 'From domain'), item('d-only', 'D')]));

    const resolver = new KnowledgeResolver({
      projectStore: mockStore([]),
      catalog,
      stores,
    });

    const result = await resolver.resolve('test', { dimension: 'library', limit: 10 });
    assert.equal(result.results[0].anchor, 'shared', 'shared item should rank highest via RRF');
    assert.equal(result.results.length, 3);
  });

  it('legacy dimension=all still works without catalog', async () => {
    const proj = mockStore([item('p1', 'Project')]);
    const glob = mockStore([item('g1', 'Global')]);
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });
    const result = await resolver.resolve('test', { dimension: 'all' });
    assert.ok(result.results.length >= 2);
    assert.ok(!result.collectionGroups, 'legacy path should not have collectionGroups');
  });

  it('fails closed for library/collection dimensions when catalog is unavailable (cloud R4 P2)', async () => {
    const proj = mockStore([item('p1', 'Project')]);
    const glob = mockStore([item('g1', 'Global')]);
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });

    const libraryResult = await resolver.resolve('test', { dimension: 'library' });
    assert.equal(libraryResult.results.length, 0);
    assert.deepEqual(libraryResult.sources, []);
    assert.deepEqual(libraryResult.collectionGroups, []);

    const collectionResult = await resolver.resolve('test', {
      dimension: 'collection',
      collections: ['project:a'],
    });
    assert.equal(collectionResult.results.length, 0);
    assert.deepEqual(collectionResult.sources, []);
    assert.deepEqual(collectionResult.collectionGroups, []);
  });

  it('store error produces error status in collectionGroup', async () => {
    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:a', 'project', 'internal'));
    catalog.register(manifest('global:broken', 'global', 'public'));

    const stores = new Map();
    stores.set('project:a', mockStore([item('p1', 'P')]));
    stores.set('global:broken', {
      search: async () => {
        throw new Error('db locked');
      },
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => false,
      initialize: async () => {},
    });

    const resolver = new KnowledgeResolver({
      projectStore: mockStore([]),
      catalog,
      stores,
    });

    const result = await resolver.resolve('test', { dimension: 'library' });
    assert.ok(result.collectionGroups);
    const broken = result.collectionGroups.find((g) => g.collectionId === 'global:broken');
    assert.equal(broken?.status, 'error');
    assert.equal(broken?.items.length, 0);
    assert.equal(result.results.length, 1, 'only project:a items survive');
  });

  it('registered collection without store gets status=skipped (P1-4 fix)', async () => {
    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:a', 'project', 'internal'));
    catalog.register(manifest('domain:orphan', 'domain', 'public'));

    const stores = new Map();
    stores.set('project:a', mockStore([item('p1', 'P')]));
    // domain:orphan has NO store entry

    const resolver = new KnowledgeResolver({
      projectStore: mockStore([]),
      catalog,
      stores,
    });

    const result = await resolver.resolve('test', { dimension: 'library' });
    const orphan = result.collectionGroups.find((g) => g.collectionId === 'domain:orphan');
    assert.equal(orphan?.status, 'skipped', 'missing store should be skipped, not ok');
    assert.equal(orphan?.items.length, 0);
    const ok = result.collectionGroups.find((g) => g.collectionId === 'project:a');
    assert.equal(ok?.status, 'ok');
  });
});
