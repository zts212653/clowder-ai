import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F186 Phase F integration: graph pipeline + sensitivity', () => {
  let store;
  let GraphResolver;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    ({ GraphResolver } = await import('../../dist/domains/memory/GraphResolver.js'));
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  it('full pipeline: index → edges → graph → sensitivity filtering', async () => {
    // 1. Upsert docs across two collections
    await store.upsert([
      {
        anchor: 'project:cat-cafe:doc/f186',
        kind: 'feature',
        status: 'active',
        title: 'F186 Library Memory',
        updatedAt: '2026-05-05',
      },
      {
        anchor: 'project:cat-cafe:doc/f102',
        kind: 'feature',
        status: 'active',
        title: 'F102 Memory Adapter',
        updatedAt: '2026-05-05',
      },
      {
        anchor: 'world:lexander:doc/spell-book',
        kind: 'lore',
        status: 'active',
        title: 'Ancient Spell Book',
        updatedAt: '2026-05-05',
      },
    ]);

    // 2. Create edges: internal cross-ref + cross-collection
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/f186',
      toAnchor: 'project:cat-cafe:doc/f102',
      relation: 'evolved_from',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'frontmatter',
    });
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/f186',
      toAnchor: 'world:lexander:doc/spell-book',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'world:lexander',
      edgeSensitivity: 'private',
      provenance: 'wikilink',
    });

    // 3. Build graph — caller has both collections
    const catalog = {
      list: () => [
        { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'world:lexander', sensitivity: 'private', kind: 'world' },
      ],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([
      ['project:cat-cafe', store],
      ['world:lexander', store],
    ]);
    const resolver = new GraphResolver(catalog, stores);

    const fullResult = await resolver.buildSubgraph('project:cat-cafe:doc/f186', {
      depth: 1,
      callerCollections: ['project:cat-cafe', 'world:lexander'],
    });

    assert.equal(fullResult.nodes.length, 3);
    assert.equal(fullResult.edges.length, 2);
    assert.equal(fullResult.center, 'project:cat-cafe:doc/f186');

    const spellNode = fullResult.nodes.find((n) => n.anchor === 'world:lexander:doc/spell-book');
    assert.ok(spellNode);
    assert.equal(spellNode.redacted, false);
    assert.equal(spellNode.title, 'Ancient Spell Book');

    const crossEdge = fullResult.edges.find((e) => e.to === 'world:lexander:doc/spell-book');
    assert.ok(crossEdge);
    assert.equal(crossEdge.crossCollection, true);

    // 4. Build graph — caller only has project:cat-cafe → private nodes redacted
    const restrictedResult = await resolver.buildSubgraph('project:cat-cafe:doc/f186', {
      depth: 1,
      callerCollections: ['project:cat-cafe'],
    });

    assert.equal(restrictedResult.nodes.length, 3);
    const redactedNode = restrictedResult.nodes.find((n) => n.redacted);
    assert.ok(redactedNode);
    assert.ok(redactedNode.anchor.startsWith('[redacted:'), 'redacted node must use opaque anchor');
    assert.ok(!redactedNode.anchor.includes('lexander'), 'private anchor must not leak');
    assert.equal(redactedNode.title, '[redacted — private collection]');

    // 5. Verify related normalization
    const related = await store.getRelated('project:cat-cafe:doc/f186');
    assert.ok(related.every((r) => r.relation !== 'related'));
  });

  it('RecallPersistenceRedactor strips private items', async () => {
    const { redactGroupsForPersistence } = await import('../../dist/domains/memory/RecallPersistenceRedactor.js');
    const groups = [
      {
        collectionId: 'world:lexander',
        sensitivity: 'private',
        status: 'ok',
        durationMs: 1,
        items: [
          {
            anchor: 'world:lexander:doc/secret',
            title: 'Secret',
            kind: 'lore',
            status: 'active',
            updatedAt: '2026-05-05',
          },
        ],
      },
    ];
    const result = redactGroupsForPersistence(groups);
    assert.equal(result[0].items[0].title, '[redacted — private collection]');
    assert.equal(result[0].items[0].anchor, 'world:lexander:doc/secret');
  });

  it('KnowledgeResolver redacts private collection titles in groups (P1-2)', async () => {
    const { KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js');
    await store.upsert([
      { anchor: 'secret-doc', kind: 'lore', status: 'active', title: 'Secret Dragon Lore', updatedAt: '2026-05-05' },
    ]);
    const manifest = { id: 'world:lexander', sensitivity: 'private', kind: 'world' };
    const catalog = {
      list: () => [manifest],
      get: (id) => (id === manifest.id ? manifest : undefined),
      getRoutable: (_dim, collections) =>
        (collections ?? []).map((c) => (c === manifest.id ? manifest : undefined)).filter(Boolean),
    };
    const stores = new Map([['world:lexander', store]]);
    const resolver = new KnowledgeResolver({ projectStore: store, catalog, stores });
    const result = await resolver.resolve('secret', { dimension: 'collection', collections: ['world:lexander'] });
    assert.ok(result.collectionGroups);
    const group = result.collectionGroups.find((g) => g.collectionId === 'world:lexander');
    assert.ok(group);
    assert.ok(group.items.length > 0);
    assert.equal(group.items[0].title, '[redacted — private collection]');
  });

  it('dimension:all returns deprecation warning', async () => {
    const { KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js');
    const resolver = new KnowledgeResolver({ projectStore: store });
    const result = await resolver.resolve('test', { dimension: 'all' });
    assert.ok(result.deprecationWarnings);
    assert.ok(result.deprecationWarnings[0].includes('deprecated'));
  });

  it('deprecation warnings included in search response shape (P2)', async () => {
    const { KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js');
    const resolver = new KnowledgeResolver({ projectStore: store });
    const result = await resolver.resolve('test', { dimension: 'all' });
    assert.ok(result.deprecationWarnings);
    assert.ok(Array.isArray(result.deprecationWarnings));
    assert.equal(typeof result.deprecationWarnings[0], 'string');
  });
});
