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

  it('canonicalizes case-insensitive anchor matches before fetching edges', async () => {
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

    const result = await resolver.buildSubgraph('f186', {
      depth: 1,
      callerCollections: ['project:cat-cafe'],
    });

    assert.equal(result.center, 'F186');
    assert.ok(result.nodes.some((n) => n.anchor === 'F186'));
    assert.ok(!result.nodes.some((n) => n.anchor === 'f186'));
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0].from, 'F186');
    assert.equal(result.edges[0].to, 'F102');
  });

  it('canonicalizes related edge endpoints before emitting graph edges', async () => {
    await store.upsert([
      { anchor: 'F102', kind: 'feature', status: 'active', title: 'F102 Memory Adapter', updatedAt: '2026-05-05' },
      { anchor: 'F186', kind: 'feature', status: 'active', title: 'F186 Library Memory', updatedAt: '2026-05-05' },
    ]);
    await store.addEdge({
      fromAnchor: 'F102',
      toAnchor: 'f186',
      relation: 'related_to',
      provenance: 'frontmatter',
    });

    const catalog = {
      list: () => [{ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:cat-cafe', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('F102', {
      depth: 1,
      callerCollections: ['project:cat-cafe'],
    });

    const nodeAnchors = new Set(result.nodes.map((n) => n.anchor));
    assert.ok(nodeAnchors.has('F186'));
    assert.ok(!nodeAnchors.has('f186'));
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0].from, 'F102');
    assert.equal(result.edges[0].to, 'F186');
    assert.ok(nodeAnchors.has(result.edges[0].to), 'edge target must match an emitted node anchor');
  });

  it('uses raw related-anchor aliases for multi-hop expansion after canonicalizing output', async () => {
    await store.upsert([
      { anchor: 'F102', kind: 'feature', status: 'active', title: 'F102 Memory Adapter', updatedAt: '2026-05-05' },
      { anchor: 'F186', kind: 'feature', status: 'active', title: 'F186 Library Memory', updatedAt: '2026-05-05' },
      { anchor: 'F300', kind: 'feature', status: 'active', title: 'F300 Follow-up', updatedAt: '2026-05-05' },
    ]);
    await store.addEdge({
      fromAnchor: 'F102',
      toAnchor: 'f186',
      relation: 'related_to',
      provenance: 'frontmatter',
    });
    await store.addEdge({
      fromAnchor: 'f186',
      toAnchor: 'F300',
      relation: 'feature_ref',
      provenance: 'content',
    });

    const catalog = {
      list: () => [{ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:cat-cafe', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('F102', {
      depth: 2,
      callerCollections: ['project:cat-cafe'],
    });

    const nodeAnchors = new Set(result.nodes.map((n) => n.anchor));
    assert.ok(nodeAnchors.has('F186'));
    assert.ok(nodeAnchors.has('F300'), 'second-hop node stored under raw alias must be discovered');
    assert.ok(!nodeAnchors.has('f186'));
    assert.ok(
      result.edges.some((edge) => edge.from === 'F186' && edge.to === 'F300' && edge.relation === 'feature_ref'),
      'second-hop edge must be emitted with canonical endpoints',
    );
  });

  it('does not use raw aliases to pull unrelated edges from another store', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const otherStore = new SqliteEvidenceStore(':memory:');
    await otherStore.initialize();

    await store.upsert([
      { anchor: 'F102', kind: 'feature', status: 'active', title: 'F102 Memory Adapter', updatedAt: '2026-05-05' },
      { anchor: 'F186', kind: 'feature', status: 'active', title: 'F186 Library Memory', updatedAt: '2026-05-05' },
      { anchor: 'F300', kind: 'feature', status: 'active', title: 'F300 Follow-up', updatedAt: '2026-05-05' },
    ]);
    await store.addEdge({
      fromAnchor: 'F102',
      toAnchor: 'f186',
      relation: 'related_to',
      provenance: 'frontmatter',
    });
    await store.addEdge({
      fromAnchor: 'f186',
      toAnchor: 'F300',
      relation: 'feature_ref',
      provenance: 'content',
    });

    await otherStore.upsert([
      {
        anchor: 'f186',
        kind: 'lore',
        status: 'active',
        title: 'Unrelated lowercase lore anchor',
        updatedAt: '2026-05-05',
      },
      { anchor: 'WORLD-SECRET', kind: 'lore', status: 'active', title: 'World secret', updatedAt: '2026-05-05' },
    ]);
    await otherStore.addEdge({
      fromAnchor: 'f186',
      toAnchor: 'WORLD-SECRET',
      relation: 'related_to',
      provenance: 'manual',
    });

    const catalog = {
      list: () => [
        { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'world:lexander', sensitivity: 'internal', kind: 'world' },
      ],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([
      ['project:cat-cafe', store],
      ['world:lexander', otherStore],
    ]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('F102', {
      depth: 2,
      callerCollections: ['project:cat-cafe', 'world:lexander'],
    });

    const nodeAnchors = new Set(result.nodes.map((n) => n.anchor));
    assert.ok(nodeAnchors.has('F300'));
    assert.ok(!nodeAnchors.has('WORLD-SECRET'), 'alias from project graph must not pull unrelated world edge');
    assert.ok(
      !result.edges.some((edge) => edge.to === 'WORLD-SECRET' || edge.from === 'WORLD-SECRET'),
      'unrelated world edge must not be emitted through project alias lookup',
    );
  });

  it('keeps cross-store related edges when center collection is selected', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const worldStore = new SqliteEvidenceStore(':memory:');
    await worldStore.initialize();

    await store.upsert([
      { anchor: 'F301', kind: 'discussion', status: 'active', title: 'Project Harness', updatedAt: '2026-05-09' },
    ]);
    await worldStore.upsert([
      { anchor: 'W001', kind: 'lore', status: 'active', title: 'World Harness Note', updatedAt: '2026-05-09' },
      { anchor: 'W002', kind: 'lore', status: 'active', title: 'Incoming World Note', updatedAt: '2026-05-09' },
      { anchor: 'W003', kind: 'lore', status: 'active', title: 'Partial Metadata Note', updatedAt: '2026-05-09' },
    ]);
    await worldStore.addEdge({
      fromAnchor: 'F301',
      toAnchor: 'W001',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'world:lexander',
      edgeSensitivity: 'internal',
      provenance: 'content',
    });
    await worldStore.addEdge({
      fromAnchor: 'W002',
      toAnchor: 'F301',
      relation: 'related_to',
      fromCollectionId: 'world:lexander',
      toCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'content',
    });
    await worldStore.addEdge({
      fromAnchor: 'W003',
      toAnchor: 'F301',
      relation: 'related_to',
      fromCollectionId: 'world:lexander',
      edgeSensitivity: 'internal',
      provenance: 'content',
    });

    const catalog = {
      list: () => [
        { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'world:lexander', sensitivity: 'internal', kind: 'world' },
      ],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([
      ['project:cat-cafe', store],
      ['world:lexander', worldStore],
    ]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('F301', {
      depth: 1,
      centerCollectionId: 'project:cat-cafe',
      callerCollections: ['project:cat-cafe', 'world:lexander'],
    });

    assert.equal(result.center, 'F301');
    assert.ok(result.nodes.some((node) => node.anchor === 'W001'));
    assert.ok(result.nodes.some((node) => node.anchor === 'W002'));
    assert.ok(result.nodes.some((node) => node.anchor === 'W003'));
    assert.ok(
      result.edges.some((edge) => edge.from === 'F301' && edge.to === 'W001' && edge.relation === 'related_to'),
      'edge stored outside the center collection must still be emitted',
    );
    assert.ok(
      result.edges.some((edge) => edge.from === 'F301' && edge.to === 'W002' && edge.relation === 'related_to'),
      'incoming edge stored outside the center collection must still be emitted',
    );
    assert.ok(
      result.edges.some((edge) => edge.from === 'F301' && edge.to === 'W003' && edge.relation === 'related_to'),
      'partially tagged incoming edge must still be emitted',
    );
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

  it('shows unresolved node instead of silently skipping (AC-C0b)', async () => {
    await store.upsert([
      { anchor: 'F186', kind: 'feature', status: 'active', title: 'F186 Library', updatedAt: '2026-05-07' },
    ]);
    await store.addEdge({
      fromAnchor: 'F186',
      toAnchor: 'F999',
      relation: 'feature_ref',
      provenance: 'content',
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

    assert.equal(result.nodes.length, 2, 'unresolved anchor must appear as node');
    const unresolved = result.nodes.find((n) => n.anchor === 'F999');
    assert.ok(unresolved, 'F999 must not be silently dropped');
    assert.equal(unresolved.kind, 'unresolved');
    assert.equal(unresolved.collectionId, '');
    assert.equal(result.edges.length, 1);
  });

  it('redacts unresolved anchors reached through private edges (cloud-P1)', async () => {
    await store.upsert([
      {
        anchor: 'world:lexander:doc/secret',
        kind: 'lore',
        status: 'active',
        title: 'Secret Doc',
        updatedAt: '2026-05-08',
      },
    ]);
    await store.addEdge({
      fromAnchor: 'world:lexander:doc/secret',
      toAnchor: 'SecretCodename',
      relation: 'wikilink',
      fromCollectionId: 'world:lexander',
      edgeSensitivity: 'private',
      provenance: 'content',
    });

    const catalog = {
      list: () => [{ id: 'world:lexander', sensitivity: 'private', kind: 'world' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['world:lexander', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('world:lexander:doc/secret', {
      depth: 1,
      callerCollections: [],
    });

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('SecretCodename'), 'private unresolved anchor must not leak');
    const unresolved = result.nodes.find((n) => n.kind === 'unresolved');
    assert.ok(unresolved, 'redacted unresolved placeholder should still be present');
    assert.equal(unresolved.redacted, true);
    assert.ok(unresolved.anchor.startsWith('[redacted:'), 'unresolved anchor should use opaque anchor');
    assert.ok(result.edges[0].to.startsWith('[redacted:'), 'edge endpoint should use same opaque anchor');
  });

  it('keeps unresolved edge endpoints opaque across mixed sensitivities (cloud-R2-P1)', async () => {
    await store.upsert([
      {
        anchor: 'project:cat-cafe:doc/root',
        kind: 'feature',
        status: 'active',
        title: 'Root',
        updatedAt: '2026-05-08',
      },
      {
        anchor: 'alpha:secret:doc/private',
        kind: 'lore',
        status: 'active',
        title: 'Private',
        updatedAt: '2026-05-08',
      },
      {
        anchor: 'project:cat-cafe:doc/public',
        kind: 'feature',
        status: 'active',
        title: 'Public',
        updatedAt: '2026-05-08',
      },
    ]);
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/root',
      toAnchor: 'project:cat-cafe:doc/public',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'frontmatter',
    });
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/root',
      toAnchor: 'alpha:secret:doc/private',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'alpha:secret',
      edgeSensitivity: 'internal',
      provenance: 'frontmatter',
    });
    await store.addEdge({
      fromAnchor: 'alpha:secret:doc/private',
      toAnchor: 'SecretCodename',
      relation: 'wikilink',
      fromCollectionId: 'alpha:secret',
      edgeSensitivity: 'private',
      provenance: 'content',
    });
    await store.addEdge({
      fromAnchor: 'project:cat-cafe:doc/public',
      toAnchor: 'SecretCodename',
      relation: 'wikilink',
      fromCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'content',
    });

    const catalog = {
      list: () => [
        { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'alpha:secret', sensitivity: 'private', kind: 'world' },
      ],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([
      ['project:cat-cafe', store],
      ['alpha:secret', store],
    ]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('project:cat-cafe:doc/root', {
      depth: 2,
      callerCollections: ['project:cat-cafe'],
    });

    const unresolved = result.nodes.find((n) => n.kind === 'unresolved');
    assert.ok(unresolved, 'redacted unresolved placeholder should be present');
    assert.equal(unresolved.redacted, true);
    assert.ok(unresolved.anchor.startsWith('[redacted:'), 'unresolved node should use opaque anchor');
    assert.ok(
      !JSON.stringify(result).includes('SecretCodename'),
      'mixed sensitivity traversal must not leak raw anchor',
    );

    const unresolvedEdges = result.edges.filter((e) => e.relation === 'wikilink');
    assert.ok(unresolvedEdges.length >= 2, 'both private and public wikilinks should be present');
    assert.ok(
      unresolvedEdges.every((e) => e.to === unresolved.anchor),
      'all edges to the redacted unresolved node must use the same opaque endpoint',
    );
  });

  it('redacts unresolved endpoints even when public edge is visited before private edge (cloud-R3-P1)', async () => {
    const docs = new Map([
      [
        'project:cat-cafe:doc/root',
        {
          anchor: 'project:cat-cafe:doc/root',
          kind: 'feature',
          status: 'active',
          title: 'Root',
          updatedAt: '2026-05-08',
        },
      ],
      [
        'project:cat-cafe:doc/public',
        {
          anchor: 'project:cat-cafe:doc/public',
          kind: 'feature',
          status: 'active',
          title: 'Public',
          updatedAt: '2026-05-08',
        },
      ],
      [
        'project:cat-cafe:doc/bridge',
        {
          anchor: 'project:cat-cafe:doc/bridge',
          kind: 'feature',
          status: 'active',
          title: 'Bridge',
          updatedAt: '2026-05-08',
        },
      ],
      [
        'alpha:secret:doc/private',
        {
          anchor: 'alpha:secret:doc/private',
          kind: 'lore',
          status: 'active',
          title: 'Private',
          updatedAt: '2026-05-08',
        },
      ],
    ]);
    const related = new Map([
      [
        'project:cat-cafe:doc/root',
        [
          {
            anchor: 'project:cat-cafe:doc/public',
            relation: 'related_to',
            fromCollectionId: 'project:cat-cafe',
            toCollectionId: 'project:cat-cafe',
            edgeSensitivity: 'internal',
            provenance: 'frontmatter',
          },
          {
            anchor: 'project:cat-cafe:doc/bridge',
            relation: 'related_to',
            fromCollectionId: 'project:cat-cafe',
            toCollectionId: 'project:cat-cafe',
            edgeSensitivity: 'internal',
            provenance: 'frontmatter',
          },
        ],
      ],
      [
        'project:cat-cafe:doc/public',
        [
          {
            anchor: 'SecretCodename',
            relation: 'wikilink',
            fromCollectionId: 'project:cat-cafe',
            toCollectionId: null,
            edgeSensitivity: 'internal',
            provenance: 'content',
          },
        ],
      ],
      [
        'project:cat-cafe:doc/bridge',
        [
          {
            anchor: 'alpha:secret:doc/private',
            relation: 'related_to',
            fromCollectionId: 'project:cat-cafe',
            toCollectionId: 'alpha:secret',
            edgeSensitivity: 'internal',
            provenance: 'frontmatter',
          },
        ],
      ],
      [
        'alpha:secret:doc/private',
        [
          {
            anchor: 'SecretCodename',
            relation: 'wikilink',
            fromCollectionId: 'alpha:secret',
            toCollectionId: null,
            edgeSensitivity: 'private',
            provenance: 'content',
          },
        ],
      ],
    ]);
    const graphStore = {
      getByAnchor: async (anchor) => docs.get(anchor) ?? null,
      getRelated: async (anchor) => related.get(anchor) ?? [],
    };
    const catalog = {
      list: () => [
        { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'alpha:secret', sensitivity: 'private', kind: 'world' },
      ],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([
      ['project:cat-cafe', graphStore],
      ['alpha:secret', graphStore],
    ]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('project:cat-cafe:doc/root', {
      depth: 3,
      callerCollections: ['project:cat-cafe'],
    });

    const unresolved = result.nodes.find((n) => n.kind === 'unresolved');
    assert.ok(unresolved, 'redacted unresolved placeholder should be present');
    assert.ok(unresolved.anchor.startsWith('[redacted:'), 'unresolved node should use opaque anchor');
    assert.ok(!JSON.stringify(result).includes('SecretCodename'), 'public-first traversal must not leak raw anchor');
    assert.ok(
      result.edges.filter((e) => e.relation === 'wikilink').every((e) => e.to === unresolved.anchor),
      'all unresolved edge endpoints should be rewritten after traversal redaction is known',
    );
  });

  it('edges carry computed weight from traversal data (F200 AC-C2)', async () => {
    await store.upsert([
      { anchor: 'A1', kind: 'feature', status: 'active', title: 'A1', updatedAt: '2026-05-15' },
      { anchor: 'A2', kind: 'feature', status: 'active', title: 'A2', updatedAt: '2026-05-15' },
    ]);
    await store.addEdge({
      fromAnchor: 'A1',
      toAnchor: 'A2',
      relation: 'feature_ref',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'frontmatter',
    });
    const { recordEdgeTraversals } = await import('../../dist/domains/memory/edge-traversal.js');
    recordEdgeTraversals(store.db, [{ from: 'A1', to: 'A2', relation: 'feature_ref' }]);

    const catalog = {
      list: () => [{ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:cat-cafe', store]]);
    const resolver = new GraphResolver(catalog, stores);
    const result = await resolver.buildSubgraph('A1', { depth: 1, callerCollections: ['project:cat-cafe'] });

    assert.equal(result.edges.length, 1);
    const edge = result.edges[0];
    assert.equal(typeof edge.weight, 'number');
    assert.ok(edge.weight > 1.1, `traversed feature_ref should exceed base 1.1, got ${edge.weight}`);
  });

  it('excludes relation targets from archived collections (R2-P1)', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const archivedStore = new SqliteEvidenceStore(':memory:');
    await archivedStore.initialize();

    await store.upsert([
      { anchor: 'F200', kind: 'feature', status: 'active', title: 'F200 Active Feature', updatedAt: '2026-05-19' },
    ]);
    await archivedStore.upsert([
      { anchor: 'F100', kind: 'feature', status: 'active', title: 'F100 Legacy Feature', updatedAt: '2026-05-19' },
    ]);
    await store.addEdge({
      fromAnchor: 'F200',
      toAnchor: 'F100',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'project:legacy',
      edgeSensitivity: 'internal',
      provenance: 'frontmatter',
    });

    const catalog = {
      list: () => [
        { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project', status: 'active' },
        { id: 'project:legacy', sensitivity: 'internal', kind: 'project', status: 'archived' },
      ],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([
      ['project:cat-cafe', store],
      ['project:legacy', archivedStore],
    ]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('F200', {
      depth: 1,
      callerCollections: ['project:cat-cafe', 'project:legacy'],
    });

    assert.equal(result.nodes.length, 1, 'archived relation target must not appear as node');
    assert.equal(result.edges.length, 0, 'edge to archived collection must not be emitted');
    assert.equal(result.nodes[0].anchor, 'F200');
  });
});
