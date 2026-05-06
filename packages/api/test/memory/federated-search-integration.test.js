// F186 Phase A Task 10: End-to-end federated search integration test
// Uses real SqliteEvidenceStore instances (not mocks) to verify the full stack:
// LibraryCatalog → KnowledgeResolver → N-collection fan-out → RRF fusion → privacy redaction

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('Federated search integration (real SQLite stores)', () => {
  let KnowledgeResolver, LibraryCatalog, SqliteEvidenceStore;

  before(async () => {
    ({ KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
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

  function doc(anchor, title, kind = 'feature') {
    return { anchor, kind, status: 'active', title, updatedAt: '2026-05-03' };
  }

  async function makeStore(items) {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    if (items.length > 0) await store.upsert(items);
    return store;
  }

  it('dimension=library returns results from multiple real stores with collectionGroups', async () => {
    const projectStore = await makeStore([
      doc('proj-arch', 'Architecture design document'),
      doc('proj-api', 'API endpoint specification'),
    ]);
    const domainStore = await makeStore([
      doc('dom-lore', 'World lore compendium'),
      doc('dom-char', 'Character backstory archive'),
    ]);

    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:main', 'project', 'internal'));
    catalog.register(manifest('domain:world', 'domain', 'public'));

    const stores = new Map();
    stores.set('project:main', projectStore);
    stores.set('domain:world', domainStore);

    const resolver = new KnowledgeResolver({ projectStore, catalog, stores });
    const result = await resolver.resolve('document', { dimension: 'library' });

    assert.ok(result.results.length > 0, 'should have results');
    assert.ok(result.collectionGroups, 'should have collectionGroups');
    assert.equal(result.collectionGroups.length, 2, 'should have 2 collection groups');

    const projectGroup = result.collectionGroups.find((g) => g.collectionId === 'project:main');
    const domainGroup = result.collectionGroups.find((g) => g.collectionId === 'domain:world');
    assert.ok(projectGroup, 'project group should exist');
    assert.ok(domainGroup, 'domain group should exist');
    assert.equal(projectGroup.status, 'ok');
    assert.equal(domainGroup.status, 'ok');
  });

  it('dimension=collection routes to a single explicit store', async () => {
    const storeA = await makeStore([doc('a-1', 'Alpha feature')]);
    const storeB = await makeStore([doc('b-1', 'Beta feature')]);

    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:alpha', 'project', 'internal'));
    catalog.register(manifest('project:beta', 'project', 'internal'));

    const stores = new Map();
    stores.set('project:alpha', storeA);
    stores.set('project:beta', storeB);

    const resolver = new KnowledgeResolver({ projectStore: storeA, catalog, stores });
    const result = await resolver.resolve('feature', {
      dimension: 'collection',
      collections: ['project:beta'],
    });

    assert.ok(result.collectionGroups, 'should have collectionGroups');
    assert.equal(result.collectionGroups.length, 1);
    assert.equal(result.collectionGroups[0].collectionId, 'project:beta');
    const anchors = result.results.map((r) => r.anchor);
    assert.ok(anchors.includes('b-1'), 'should include beta results');
    assert.ok(!anchors.includes('a-1'), 'should NOT include alpha results');
  });

  it('private collection results are redacted in library dimension', async () => {
    const publicStore = await makeStore([doc('pub-1', 'Public knowledge base')]);
    const privateStore = await makeStore([doc('priv-1', 'Secret internal memo')]);

    const catalog = new LibraryCatalog();
    catalog.register(manifest('global:pub', 'global', 'public'));
    catalog.register(manifest('world:secret', 'world', 'private'));

    const stores = new Map();
    stores.set('global:pub', publicStore);
    stores.set('world:secret', privateStore);

    const resolver = new KnowledgeResolver({
      projectStore: publicStore,
      catalog,
      stores,
    });

    const result = await resolver.resolve('knowledge', { dimension: 'library' });
    // library dimension excludes private collections from routing
    const groupIds = result.collectionGroups.map((g) => g.collectionId);
    assert.ok(!groupIds.includes('world:secret'), 'private collection should be excluded from library');
    assert.ok(groupIds.includes('global:pub'), 'public collection should be included');
  });

  it('dimension=collection with private store returns redacted items', async () => {
    const privateStore = await makeStore([doc('priv-1', 'Confidential strategy document')]);

    const catalog = new LibraryCatalog();
    catalog.register(manifest('world:restricted', 'world', 'restricted'));

    const stores = new Map();
    stores.set('world:restricted', privateStore);

    const resolver = new KnowledgeResolver({
      projectStore: await makeStore([]),
      catalog,
      stores,
    });

    const result = await resolver.resolve('strategy', {
      dimension: 'collection',
      collections: ['world:restricted'],
    });

    assert.ok(result.collectionGroups);
    assert.equal(result.collectionGroups[0].collectionId, 'world:restricted');
    const item = result.collectionGroups[0].items[0];
    assert.ok(item, 'should have redacted item');
    assert.ok(item.title.includes('[redacted'), 'title should be redacted');
    assert.equal(item.anchor, 'priv-1', 'anchor should be preserved');
    assert.equal(item.summary, undefined, 'summary should be stripped');
  });

  it('RRF fuses overlapping anchors from multiple real stores', async () => {
    const storeA = await makeStore([
      doc('shared-doc', 'Shared architecture document'),
      doc('only-a', 'Alpha-only document'),
    ]);
    const storeB = await makeStore([
      doc('shared-doc', 'Shared architecture document'),
      doc('only-b', 'Beta-only document'),
    ]);

    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:a', 'project', 'internal'));
    catalog.register(manifest('project:b', 'project', 'internal'));

    const stores = new Map();
    stores.set('project:a', storeA);
    stores.set('project:b', storeB);

    const resolver = new KnowledgeResolver({ projectStore: storeA, catalog, stores });
    const result = await resolver.resolve('document', { dimension: 'library', limit: 10 });

    const anchors = result.results.map((r) => r.anchor);
    assert.ok(anchors.includes('shared-doc'), 'shared doc should appear in fused results');
    // RRF: shared-doc has scores from both lists → should rank highest
    assert.equal(result.results[0].anchor, 'shared-doc', 'shared doc should rank first via RRF');
    // Deduplication: shared-doc appears once, not twice
    const sharedCount = anchors.filter((a) => a === 'shared-doc').length;
    assert.equal(sharedCount, 1, 'shared doc should appear exactly once (deduplicated)');
    assert.equal(result.results.length, 3, 'should have 3 unique results total');
  });

  it('legacy dimension=all works without catalog (backwards compat)', async () => {
    const projectStore = await makeStore([doc('p-1', 'Project feature doc')]);
    const globalStore = await makeStore([doc('g-1', 'Global method doc')]);

    const resolver = new KnowledgeResolver({ projectStore, globalStore });
    const result = await resolver.resolve('doc', { dimension: 'all' });

    assert.ok(result.results.length >= 2, 'should have results from both stores');
    assert.ok(!result.collectionGroups, 'legacy path should not produce collectionGroups');
    const anchors = result.results.map((r) => r.anchor);
    assert.ok(anchors.includes('p-1'));
    assert.ok(anchors.includes('g-1'));
  });
});
