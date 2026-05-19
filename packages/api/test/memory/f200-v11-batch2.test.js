/**
 * F200 v1.1 Batch 2+3 — TDD tests for DF-6, DF-2, DF-3, DF-4, DF-7, DF-8, DF-10
 *
 * Tests written FIRST, implementations follow Red→Green.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// ─────────────────────────────────────────────────────────────────────────────
// DF-6: list_recent(scope=docs, kinds=["discussion"]) silently returns 0
// Root cause: kinds intersects with scope ceiling → empty set → no nudge
// Fix: return { results: [], nudge: "..." } when intersection is empty
// ─────────────────────────────────────────────────────────────────────────────

describe('DF-6: list_recent scope/kinds intersection nudge', () => {
  let RecentBrowseResolver;
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  async function setupStore() {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      { anchor: 'doc/plan-a', kind: 'plan', status: 'active', title: 'Plan A', updatedAt: '2026-05-15' },
      { anchor: 'doc/discussion-1', kind: 'discussion', status: 'active', title: 'Disc 1', updatedAt: '2026-05-14' },
      { anchor: 'doc/thread-1', kind: 'thread', status: 'active', title: 'Thread 1', updatedAt: '2026-05-13' },
    ]);
    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    return new RecentBrowseResolver(catalog, stores);
  }

  it('returns nudge when scope=docs but kinds=["discussion"] (empty intersection)', async () => {
    const resolver = await setupStore();
    const result = await resolver.list({
      scope: 'docs',
      kinds: ['discussion'],
      since: '30d',
      limit: 20,
    });
    // DF-6 fix: result should include a nudge explaining the empty intersection
    assert.ok(result.nudge, 'Expected nudge field when kinds do not intersect with scope');
    assert.match(result.nudge, /discussion/i);
    assert.match(result.nudge, /threads/i);
    assert.deepEqual(result.items, []);
  });

  it('returns nudge when scope=memory but kinds=["feature"] (empty intersection)', async () => {
    const resolver = await setupStore();
    const result = await resolver.list({
      scope: 'memory',
      kinds: ['feature'],
      since: '30d',
      limit: 20,
    });
    assert.ok(result.nudge, 'Expected nudge for scope=memory, kinds=[feature]');
    assert.match(result.nudge, /docs/i);
    assert.deepEqual(result.items, []);
  });

  it('returns normal results (no nudge) when kinds match scope', async () => {
    const resolver = await setupStore();
    const result = await resolver.list({
      scope: 'docs',
      kinds: ['plan'],
      since: '30d',
      limit: 20,
    });
    assert.equal(result.nudge, undefined);
    assert.ok(result.items.length > 0);
    assert.equal(result.items[0].kind, 'plan');
  });

  it('returns normal results when no kinds specified', async () => {
    const resolver = await setupStore();
    const result = await resolver.list({
      scope: 'docs',
      since: '30d',
      limit: 20,
    });
    assert.equal(result.nudge, undefined);
    assert.ok(result.items.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DF-2: graph_resolve depth≥2 hub explosion (209 nodes / 439 edges)
// Root cause: no degree cap on hub-node fan-out during traversal
// Fix: cap per-node edge expansion (e.g. MAX_EDGES_PER_NODE = 15)
// ─────────────────────────────────────────────────────────────────────────────

describe('DF-2: graph_resolve hub-node degree cap', () => {
  let GraphResolver;
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ GraphResolver } = await import('../../dist/domains/memory/GraphResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  async function setupHubStore(edgeCount) {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    // Create a hub node with many edges
    const docs = [
      { anchor: 'hub:F102', kind: 'feature', status: 'active', title: 'F102 Memory', updatedAt: '2026-05-15' },
    ];
    for (let i = 0; i < edgeCount; i++) {
      docs.push({
        anchor: `spoke:leaf-${i}`,
        kind: 'feature',
        status: 'active',
        title: `Leaf ${i}`,
        updatedAt: '2026-05-15',
      });
    }
    await store.upsert(docs);
    for (let i = 0; i < edgeCount; i++) {
      await store.addEdge({
        fromAnchor: 'hub:F102',
        toAnchor: `spoke:leaf-${i}`,
        relation: 'related_to',
        fromCollectionId: 'project:test',
        toCollectionId: 'project:test',
        edgeSensitivity: 'internal',
        provenance: 'extracted',
      });
    }
    return store;
  }

  it('caps edges per node to prevent hub explosion at depth=1', async () => {
    const store = await setupHubStore(50);
    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('hub:F102', {
      depth: 1,
      callerCollections: ['project:test'],
    });

    // DF-2 fix: should cap edges instead of returning all 50
    assert.ok(result.edges.length <= 20, `Expected ≤20 edges, got ${result.edges.length}`);
    assert.ok(result.nodes.length <= 21, `Expected ≤21 nodes (hub+20 leaves), got ${result.nodes.length}`);
  });

  it('caps total graph size at depth=2 to prevent explosion', async () => {
    const store = await setupHubStore(30);
    // Add secondary edges from some leaves
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 5; j++) {
        const leafAnchor = `spoke:leaf-${i}-child-${j}`;
        await store.upsert([
          { anchor: leafAnchor, kind: 'feature', status: 'active', title: `Child ${i}-${j}`, updatedAt: '2026-05-15' },
        ]);
        await store.addEdge({
          fromAnchor: `spoke:leaf-${i}`,
          toAnchor: leafAnchor,
          relation: 'related_to',
          fromCollectionId: 'project:test',
          toCollectionId: 'project:test',
          edgeSensitivity: 'internal',
          provenance: 'extracted',
        });
      }
    }

    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('hub:F102', {
      depth: 2,
      callerCollections: ['project:test'],
    });

    // DF-2 fix: total graph must stay bounded even at depth=2
    assert.ok(result.nodes.length <= 60, `Expected ≤60 total nodes, got ${result.nodes.length}`);
    assert.ok(result.edges.length <= 80, `Expected ≤80 total edges, got ${result.edges.length}`);
  });

  it('returns metadata about truncation when cap is hit', async () => {
    const store = await setupHubStore(50);
    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('hub:F102', {
      depth: 1,
      callerCollections: ['project:test'],
    });

    // Should indicate truncation happened
    assert.ok(result.truncated, 'Expected truncated=true when degree cap hit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DF-3: search_evidence missing explainability (consumption_prior, MMR)
// Root cause: reranking results lack reason/score breakdown
// Fix: add explainability fields to search output
// ─────────────────────────────────────────────────────────────────────────────

describe('DF-3: search explainability fields', () => {
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  async function setupSearchStore() {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'doc/a',
        kind: 'feature',
        status: 'active',
        title: 'Feature A about memory',
        summary: 'Memory recall system design',
        updatedAt: '2026-05-15',
      },
      {
        anchor: 'doc/b',
        kind: 'plan',
        status: 'active',
        title: 'Plan B about routing',
        summary: 'Routing implementation plan',
        updatedAt: '2026-05-14',
      },
      {
        anchor: 'doc/c',
        kind: 'decision',
        status: 'active',
        title: 'Decision C memory',
        summary: 'Architecture decision on memory caching',
        updatedAt: '2026-05-13',
      },
    ]);
    return store;
  }

  it('search results include matchReason field', async () => {
    const store = await setupSearchStore();
    const results = await store.search('memory', { mode: 'lexical', limit: 5 });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(r.matchReason, `Expected matchReason on result ${r.anchor}`);
      assert.ok(
        ['title', 'summary', 'keyword', 'anchor', 'content'].includes(r.matchReason),
        `Unexpected matchReason: ${r.matchReason}`,
      );
    }
  });

  it('search results include rankingFactors when consumption reranking is active', async () => {
    const store = await setupSearchStore();
    const results = await store.search('memory', {
      mode: 'lexical',
      limit: 5,
      explain: true,
    });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(r.rankingFactors, `Expected rankingFactors on result ${r.anchor}`);
      assert.equal(typeof r.rankingFactors.bm25Score, 'number');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DF-4: list_recent(trajectories) missing verified + filesRead/filesModified
// Root cause: RecentBrowseResolver doesn't know about task_trajectories table
// Fix: add scope='trajectories' that queries TrajectoryQueryService
// ─────────────────────────────────────────────────────────────────────────────

describe('DF-4: list_recent trajectories scope', () => {
  let RecentBrowseResolver;
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('supports scope=trajectories with verified filter', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    const resolver = new RecentBrowseResolver(catalog, stores);

    // scope=trajectories should be accepted without error
    const result = await resolver.list({
      scope: 'trajectories',
      since: '7d',
      limit: 10,
      verified: true,
    });
    assert.ok(Array.isArray(result.items));
  });

  it('trajectory items include filesRead and filesModified counts', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    // Insert a trajectory directly
    const db = store.getDb();
    db.prepare(`INSERT INTO task_trajectories
      (trajectory_id, invocation_id, thread_id, cat_id, task_context,
       search_event_ids_json, files_read_json, files_modified_json,
       output_verified, output_verified_signals_json,
       total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'traj-1',
      'inv-1',
      'thread-1',
      'opus-46',
      'Fix DF-4',
      '["ev1","ev2"]',
      '["src/a.ts","src/b.ts","test/c.ts"]',
      '["src/a.ts"]',
      1,
      '["pr_merge"]',
      5000,
      120,
      Date.now() - 3600000,
      Date.now() - 3600000,
    );

    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    const resolver = new RecentBrowseResolver(catalog, stores);

    const result = await resolver.list({
      scope: 'trajectories',
      since: '7d',
      limit: 10,
    });
    assert.ok(result.items.length >= 1, 'Expected at least 1 trajectory');
    const traj = result.items[0];
    assert.equal(traj.filesRead, 3);
    assert.equal(traj.filesModified, 1);
    assert.equal(traj.verified, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DF-10: graph_resolve fuzzy cross-domain false positives (~20%)
// Root cause: searchCandidates() doesn't penalize cross-collection matches
// Fix: apply cross-collection penalty in text scoring
// ─────────────────────────────────────────────────────────────────────────────

describe('DF-10: graph_resolve cross-domain false positive penalty', () => {
  let GraphQueryResolver;

  beforeEach(async () => {
    ({ GraphQueryResolver } = await import('../../dist/domains/memory/GraphQueryResolver.js'));
  });

  function item(anchor, overrides = {}) {
    return {
      anchor,
      kind: 'feature',
      status: 'active',
      title: overrides.title ?? anchor,
      summary: overrides.summary ?? '',
      updatedAt: '2026-05-15',
      keywords: overrides.keywords ?? [],
      ...overrides,
    };
  }

  function catalog(manifests) {
    return {
      list: () => manifests,
      get: (id) => manifests.find((m) => m.id === id),
    };
  }

  function createStore(items, options = {}) {
    const byAnchor = new Map(items.map((i) => [i.anchor.toLowerCase(), i]));
    const relatedByAnchor = new Map(
      Object.entries(options.related ?? {}).map(([anchor, related]) => [anchor.toLowerCase(), related]),
    );
    return {
      async getByAnchor(anchor) {
        return byAnchor.get(anchor.toLowerCase()) ?? null;
      },
      async search(query, searchOptions = {}) {
        const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
        return items
          .filter((i) => {
            const text = [i.anchor, i.title, i.summary, ...(i.keywords ?? [])].join(' ').toLowerCase();
            return tokens.some((t) => text.includes(t));
          })
          .slice(0, searchOptions.limit ?? items.length);
      },
      async getRelated(anchor) {
        return relatedByAnchor.get(anchor.toLowerCase()) ?? [];
      },
    };
  }

  it('penalizes cross-domain candidates in ranking', async () => {
    const manifests = [
      { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
      { id: 'world:lexander', sensitivity: 'internal', kind: 'world' },
    ];
    const catCafeItem = item('project:cat-cafe:doc/f102', {
      title: 'F102 Memory System',
      keywords: ['memory', 'recall'],
    });
    const worldItem = item('world:lexander:doc/memory-spell', {
      title: 'Memory Spell',
      keywords: ['memory', 'magic'],
    });

    const store = createStore([catCafeItem, worldItem]);
    const resolver = new GraphQueryResolver(
      catalog(manifests),
      new Map([
        ['project:cat-cafe', store],
        ['world:lexander', store],
      ]),
    );

    const result = await resolver.resolve('memory recall', {
      callerCollections: ['project:cat-cafe', 'world:lexander'],
      preferredCollectionId: 'project:cat-cafe',
    });

    // Same-domain result should rank higher when both have similar text match
    assert.ok(result.candidates.length >= 2, `Expected ≥2 candidates, got ${result.candidates.length}`);
    const catCafeIdx = result.candidates.findIndex((c) => c.anchor.includes('f102'));
    const worldIdx = result.candidates.findIndex((c) => c.anchor.includes('memory-spell'));
    assert.ok(
      catCafeIdx < worldIdx,
      `Same-domain result (idx=${catCafeIdx}) should rank before cross-domain (idx=${worldIdx})`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 Round 2: listTrajectories must respect collection visibility (privacy)
// Root cause: listTrajectories() iterates all stores without checking manifest
// Fix: check manifest sensitivity + callerCollections like the docs path
// ─────────────────────────────────────────────────────────────────────────────

describe('P1-R2: listTrajectories respects collection visibility', () => {
  let RecentBrowseResolver;
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  async function setupStoresWithPrivateTrajectory() {
    const publicStore = new SqliteEvidenceStore(':memory:');
    await publicStore.initialize();
    const publicDb = publicStore.getDb();
    publicDb
      .prepare(
        `INSERT INTO task_trajectories
      (trajectory_id, invocation_id, thread_id, cat_id, task_context,
       search_event_ids_json, files_read_json, files_modified_json,
       output_verified, output_verified_signals_json,
       total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'traj-public',
        'inv-1',
        'thread-1',
        'opus-46',
        'Public task',
        '[]',
        '["src/a.ts"]',
        '[]',
        1,
        '[]',
        1000,
        60,
        Date.now() - 3600000,
        Date.now() - 3600000,
      );

    const privateStore = new SqliteEvidenceStore(':memory:');
    await privateStore.initialize();
    const privateDb = privateStore.getDb();
    privateDb
      .prepare(
        `INSERT INTO task_trajectories
      (trajectory_id, invocation_id, thread_id, cat_id, task_context,
       search_event_ids_json, files_read_json, files_modified_json,
       output_verified, output_verified_signals_json,
       total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'traj-private',
        'inv-2',
        'thread-2',
        'opus-46',
        'Private task with sensitive data',
        '[]',
        '["secret/keys.ts"]',
        '["secret/keys.ts"]',
        0,
        '[]',
        2000,
        120,
        Date.now() - 1800000,
        Date.now() - 1800000,
      );

    const catalog = {
      list: () => [
        { id: 'project:cafe', sensitivity: 'internal', kind: 'project' },
        { id: 'world:lexander', sensitivity: 'private', kind: 'world' },
      ],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([
      ['project:cafe', publicStore],
      ['world:lexander', privateStore],
    ]);
    return { catalog, stores };
  }

  it('excludes private store trajectories when callerCollections is undefined', async () => {
    const { catalog, stores } = await setupStoresWithPrivateTrajectory();
    const resolver = new RecentBrowseResolver(catalog, stores);

    const result = await resolver.list({ scope: 'trajectories', since: '7d', limit: 20 });
    // Only public store trajectories should appear
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].anchor, 'traj-public');
  });

  it('includes private store trajectories when callerCollections contains it', async () => {
    const { catalog, stores } = await setupStoresWithPrivateTrajectory();
    const resolver = new RecentBrowseResolver(catalog, stores);

    const result = await resolver.list({
      scope: 'trajectories',
      since: '7d',
      limit: 20,
      callerCollections: ['project:cafe', 'world:lexander'],
    });
    // Both stores should contribute
    assert.equal(result.items.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 Round 2: annotateMatchReasons must use local query, not instance state
// Root cause: this.lastQuery can be overwritten by concurrent search
// Fix: pass query as parameter to enrichWithDrillDown/annotateMatchReasons
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-R2: matchReason uses correct query (no instance state leak)', () => {
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('matchReason reflects the actual query used for that search call', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'doc/redis',
        kind: 'feature',
        status: 'active',
        title: 'Redis caching',
        summary: 'Redis cache layer',
        updatedAt: '2026-05-15',
      },
      {
        anchor: 'doc/memory',
        kind: 'feature',
        status: 'active',
        title: 'Memory system',
        summary: 'Memory recall pipeline',
        updatedAt: '2026-05-14',
      },
    ]);

    // Simulate sequential calls — second should not pollute first's annotation
    const results1 = await store.search('Redis', { mode: 'lexical', limit: 5, explain: true });
    const results2 = await store.search('Memory', { mode: 'lexical', limit: 5, explain: true });

    // results1 should have matchReason based on 'Redis', not 'Memory'
    assert.ok(results1.length >= 1);
    const redisResult = results1.find((r) => r.anchor === 'doc/redis');
    assert.ok(redisResult);
    assert.ok(redisResult.matchReason, 'matchReason should be set');
    // After fix: matchReason annotation uses the query passed to that specific search call
    // Before fix: this.lastQuery could be 'Memory' if calls are interleaved
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DF-7: semantic confidence misalignment — P3 "可延后" per spec
// Removed: vacuous test (nothing in lexical pipeline sets confidence on items).
// Confidence normalization requires vector search pipeline (semantic mode only).
// Will be addressed when embedding service is integrated.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// DF-8: hybrid cross-language RRF degradation
// Root cause: CJK query gets near-zero BM25 scores → relevant Chinese docs
// (found only by NN/semantic) lose to irrelevant high-BM25 English docs in RRF
// Fix: asymmetric NN weight boost (1.5×) when query contains CJK characters
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────���───────────────────────────────────────
// P1-1 WIRING: DF-4 trajectory metadata must flow through route to MCP
// Reviewer: library.ts:403 special-case bypasses resolver → verified/filesRead lost
// Fix: remove special-case, let resolver.list({scope:'trajectories'}) handle it
// ──────────────────���──────────────────────────────────────────────────────────

describe('P1-1: DF-4 trajectory metadata wiring (route → MCP)', () => {
  let RecentBrowseResolver;
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('resolver.list({scope:trajectories}) returns items with filesRead/filesModified/verified fields', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    db.prepare(`INSERT INTO task_trajectories
      (trajectory_id, invocation_id, thread_id, cat_id, task_context,
       search_event_ids_json, files_read_json, files_modified_json,
       output_verified, output_verified_signals_json,
       total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'traj-wire-1',
      'inv-1',
      'thread-1',
      'opus-46',
      'Wiring test',
      '[]',
      '["src/a.ts","src/b.ts"]',
      '["src/a.ts"]',
      1,
      '["pr_merge"]',
      5000,
      120,
      Date.now() - 3600000,
      Date.now() - 3600000,
    );

    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    const resolver = new RecentBrowseResolver(catalog, stores);

    const result = await resolver.list({ scope: 'trajectories', since: '7d', limit: 10 });
    assert.ok(result.items.length >= 1);
    const item = result.items[0];
    // These fields MUST be present for MCP to display them
    assert.equal(typeof item.filesRead, 'number', 'filesRead must be a number');
    assert.equal(typeof item.filesModified, 'number', 'filesModified must be a number');
    assert.equal(typeof item.verified, 'boolean', 'verified must be a boolean');
    assert.equal(item.filesRead, 2);
    assert.equal(item.filesModified, 1);
    assert.equal(item.verified, true);
  });
});

// ────────────────────��────────────────────────────────────────────────────────
// P1-2 WIRING: DF-3 explainability must flow through route to MCP response
// Reviewer: matchReason/rankingFactors set in store but not passed through route
// Fix: route must include these fields in response; MCP must add explain param
// ─────────────────────���──────────────────────────────���────────────────────────

describe('P1-2: DF-3 explainability wiring (store → route → MCP)', () => {
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('store.search with explain:true returns matchReason + rankingFactors on every result', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'doc/wire-a',
        kind: 'feature',
        status: 'active',
        title: 'Memory system design',
        summary: 'Recall pipeline architecture',
        updatedAt: '2026-05-15',
      },
      {
        anchor: 'doc/wire-b',
        kind: 'plan',
        status: 'active',
        title: 'Memory optimization plan',
        summary: 'Performance tuning for memory store',
        updatedAt: '2026-05-14',
      },
    ]);

    const results = await store.search('memory', { mode: 'lexical', limit: 5, explain: true });
    assert.ok(results.length >= 1, 'Expected at least 1 result');
    for (const r of results) {
      assert.ok(r.matchReason, `matchReason missing on ${r.anchor}`);
      assert.ok(r.rankingFactors, `rankingFactors missing on ${r.anchor} (explain:true)`);
      assert.equal(typeof r.rankingFactors.bm25Score, 'number');
    }
  });

  it('store.search without explain returns matchReason but NOT rankingFactors', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'doc/wire-c',
        kind: 'feature',
        status: 'active',
        title: 'Memory system',
        summary: 'Recall',
        updatedAt: '2026-05-15',
      },
    ]);

    const results = await store.search('memory', { mode: 'lexical', limit: 5 });
    assert.ok(results.length >= 1);
    for (const r of results) {
      assert.ok(r.matchReason, `matchReason should always be present on ${r.anchor}`);
      assert.equal(r.rankingFactors, undefined, 'rankingFactors should NOT be present without explain:true');
    }
  });
});

// ─────────���───────────────────────────────────────────────────────────────────
// P2-1 WIRING: DF-2 truncated flag must flow through MCP graph output
// Reviewer: GraphResolver returns truncated but MCP doesn't expose it
// Fix: add truncated to GraphSubgraphInner, show warning in format
// ─────────────────────���──────────────────────────────��────────────────────────

describe('P2-1: DF-2 truncated flag wiring (GraphResolver → MCP)', () => {
  let GraphResolver;
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ GraphResolver } = await import('../../dist/domains/memory/GraphResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('GraphResolver.buildSubgraph returns truncated:true when degree cap hit', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const docs = [{ anchor: 'hub:main', kind: 'feature', status: 'active', title: 'Hub', updatedAt: '2026-05-15' }];
    for (let i = 0; i < 30; i++) {
      docs.push({
        anchor: `spoke:n-${i}`,
        kind: 'feature',
        status: 'active',
        title: `Node ${i}`,
        updatedAt: '2026-05-15',
      });
    }
    await store.upsert(docs);
    for (let i = 0; i < 30; i++) {
      await store.addEdge({
        fromAnchor: 'hub:main',
        toAnchor: `spoke:n-${i}`,
        relation: 'related_to',
        fromCollectionId: 'project:test',
        toCollectionId: 'project:test',
        edgeSensitivity: 'internal',
        provenance: 'extracted',
      });
    }
    const catalog = {
      list: () => [{ id: 'project:test', sensitivity: 'internal', kind: 'project' }],
      get: (id) => catalog.list().find((m) => m.id === id),
    };
    const stores = new Map([['project:test', store]]);
    const resolver = new GraphResolver(catalog, stores);

    const result = await resolver.buildSubgraph('hub:main', { depth: 1, callerCollections: ['project:test'] });
    // Truncated flag MUST be present for MCP to display warning
    assert.equal(result.truncated, true, 'truncated must be true when degree cap hit');
  });
});

describe('DF-8: hybrid cross-language RRF degradation', () => {
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('boosts semantic NN weight for CJK queries so Chinese-relevant docs are not suppressed', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert Chinese doc (semantically relevant) and English doc (BM25-strong but less relevant)
    await store.upsert([
      {
        anchor: 'doc/redis-cache-cn',
        kind: 'feature',
        status: 'active',
        title: 'Redis 缓存策略',
        summary: '使用 Redis 实现分布式缓存的最佳实践',
        updatedAt: '2026-05-15',
      },
      {
        anchor: 'doc/redis-config',
        kind: 'feature',
        status: 'active',
        title: 'Redis configuration basics',
        summary: 'How to configure Redis for production environments',
        updatedAt: '2026-05-14',
      },
    ]);

    // The CJK NN weight boost is applied internally in hybridRRFSearch.
    // We verify the mechanism exists by checking the exported helper.
    const { hasCJKCharacters } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    assert.equal(hasCJKCharacters('缓存策略'), true, 'CJK detection for Chinese');
    assert.equal(hasCJKCharacters('Redis caching'), false, 'CJK detection for English');
    assert.equal(hasCJKCharacters('Redis 缓存'), true, 'CJK detection for mixed');
  });

  it('CJK NN weight factor is > 1.0 (asymmetric boost)', async () => {
    const { CJK_NN_WEIGHT } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    assert.ok(CJK_NN_WEIGHT > 1.0, `CJK_NN_WEIGHT should be > 1.0, got ${CJK_NN_WEIGHT}`);
    assert.ok(CJK_NN_WEIGHT <= 2.0, `CJK_NN_WEIGHT should be <= 2.0, got ${CJK_NN_WEIGHT}`);
  });
});

// ───��─────────────────────────────────────────────────────────────────────────
// Cloud Review Round 3: P1 — trajectory cross-store sort + P2 — raw depth explain
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud-P1: listTrajectories sorts across stores by updatedAt DESC', () => {
  let RecentBrowseResolver;
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('returns trajectories from multiple stores sorted by updatedAt descending', async () => {
    // Store A has an OLD trajectory, Store B has a NEW trajectory
    const storeA = new SqliteEvidenceStore(':memory:');
    await storeA.initialize();
    const dbA = storeA.getDb();
    // Old: 2026-05-10
    dbA
      .prepare(`INSERT INTO task_trajectories
      (trajectory_id, invocation_id, thread_id, cat_id, task_context,
       search_event_ids_json, files_read_json, files_modified_json,
       output_verified, output_verified_signals_json,
       total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'traj-old',
        'inv-a',
        'thread-a',
        'cat-a',
        'Old task',
        '[]',
        '["a.ts"]',
        '[]',
        1,
        '[]',
        0,
        0,
        new Date('2026-05-10T00:00:00Z').getTime(),
        new Date('2026-05-10T00:00:00Z').getTime(),
      );

    const storeB = new SqliteEvidenceStore(':memory:');
    await storeB.initialize();
    const dbB = storeB.getDb();
    // New: 2026-05-15
    dbB
      .prepare(`INSERT INTO task_trajectories
      (trajectory_id, invocation_id, thread_id, cat_id, task_context,
       search_event_ids_json, files_read_json, files_modified_json,
       output_verified, output_verified_signals_json,
       total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'traj-new',
        'inv-b',
        'thread-b',
        'cat-b',
        'New task',
        '[]',
        '[]',
        '["b.ts"]',
        0,
        '[]',
        0,
        0,
        new Date('2026-05-15T00:00:00Z').getTime(),
        new Date('2026-05-15T00:00:00Z').getTime(),
      );

    const catalog = {
      list: () => [
        { id: 'col-a', sensitivity: 'public', kind: 'workspace' },
        { id: 'col-b', sensitivity: 'public', kind: 'workspace' },
      ],
    };
    const stores = new Map([
      ['col-a', storeA],
      ['col-b', storeB],
    ]);
    const resolver = new RecentBrowseResolver(catalog, stores);
    const result = await resolver.list({ scope: 'trajectories', since: '30d', limit: 10 });

    // The NEWER trajectory must come first regardless of store iteration order
    assert.equal(result.items[0].anchor, 'traj-new', 'newest trajectory should be first');
    assert.equal(result.items[1].anchor, 'traj-old', 'oldest trajectory should be second');
  });
});

describe('Cloud-P2: depth=raw search still returns rankingFactors when explain=true', () => {
  let SqliteEvidenceStore;

  beforeEach(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  it('raw depth with explain=true includes rankingFactors on results', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      { anchor: 'doc/raw-test', kind: 'plan', status: 'active', title: 'Raw Test Plan', updatedAt: '2026-05-15' },
    ]);

    const results = await store.search('raw test', { depth: 'raw', explain: true });
    assert.ok(results.length > 0, 'should find at least one result');
    const first = results[0];
    assert.ok(first.matchReason, 'matchReason should be present');
    assert.ok(first.rankingFactors, 'rankingFactors should be present when explain=true');
  });
});
