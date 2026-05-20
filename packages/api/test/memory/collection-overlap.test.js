// F188 Phase H — AC-H1: Collection overlap exclusion tests
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('collection overlap exclusion (AC-H1)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overlap-'));
    mkdirSync(join(dir, 'docs', 'features'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'library', 'finance'), { recursive: true });

    writeFileSync(
      join(dir, 'docs', 'features', 'F001-test.md'),
      '---\ntitle: Test Feature\nkind: feature\n---\n\nA project-level feature doc.\n',
    );
    writeFileSync(
      join(dir, 'docs', 'library', 'finance', 'report.md'),
      '---\ntitle: Finance Report\nkind: research\n---\n\nConfidential finance data.\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('computeChildExcludes returns relative glob for child roots inside parent', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');

    const parentRoot = join(dir, 'docs');
    const children = [{ root: join(dir, 'docs', 'library', 'finance') }, { root: '/some/unrelated/path' }];

    const excludes = computeChildExcludes(parentRoot, children);
    assert.deepStrictEqual(excludes, ['library/finance/**']);
  });

  test('computeChildExcludes returns empty for non-overlapping roots', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');

    const parentRoot = join(dir, 'docs');
    const children = [{ root: '/completely/separate/path' }];

    const excludes = computeChildExcludes(parentRoot, children);
    assert.deepStrictEqual(excludes, []);
  });

  test('parent scanner with computed exclude does not index child docs', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
    const { resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js');

    const parentRoot = join(dir, 'docs');
    const childManifests = [
      {
        id: 'domain:finance',
        root: join(dir, 'docs', 'library', 'finance'),
        sensitivity: 'private',
      },
    ];

    const excludes = computeChildExcludes(parentRoot, childManifests);

    const dbPath = join(dir, 'parent.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const manifest = {
      id: 'project:test',
      kind: 'project',
      name: 'test',
      displayName: 'Test Project',
      root: parentRoot,
      sensitivity: 'internal',
      scannerLevel: 0,
      exclude: excludes,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-19',
      updatedAt: '2026-05-19',
    };

    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    await builder.rebuild();

    const db = store.getDb();
    const rows = db.prepare('SELECT anchor, title FROM evidence_docs').all();

    const hasFinanceDocs = rows.some((r) => r.anchor.includes('finance') || r.title.includes('Finance'));
    assert.strictEqual(hasFinanceDocs, false, `Finance docs leaked into parent store: ${JSON.stringify(rows)}`);

    const hasParentDocs = rows.some((r) => r.anchor.includes('F001'));
    assert.strictEqual(hasParentDocs, true, `Expected parent docs in store, got: ${JSON.stringify(rows)}`);
  });

  test('IndexBuilder with exclude does not index child docs (real project path)', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const parentRoot = join(dir, 'docs');
    const childManifests = [
      { id: 'domain:finance', root: join(dir, 'docs', 'library', 'finance'), sensitivity: 'private' },
    ];
    const excludes = computeChildExcludes(parentRoot, childManifests);

    const dbPath = join(dir, 'indexbuilder.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const builder = new IndexBuilder(
      store,
      parentRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      excludes,
    );
    await builder.rebuild();

    const db = store.getDb();
    const rows = db.prepare('SELECT anchor, title FROM evidence_docs').all();

    const hasFinanceDocs = rows.some((r) => r.anchor.includes('finance') || r.title.includes('Finance'));
    assert.strictEqual(hasFinanceDocs, false, `Finance docs leaked via IndexBuilder path: ${JSON.stringify(rows)}`);

    const hasParentDocs = rows.some((r) => r.anchor.includes('F001'));
    assert.strictEqual(hasParentDocs, true, `Expected parent docs in store, got: ${JSON.stringify(rows)}`);
  });

  test('IndexBuilder incrementalUpdate skips excluded child docs', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const parentRoot = join(dir, 'docs');
    const childManifests = [
      { id: 'domain:finance', root: join(dir, 'docs', 'library', 'finance'), sensitivity: 'private' },
    ];
    const excludes = computeChildExcludes(parentRoot, childManifests);

    const dbPath = join(dir, 'incremental.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const builder = new IndexBuilder(
      store,
      parentRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      excludes,
    );

    // Incremental update with a child collection file should be a no-op
    const financePath = join(dir, 'docs', 'library', 'finance', 'report.md');
    await builder.incrementalUpdate([financePath]);

    const db = store.getDb();
    const rows = db.prepare('SELECT anchor FROM evidence_docs').all();
    const hasFinance = rows.some((r) => r.anchor.includes('finance'));
    assert.strictEqual(hasFinance, false, `Finance doc upserted via incrementalUpdate: ${JSON.stringify(rows)}`);
  });

  test('parent rebuild removes historical child rows after adding exclude', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
    const { resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js');

    const parentRoot = join(dir, 'docs');
    const dbPath = join(dir, 'parent-rebuild.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    // Phase 1: Index WITHOUT exclude (simulates current/historical state)
    const manifestNoExclude = {
      id: 'project:test',
      kind: 'project',
      name: 'test',
      displayName: 'Test Project',
      root: parentRoot,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-19',
      updatedAt: '2026-05-19',
    };

    const scanner1 = resolveCollectionScanner(manifestNoExclude);
    const builder1 = new CollectionIndexBuilder(store, manifestNoExclude, scanner1);
    await builder1.rebuild();

    const rowsBefore = store.getDb().prepare('SELECT anchor FROM evidence_docs').all();
    const hadFinance = rowsBefore.some((r) => r.anchor.includes('finance'));
    assert.strictEqual(hadFinance, true, 'Precondition: finance docs should exist before cleanup');

    // Phase 2: Add child collection, compute exclude, rebuild with exclude
    const childManifests = [
      { id: 'domain:finance', root: join(dir, 'docs', 'library', 'finance'), sensitivity: 'private' },
    ];
    const excludes = computeChildExcludes(parentRoot, childManifests);

    const manifestWithExclude = { ...manifestNoExclude, exclude: excludes };
    const scanner2 = resolveCollectionScanner(manifestWithExclude);
    const builder2 = new CollectionIndexBuilder(store, manifestWithExclude, scanner2);
    await builder2.rebuild({ force: true });

    const rowsAfter = store.getDb().prepare('SELECT anchor FROM evidence_docs').all();
    const stillHasFinance = rowsAfter.some((r) => r.anchor.includes('finance'));
    assert.strictEqual(
      stillHasFinance,
      false,
      `Finance rows not cleaned up after rebuild: ${JSON.stringify(rowsAfter)}`,
    );
  });

  test('IndexBuilder.addExcludePatterns updates scanner excludes at runtime (P1 R3)', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const parentRoot = join(dir, 'docs');
    const dbPath = join(dir, 'runtime-exclude.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    // Phase 1: Build WITHOUT excludes — child docs should be indexed
    const builder = new IndexBuilder(store, parentRoot);
    await builder.rebuild();

    const rowsBefore = store.getDb().prepare('SELECT anchor, title FROM evidence_docs').all();
    const hadFinance = rowsBefore.some((r) => r.anchor.includes('finance') || r.title.includes('Finance'));
    assert.strictEqual(hadFinance, true, 'Precondition: finance docs should exist before runtime exclude');

    // Phase 2: Simulate runtime child collection registration — add exclude patterns
    const childManifests = [
      { id: 'domain:finance', root: join(dir, 'docs', 'library', 'finance'), sensitivity: 'private' },
    ];
    const excludes = computeChildExcludes(parentRoot, childManifests);
    builder.addExcludePatterns(excludes);

    // Phase 3: Rebuild — child docs should now be excluded
    await builder.rebuild({ force: true });

    const rowsAfter = store.getDb().prepare('SELECT anchor, title FROM evidence_docs').all();
    const stillHasFinance = rowsAfter.some((r) => r.anchor.includes('finance') || r.title.includes('Finance'));
    assert.strictEqual(
      stillHasFinance,
      false,
      `Finance docs not cleaned up after addExcludePatterns + rebuild: ${JSON.stringify(rowsAfter)}`,
    );

    const hasParentDocs = rowsAfter.some((r) => r.anchor.includes('F001'));
    assert.strictEqual(hasParentDocs, true, `Parent docs should survive: ${JSON.stringify(rowsAfter)}`);
  });

  test('addExcludePatterns + removeBySourcePrefix immediately purges parent rows (P1 R4)', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const parentRoot = join(dir, 'docs');
    const dbPath = join(dir, 'immediate-cleanup.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    // Phase 1: Build WITHOUT excludes — finance docs indexed
    const builder = new IndexBuilder(store, parentRoot);
    await builder.rebuild();

    const rowsBefore = store.getDb().prepare('SELECT anchor, source_path FROM evidence_docs').all();
    const hadFinance = rowsBefore.some((r) => r.source_path?.startsWith('library/finance/'));
    assert.strictEqual(hadFinance, true, 'Precondition: finance rows must exist before cleanup');

    // Phase 2: Simulate runtime register — addExcludePatterns + immediate purge (NO rebuild)
    const childManifests = [
      { id: 'domain:finance', root: join(dir, 'docs', 'library', 'finance'), sensitivity: 'private' },
    ];
    const excludes = computeChildExcludes(parentRoot, childManifests);
    builder.addExcludePatterns(excludes);
    store.removeBySourcePrefix('library/finance/');

    // Phase 3: Verify immediate cleanup WITHOUT rebuild
    const rowsAfter = store.getDb().prepare('SELECT anchor, source_path FROM evidence_docs').all();
    const stillHasFinance = rowsAfter.some((r) => r.source_path?.startsWith('library/finance/'));
    assert.strictEqual(
      stillHasFinance,
      false,
      `Finance rows still present after immediate purge: ${JSON.stringify(rowsAfter)}`,
    );

    const hasParentDocs = rowsAfter.some((r) => r.anchor.includes('F001'));
    assert.strictEqual(hasParentDocs, true, `Parent docs should survive purge: ${JSON.stringify(rowsAfter)}`);
  });

  test('removeBySourcePrefix does not delete sibling paths with underscore (P1 R5)', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const dbPath = join(dir, 'like-escape.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const db = store.getDb();
    const insert = db.prepare(
      'INSERT INTO evidence_docs (anchor, kind, status, title, source_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('target-a', 'research', 'active', 'Target A', 'library/finance_data/a.md', '2026-01-01');
    insert.run('sibling-b', 'research', 'active', 'Sibling B', 'library/financeXdata/b.md', '2026-01-01');
    insert.run('parent-c', 'feature', 'active', 'Parent C', 'features/F001.md', '2026-01-01');

    const deleted = store.removeBySourcePrefix('library/finance_data/');

    const rows = db.prepare('SELECT anchor, source_path FROM evidence_docs').all();
    assert.strictEqual(deleted, 1, `Expected 1 deleted, got ${deleted}`);
    assert.strictEqual(rows.length, 2, `Expected 2 surviving rows, got ${rows.length}`);

    const hasTarget = rows.some((r) => r.anchor === 'target-a');
    assert.strictEqual(hasTarget, false, 'Target row should be deleted');

    const hasSibling = rows.some((r) => r.anchor === 'sibling-b');
    assert.strictEqual(
      hasSibling,
      true,
      `Sibling row with underscore mismatch should survive: ${JSON.stringify(rows)}`,
    );
  });

  test('removeBySourcePrefix also purges stale edges referencing deleted anchors (P1 cloud R1)', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const dbPath = join(dir, 'edge-purge.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const db = store.getDb();
    const insertDoc = db.prepare(
      'INSERT INTO evidence_docs (anchor, kind, status, title, source_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertDoc.run('parent-feat', 'feature', 'active', 'Parent Feature', 'features/F001.md', '2026-01-01');
    insertDoc.run('child-report', 'research', 'active', 'Finance Report', 'library/finance/report.md', '2026-01-01');

    const insertEdge = db.prepare('INSERT INTO edges (from_anchor, to_anchor, relation) VALUES (?, ?, ?)');
    insertEdge.run('parent-feat', 'child-report', 'related');
    insertEdge.run('child-report', 'parent-feat', 'evolved_from');
    insertEdge.run('parent-feat', 'other-anchor', 'related');

    store.removeBySourcePrefix('library/finance/');

    const edges = db.prepare('SELECT from_anchor, to_anchor FROM edges').all();
    const hasChildEdge = edges.some((e) => e.from_anchor === 'child-report' || e.to_anchor === 'child-report');
    assert.strictEqual(
      hasChildEdge,
      false,
      `Stale edges referencing child anchor survived purge: ${JSON.stringify(edges)}`,
    );

    const hasParentEdge = edges.some((e) => e.from_anchor === 'parent-feat' && e.to_anchor === 'other-anchor');
    assert.strictEqual(hasParentEdge, true, `Unrelated parent edge should survive: ${JSON.stringify(edges)}`);
  });

  test('IndexBuilder.addExcludePatterns blocks incrementalUpdate for newly excluded paths', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const parentRoot = join(dir, 'docs');
    const dbPath = join(dir, 'runtime-incremental.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    // Start with no excludes
    const builder = new IndexBuilder(store, parentRoot);

    // Simulate runtime registration — add exclude patterns
    const childManifests = [
      { id: 'domain:finance', root: join(dir, 'docs', 'library', 'finance'), sensitivity: 'private' },
    ];
    const excludes = computeChildExcludes(parentRoot, childManifests);
    builder.addExcludePatterns(excludes);

    // incrementalUpdate with excluded path should be a no-op
    const financePath = join(dir, 'docs', 'library', 'finance', 'report.md');
    await builder.incrementalUpdate([financePath]);

    const rows = store.getDb().prepare('SELECT anchor FROM evidence_docs').all();
    const hasFinance = rows.some((r) => r.anchor.includes('finance'));
    assert.strictEqual(hasFinance, false, `Finance doc upserted after addExcludePatterns: ${JSON.stringify(rows)}`);
  });
});
