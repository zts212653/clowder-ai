import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('GraphResolver', () => {
  let GraphResolver;
  let store;

  beforeEach(async () => {
    ({ GraphResolver } = await import('../../dist/domains/memory/GraphResolver.js'));
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  it('builds subgraph centered on anchor with cross-collection edges', async () => {
    await store.upsert([
      {
        anchor: 'project:cat-cafe:doc/f186',
        kind: 'feature',
        status: 'active',
        title: 'F186 Library Memory',
        updatedAt: '2026-05-01',
      },
      { anchor: 'world:lexander:doc/lore-a', kind: 'lore', status: 'active', title: 'Lore A', updatedAt: '2026-05-01' },
    ]);
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/f186',
      toAnchor: 'world:lexander:doc/lore-a',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'world:lexander',
      edgeSensitivity: 'internal',
      provenance: 'frontmatter',
    });

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
    const result = await resolver.buildSubgraph('project:cat-cafe:doc/f186', {
      depth: 1,
      callerCollections: ['project:cat-cafe', 'world:lexander'],
    });

    assert.equal(result.center, 'project:cat-cafe:doc/f186');
    assert.equal(result.depth, 1);
    assert.equal(result.nodes.length, 2);
    assert.equal(result.edges.length, 1);

    const edge = result.edges[0];
    assert.equal(edge.crossCollection, true);
    assert.equal(edge.relation, 'related_to');
    assert.equal(edge.provenance, 'frontmatter');
  });

  it('redacts private nodes when caller lacks access', async () => {
    await store.upsert([
      {
        anchor: 'project:cat-cafe:doc/f186',
        kind: 'feature',
        status: 'active',
        title: 'F186',
        updatedAt: '2026-05-01',
      },
      {
        anchor: 'world:lexander:doc/secret',
        kind: 'lore',
        status: 'active',
        title: 'Secret Lore',
        updatedAt: '2026-05-01',
      },
    ]);
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/f186',
      toAnchor: 'world:lexander:doc/secret',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'world:lexander',
      edgeSensitivity: 'private',
      provenance: 'wikilink',
    });

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
    // Caller only has access to project:cat-cafe, not world:lexander
    const result = await resolver.buildSubgraph('project:cat-cafe:doc/f186', {
      depth: 1,
      callerCollections: ['project:cat-cafe'],
    });

    assert.equal(result.nodes.length, 2);
    const secretNode = result.nodes.find((n) => n.redacted);
    assert.ok(secretNode);
    assert.ok(secretNode.anchor.startsWith('[redacted:'), 'redacted node must use opaque anchor');
    assert.ok(!secretNode.anchor.includes('secret'), 'real anchor must not leak');
    assert.equal(secretNode.title, '[redacted — private collection]');
  });

  it('returns empty graph for unknown anchor', async () => {
    const catalog = { list: () => [], get: () => undefined };
    const resolver = new GraphResolver(catalog, new Map());
    const result = await resolver.buildSubgraph('nonexistent', { depth: 1 });
    assert.equal(result.nodes.length, 0);
    assert.equal(result.edges.length, 0);
  });

  it('resolves non-prefixed anchors via store lookup (P1-1)', async () => {
    await store.upsert([
      { anchor: 'F186', kind: 'feature', status: 'active', title: 'F186 Library Memory', updatedAt: '2026-05-05' },
      { anchor: 'F102', kind: 'feature', status: 'active', title: 'F102 Memory Adapter', updatedAt: '2026-05-05' },
    ]);
    await store.addEdge({
      fromAnchor: 'F186',
      toAnchor: 'F102',
      relation: 'related_to',
      provenance: 'frontmatter',
    });

    const catalog = {
      list: () => [{ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:cat-cafe', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('F186', {
      depth: 1,
      callerCollections: ['project:cat-cafe'],
    });

    assert.equal(result.nodes.length, 2);
    assert.equal(result.center, 'F186');
    assert.equal(result.nodes[0].collectionId, 'project:cat-cafe');
    assert.equal(result.edges.length, 1);
  });

  it('redacts private anchor to opaque ID (P1-3)', async () => {
    await store.upsert([
      {
        anchor: 'project:cat-cafe:doc/f186',
        kind: 'feature',
        status: 'active',
        title: 'F186',
        updatedAt: '2026-05-05',
      },
      {
        anchor: 'world:lexander:doc/Secret-Dragons',
        kind: 'lore',
        status: 'active',
        title: 'Secret Dragons',
        updatedAt: '2026-05-05',
      },
    ]);
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/f186',
      toAnchor: 'world:lexander:doc/Secret-Dragons',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'world:lexander',
      edgeSensitivity: 'private',
      provenance: 'wikilink',
    });

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

    const result = await resolver.buildSubgraph('project:cat-cafe:doc/f186', {
      depth: 1,
      callerCollections: ['project:cat-cafe'],
    });

    const redactedNode = result.nodes.find((n) => n.redacted);
    assert.ok(redactedNode);
    assert.ok(!redactedNode.anchor.includes('lexander'), 'private anchor must not leak');
    assert.ok(!redactedNode.anchor.includes('Secret'), 'private anchor content must not leak');

    const crossEdge = result.edges.find((e) => e.redacted);
    assert.ok(crossEdge);
    assert.ok(!crossEdge.to.includes('lexander'), 'edge endpoint must not leak private anchor');
  });

  it('center field uses opaque anchor for private center node (R2-P1)', async () => {
    await store.upsert([
      { anchor: 'world:lexander:doc/secret', kind: 'lore', status: 'active', title: 'Secret', updatedAt: '2026-05-05' },
    ]);

    const catalog = {
      list: () => [{ id: 'world:lexander', sensitivity: 'private', kind: 'world' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['world:lexander', store]]);

    const resolver = new GraphResolver(catalog, stores);
    const result = await resolver.buildSubgraph('world:lexander:doc/secret', {
      depth: 0,
      callerCollections: [],
    });

    assert.equal(result.nodes.length, 1);
    assert.ok(result.center, 'center should be set');
    assert.ok(!result.center.includes('lexander'), 'center must not leak private anchor');
    assert.ok(result.center.startsWith('[redacted:'), 'center must use opaque anchor');
  });

  it('no duplicate edges for redacted reverse relations (R2-P2)', async () => {
    await store.upsert([
      {
        anchor: 'project:cat-cafe:doc/f186',
        kind: 'feature',
        status: 'active',
        title: 'F186',
        updatedAt: '2026-05-05',
      },
      { anchor: 'world:lexander:doc/secret', kind: 'lore', status: 'active', title: 'Secret', updatedAt: '2026-05-05' },
    ]);
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/f186',
      toAnchor: 'world:lexander:doc/secret',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'world:lexander',
      edgeSensitivity: 'private',
      provenance: 'frontmatter',
    });

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
    const result = await resolver.buildSubgraph('project:cat-cafe:doc/f186', {
      depth: 2,
      callerCollections: ['project:cat-cafe'],
    });

    const relatedEdges = result.edges.filter((e) => e.relation === 'related_to');
    assert.equal(relatedEdges.length, 1, 'reverse edge must be deduped even when one side is redacted');
  });

  it('normalizes legacy related edges in graph output', async () => {
    await store.upsert([
      { anchor: 'project:cat-cafe:doc/a', kind: 'doc', status: 'active', title: 'A', updatedAt: '2026-05-01' },
      { anchor: 'project:cat-cafe:doc/b', kind: 'doc', status: 'active', title: 'B', updatedAt: '2026-05-01' },
    ]);
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/a',
      toAnchor: 'project:cat-cafe:doc/b',
      relation: 'related',
    });

    const catalog = {
      list: () => [{ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }],
      get: () => ({ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }),
    };
    const stores = new Map([['project:cat-cafe', store]]);

    const resolver = new GraphResolver(catalog, stores);
    const result = await resolver.buildSubgraph('project:cat-cafe:doc/a', { depth: 1 });

    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0].relation, 'related_to');
  });
});
