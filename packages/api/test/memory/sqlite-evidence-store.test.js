import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('SqliteEvidenceStore', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  it('initialize creates tables and returns healthy', async () => {
    assert.equal(await store.health(), true);
  });

  it('upsert + getByAnchor round-trips an item', async () => {
    const item = {
      anchor: 'F042',
      kind: 'feature',
      status: 'active',
      title: 'Prompt Engineering Audit',
      summary: 'Three-layer information architecture',
      keywords: ['prompt', 'skills'],
      sourcePath: 'docs/features/F042.md',
      sourceHash: 'abc123',
      updatedAt: '2026-03-11T00:00:00Z',
    };
    await store.upsert([item]);

    const got = await store.getByAnchor('F042');
    assert.ok(got);
    assert.equal(got.anchor, 'F042');
    assert.equal(got.kind, 'feature');
    assert.equal(got.title, 'Prompt Engineering Audit');
    assert.deepEqual(got.keywords, ['prompt', 'skills']);
  });

  it('upsert overwrites existing item (idempotent)', async () => {
    const item = {
      anchor: 'F042',
      kind: 'feature',
      status: 'active',
      title: 'Old Title',
      updatedAt: '2026-03-10T00:00:00Z',
    };
    await store.upsert([item]);

    const updated = { ...item, title: 'New Title', updatedAt: '2026-03-11T00:00:00Z' };
    await store.upsert([updated]);

    const got = await store.getByAnchor('F042');
    assert.equal(got.title, 'New Title');
  });

  it('deleteByAnchor removes an item', async () => {
    await store.upsert([
      {
        anchor: 'ADR-005',
        kind: 'decision',
        status: 'active',
        title: 'Hindsight Integration',
        updatedAt: '2026-03-11T00:00:00Z',
      },
    ]);
    await store.deleteByAnchor('ADR-005');
    const got = await store.getByAnchor('ADR-005');
    assert.equal(got, null);
  });

  it('getByAnchor returns null for missing anchor', async () => {
    const got = await store.getByAnchor('NONEXISTENT');
    assert.equal(got, null);
  });

  it('search finds items via FTS5 MATCH', async () => {
    await store.upsert([
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Prompt Engineering Audit',
        summary: 'Skills and information architecture redesign',
        updatedAt: '2026-03-11T00:00:00Z',
      },
      {
        anchor: 'F024',
        kind: 'feature',
        status: 'done',
        title: 'Session Chain',
        summary: 'Session lifecycle and sealing',
        updatedAt: '2026-03-10T00:00:00Z',
      },
    ]);

    const results = await store.search('prompt engineering');
    assert.ok(results.length >= 1);
    assert.equal(results[0].anchor, 'F042');
  });

  it('indexes keywords into evidence_fts for keyword-only discovery', async () => {
    await store.upsert([
      {
        anchor: 'doc:keyword-only',
        kind: 'architecture',
        status: 'active',
        title: 'Plain Architecture Map',
        summary: 'No rare lexical token is present here',
        keywords: ['rarekeywordxyz'],
        updatedAt: '2026-07-05T00:00:00Z',
      },
    ]);

    const ftsRows = store
      .getDb()
      .prepare('SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ?')
      .all('rarekeywordxyz');
    assert.equal(ftsRows.length, 1, 'evidence_fts should include keyword tokens, not only title/summary');

    const results = await store.search('rarekeywordxyz', { mode: 'lexical', limit: 5 });
    assert.equal(results[0]?.anchor, 'doc:keyword-only');
  });

  it('search filters by kind', async () => {
    await store.upsert([
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Prompt Audit',
        updatedAt: '2026-03-11T00:00:00Z',
      },
      {
        anchor: 'ADR-011',
        kind: 'decision',
        status: 'active',
        title: 'Prompt Frontmatter',
        updatedAt: '2026-03-11T00:00:00Z',
      },
    ]);

    const results = await store.search('prompt', { kind: 'decision' });
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'ADR-011');
  });

  it('search filters by status', async () => {
    await store.upsert([
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Active Feature',
        updatedAt: '2026-03-11T00:00:00Z',
      },
      {
        anchor: 'F024',
        kind: 'feature',
        status: 'done',
        title: 'Done Feature',
        updatedAt: '2026-03-10T00:00:00Z',
      },
    ]);

    const results = await store.search('feature', { status: 'done' });
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'F024');
  });

  it('scope=docs excludes session and thread digests but keeps discussion docs', async () => {
    await store.upsert([
      {
        anchor: 'F148',
        kind: 'feature',
        status: 'active',
        title: 'F148: Hierarchical Context Transport',
        summary: 'DecisionSignals buildThreadMemory coverageMap.searchSuggestions scoreImportance',
        updatedAt: '2026-04-15T00:00:00Z',
      },
      {
        anchor: 'doc:f148-design-discussion',
        kind: 'discussion',
        status: 'active',
        title: 'F148 design discussion',
        summary: 'DecisionSignals buildThreadMemory coverageMap.searchSuggestions scoreImportance',
        updatedAt: '2026-04-15T00:00:00Z',
      },
      {
        anchor: 'thread-thread_f148',
        kind: 'thread',
        status: 'active',
        title: 'F148 thread digest',
        summary: 'DecisionSignals buildThreadMemory coverageMap.searchSuggestions scoreImportance',
        updatedAt: '2026-04-15T00:00:00Z',
      },
      {
        anchor: 'session-f148',
        kind: 'session',
        status: 'active',
        title: 'F148 session digest',
        summary: 'DecisionSignals buildThreadMemory coverageMap.searchSuggestions scoreImportance',
        updatedAt: '2026-04-15T00:00:00Z',
      },
    ]);

    const results = await store.search(
      'DecisionSignals buildThreadMemory coverageMap.searchSuggestions scoreImportance',
      {
        scope: 'docs',
        mode: 'lexical',
        limit: 10,
      },
    );

    assert.ok(results.some((result) => result.anchor === 'F148'));
    assert.ok(results.some((result) => result.anchor === 'doc:f148-design-discussion'));
    assert.ok(
      results.every((result) => result.kind !== 'thread' && result.kind !== 'session'),
      'scope=docs should exclude thread/session digests but keep doc-backed discussions',
    );
  });

  it('search respects limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      anchor: `F${String(i).padStart(3, '0')}`,
      kind: 'feature',
      status: 'active',
      title: `Feature ${i} about testing`,
      updatedAt: '2026-03-11T00:00:00Z',
    }));
    await store.upsert(items);

    const results = await store.search('testing', { limit: 3 });
    assert.equal(results.length, 3);
  });

  it('search finds by exact anchor even when FTS5 tokenizer splits it', async () => {
    await store.upsert([
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Prompt Engineering Audit',
        summary: 'Three-layer information architecture',
        updatedAt: '2026-03-11T00:00:00Z',
      },
      {
        anchor: 'ADR-005',
        kind: 'decision',
        status: 'active',
        title: 'Hindsight Integration Decision',
        updatedAt: '2026-03-11T00:00:00Z',
      },
    ]);

    // "F042" would be split by unicode61 tokenizer into "F" + "042"
    // Exact-anchor bypass should still find it
    const byAnchor = await store.search('F042');
    assert.ok(byAnchor.length >= 1);
    assert.equal(byAnchor[0].anchor, 'F042');

    // "ADR-005" has a hyphen — also split by tokenizer
    const byHyphen = await store.search('ADR-005');
    assert.ok(byHyphen.length >= 1);
    assert.equal(byHyphen[0].anchor, 'ADR-005');
  });

  it('search handles quotes in query without throwing', async () => {
    await store.upsert([
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Prompt Engineering Audit',
        summary: 'Three-layer information architecture',
        updatedAt: '2026-03-11T00:00:00Z',
      },
    ]);

    // Should not throw — quotes in query should be handled gracefully
    const results = await store.search('abc"def');
    // May return empty or anchor-only, but must not throw
    assert.ok(Array.isArray(results));

    // Double quotes
    const results2 = await store.search('"unterminated');
    assert.ok(Array.isArray(results2));

    // FTS5 syntax characters
    const results3 = await store.search('test OR AND NOT');
    assert.ok(Array.isArray(results3));
  });

  it('search deprioritizes superseded items', async () => {
    await store.upsert([
      {
        anchor: 'ADR-001',
        kind: 'decision',
        status: 'active',
        title: 'Old memory design',
        summary: 'Memory system architecture',
        supersededBy: 'ADR-005',
        updatedAt: '2026-02-01T00:00:00Z',
      },
      {
        anchor: 'ADR-005',
        kind: 'decision',
        status: 'active',
        title: 'New memory design',
        summary: 'Memory system architecture v2',
        updatedAt: '2026-03-11T00:00:00Z',
      },
    ]);

    const results = await store.search('memory architecture');
    assert.ok(results.length === 2);
    // Non-superseded should come first
    assert.equal(results[0].anchor, 'ADR-005');
  });

  it('search deprioritizes status=superseded items, including exact-anchor matches', async () => {
    await store.upsert([
      {
        anchor: 'S4-DECISION-A',
        kind: 'decision',
        status: 'superseded',
        title: 'SQLite cache layer decision',
        summary: 'S4 temporal recall fixture for the old SQLite cache layer.',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        anchor: 'S4-DECISION-B',
        kind: 'decision',
        status: 'active',
        title: 'Redis migration decision',
        summary: 'Redis migration supersedes S4-DECISION-A for the cache layer.',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    ]);

    const results = await store.search('S4-DECISION-A', { limit: 2 });

    assert.equal(results.length, 2);
    assert.equal(results[0].anchor, 'S4-DECISION-B');
    assert.equal(results[1].anchor, 'S4-DECISION-A');
    assert.equal(results[1].status, 'superseded');
  });

  it('applies temporal demotion before semantic top-k slicing', async () => {
    await store.upsert([
      {
        anchor: 'M15-OLD-SEMANTIC',
        kind: 'decision',
        status: 'superseded',
        title: 'Old semantic cache decision',
        summary: 'Superseded semantic nearest neighbor for cache design.',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        anchor: 'M15-ACTIVE-SEMANTIC',
        kind: 'decision',
        status: 'active',
        title: 'Active semantic cache decision',
        summary: 'Active replacement for cache design.',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    ]);
    store.setEmbedDeps({
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'test', modelRev: 'test', dim: 3 }),
        load: async () => {},
        dispose: () => {},
      },
      vectorStore: {
        search: () => [
          { anchor: 'M15-OLD-SEMANTIC', distance: 0.01 },
          { anchor: 'M15-ACTIVE-SEMANTIC', distance: 0.02 },
        ],
      },
      mode: 'on',
    });

    const results = await store.search('semantic cache design', { mode: 'semantic', limit: 1 });

    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'M15-ACTIVE-SEMANTIC');
  });

  it('applies temporal demotion before hybrid top-k slicing', async () => {
    const savedRerank = process.env.F200_CONSUMPTION_RERANK;
    process.env.F200_CONSUMPTION_RERANK = 'off';
    try {
      await store.upsert([
        {
          anchor: 'M15-OLD-HYBRID',
          kind: 'decision',
          status: 'superseded',
          title: 'Old hybrid cache decision',
          summary: 'Superseded vector-only nearest neighbor for cache design.',
          updatedAt: '2026-05-01T00:00:00Z',
        },
        {
          anchor: 'M15-ACTIVE-HYBRID',
          kind: 'decision',
          status: 'active',
          title: 'Active hybrid cache decision',
          summary: 'Active replacement for vector-only cache design.',
          updatedAt: '2026-06-01T00:00:00Z',
        },
      ]);
      store.setEmbedDeps({
        embedding: {
          isReady: () => true,
          reprobeIfNeeded: async () => {},
          embed: async () => [new Float32Array([1, 0, 0])],
          getModelInfo: () => ({ modelId: 'test', modelRev: 'test', dim: 3 }),
          load: async () => {},
          dispose: () => {},
        },
        vectorStore: {
          search: () => [
            { anchor: 'M15-OLD-HYBRID', distance: 0.01 },
            { anchor: 'M15-ACTIVE-HYBRID', distance: 0.02 },
          ],
        },
        mode: 'on',
      });

      const results = await store.search('zzzz-hybrid-vector-only', { mode: 'hybrid', limit: 1 });

      assert.equal(results.length, 1);
      assert.equal(results[0].anchor, 'M15-ACTIVE-HYBRID');
    } finally {
      if (savedRerank === undefined) delete process.env.F200_CONSUMPTION_RERANK;
      else process.env.F200_CONSUMPTION_RERANK = savedRerank;
    }
  });

  it('applies temporal demotion before raw top-k slicing', async () => {
    await store.upsert([
      {
        anchor: 'M15-OLD-RAW',
        kind: 'decision',
        status: 'superseded',
        title: 'Old raw cache decision',
        summary: 'Superseded exact-anchor raw result for cache design.',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        anchor: 'M15-ACTIVE-RAW',
        kind: 'decision',
        status: 'active',
        title: 'Active raw cache decision',
        summary: 'Active replacement that supersedes M15-OLD-RAW for cache design.',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    ]);

    const results = await store.search('M15-OLD-RAW', { depth: 'raw', limit: 1 });

    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'M15-ACTIVE-RAW');
  });

  it('keeps raw passage hits ahead of demoted summary-only hits', async () => {
    await store.upsert([
      {
        anchor: 'M15-OLD-RAW-PASSAGE',
        kind: 'decision',
        status: 'superseded',
        title: 'Old raw passage decision',
        summary: 'Superseded raw decision with details in passages.',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        anchor: 'M15-ACTIVE-RAW-SUMMARY',
        kind: 'decision',
        status: 'active',
        title: 'Active raw summary decision',
        summary: 'Active summary-only note mentions rawprioritytoken.',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    ]);
    store
      .getDb()
      .prepare(
        'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'M15-OLD-RAW-PASSAGE',
        'p-raw-priority',
        'The rawprioritytoken details live only inside this passage.',
        null,
        0,
        '2026-05-01T00:00:00Z',
      );

    const results = await store.search('rawprioritytoken', { depth: 'raw', limit: 1 });

    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'M15-OLD-RAW-PASSAGE');
    assert.equal(results[0].status, 'superseded');
    assert.equal(results[0].passages?.[0]?.passageId, 'p-raw-priority');

    const orderedResults = await store.search('rawprioritytoken', { depth: 'raw', limit: 2 });
    assert.equal(orderedResults.length, 2);
    assert.equal(orderedResults[0].anchor, 'M15-OLD-RAW-PASSAGE');
    assert.equal(orderedResults[1].anchor, 'M15-ACTIVE-RAW-SUMMARY');
  });

  it('does not temporally demote constitutional evidence', async () => {
    await store.upsert([
      {
        anchor: 'M15-CONSTITUTIONAL',
        kind: 'architecture',
        status: 'superseded',
        title: 'Temporal doctrine',
        summary: 'Constitutional temporal doctrine for memory status semantics.',
        authority: 'constitutional',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        anchor: 'M15-OBSERVED',
        kind: 'architecture',
        status: 'active',
        title: 'Temporal doctrine note',
        summary: 'Observed note mentioning M15-CONSTITUTIONAL temporal doctrine.',
        authority: 'observed',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    ]);

    const results = await store.search('M15-CONSTITUTIONAL', { limit: 2 });

    assert.equal(results.length, 2);
    assert.equal(results[0].anchor, 'M15-CONSTITUTIONAL');
  });

  it('health returns false on closed db', async () => {
    store.close();
    assert.equal(await store.health(), false);
  });

  it('search filters by keywords when provided', async () => {
    await store.upsert([
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Prompt Engineering Audit of the system',
        keywords: ['prompt', 'skills'],
        updatedAt: '2026-03-11T00:00:00Z',
      },
      {
        anchor: 'F100',
        kind: 'feature',
        status: 'active',
        title: 'Self Evolution of the system',
        keywords: ['knowledge', 'memory'],
        updatedAt: '2026-03-11T00:00:00Z',
      },
    ]);

    // Both titles contain "system" — without keyword filter, both match
    const all = await store.search('system');
    assert.equal(all.length, 2);

    // Filter by keyword 'prompt' → only F042
    const results = await store.search('system', { keywords: ['prompt'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'F042');

    // Filter by keyword 'memory' → only F100
    const results2 = await store.search('system', { keywords: ['memory'] });
    assert.equal(results2.length, 1);
    assert.equal(results2[0].anchor, 'F100');
  });

  // ── Edge operations ──────────────────────────────────────────────

  it('addEdge + getRelated returns 1-hop neighbors', async () => {
    await store.upsert([
      { anchor: 'F042', kind: 'feature', status: 'active', title: 'Prompt Audit', updatedAt: '2026-03-11T00:00:00Z' },
      { anchor: 'F100', kind: 'feature', status: 'active', title: 'Self Evolution', updatedAt: '2026-03-11T00:00:00Z' },
    ]);
    await store.addEdge({ fromAnchor: 'F042', toAnchor: 'F100', relation: 'related' });

    const related = await store.getRelated('F042');
    assert.equal(related.length, 1);
    assert.equal(related[0].anchor, 'F100');
    assert.equal(related[0].relation, 'related_to');

    // Reverse lookup works too
    const reverse = await store.getRelated('F100');
    assert.equal(reverse.length, 1);
    assert.equal(reverse[0].anchor, 'F042');
  });

  it('addEdge with supersedes/invalidates relations', async () => {
    await store.addEdge({ fromAnchor: 'ADR-005', toAnchor: 'ADR-001', relation: 'supersedes' });
    await store.addEdge({ fromAnchor: 'F102', toAnchor: 'F003', relation: 'evolved_from' });

    const related = await store.getRelated('ADR-005');
    assert.equal(related.length, 1);
    assert.equal(related[0].relation, 'supersedes');
  });

  it('removeEdge deletes a specific edge', async () => {
    await store.addEdge({ fromAnchor: 'A', toAnchor: 'B', relation: 'related' });
    await store.addEdge({ fromAnchor: 'A', toAnchor: 'C', relation: 'blocked_by' });

    await store.removeEdge({ fromAnchor: 'A', toAnchor: 'B', relation: 'related' });

    const related = await store.getRelated('A');
    assert.equal(related.length, 1);
    assert.equal(related[0].anchor, 'C');
  });

  it('addEdge is idempotent (INSERT OR IGNORE)', async () => {
    await store.addEdge({ fromAnchor: 'A', toAnchor: 'B', relation: 'related' });
    await store.addEdge({ fromAnchor: 'A', toAnchor: 'B', relation: 'related' });
    const related = await store.getRelated('A');
    assert.equal(related.length, 1);
  });

  // F152 Phase C: generalizable field
  it('upsert + getByAnchor round-trips generalizable=true', async () => {
    await store.upsert([
      {
        anchor: 'lesson-1',
        kind: 'lesson',
        status: 'active',
        title: 'Cross-project pattern',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);
    const got = await store.getByAnchor('lesson-1');
    assert.equal(got.generalizable, true);
  });

  it('upsert + getByAnchor round-trips generalizable=false', async () => {
    await store.upsert([
      {
        anchor: 'lesson-2',
        kind: 'lesson',
        status: 'active',
        title: 'Project-private context',
        generalizable: false,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);
    const got = await store.getByAnchor('lesson-2');
    assert.equal(got.generalizable, false);
  });

  it('generalizable defaults to undefined when not set (AC-C2: fail-closed)', async () => {
    await store.upsert([
      {
        anchor: 'lesson-3',
        kind: 'lesson',
        status: 'active',
        title: 'Unmarked lesson',
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);
    const got = await store.getByAnchor('lesson-3');
    assert.equal(got.generalizable, undefined);
  });
});
