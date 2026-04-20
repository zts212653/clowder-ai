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
    assert.equal(related[0].relation, 'related');

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
