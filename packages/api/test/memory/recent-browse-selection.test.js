// F188 Phase H — AC-H2: Guaranteed Minimum selection + AC-H5 regression fixtures
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

// Time-bomb fix (宪宪/opus-4.8, 2026-06-14): fixtures hardcoded 2026-05-* dates against a
// relative `since: '30d'` window. As wall-clock advances past those fixed dates the window
// slides and fixtures fall out of range → "flaky by calendar" (this file started failing on
// 06-14, blocking all merges). Use relative-to-now dates so selection tests are date-stable.
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

async function setupStoreWithDocs(dir, collectionId, docs) {
  const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
  const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
  const { resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js');

  const dbPath = join(dir, `${collectionId.replace(':', '-')}.sqlite`);
  const store = new SqliteEvidenceStore(dbPath);
  await store.initialize();

  const root = join(dir, collectionId.replace(':', '-'));
  mkdirSync(root, { recursive: true });

  for (const doc of docs) {
    const docDir = join(root, doc.subdir || '');
    mkdirSync(docDir, { recursive: true });
    writeFileSync(join(docDir, `${doc.name}.md`), `---\ntitle: ${doc.name}\nkind: research\n---\n\nContent.\n`);
  }

  const manifest = {
    id: collectionId,
    kind: 'project',
    name: collectionId.split(':')[1],
    displayName: collectionId,
    root,
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-05-19',
    updatedAt: '2026-05-19',
  };

  const scanner = resolveCollectionScanner(manifest);
  const builder = new CollectionIndexBuilder(store, manifest, scanner);
  await builder.rebuild();

  // Override updatedAt for deterministic ordering
  const db = store.getDb();
  for (const doc of docs) {
    if (doc.isoDate) {
      db.prepare('UPDATE evidence_docs SET updated_at = ? WHERE anchor LIKE ?').run(doc.isoDate, `%${doc.name}%`);
    }
  }

  return { store, manifest };
}

describe('guaranteed minimum selection (AC-H2)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gm-sel-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('each collection gets ≥1 item even when one dominates', async () => {
    const { RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    // collA: 15 items all from "today" (relative to now)
    const docsA = Array.from({ length: 15 }, (_, i) => ({
      name: `a-doc-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(1),
    }));
    const { store: storeA, manifest: mA } = await setupStoreWithDocs(dir, 'project:alpha', docsA);
    catalog.register(mA);
    stores.set('project:alpha', storeA);

    // collB: 3 items from "yesterday" (relative to now)
    const docsB = Array.from({ length: 3 }, (_, i) => ({
      name: `b-doc-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(25),
    }));
    const { store: storeB, manifest: mB } = await setupStoreWithDocs(dir, 'project:beta', docsB);
    catalog.register(mB);
    stores.set('project:beta', storeB);

    // collC: 3 items from "yesterday", 2h earlier than collB (preserve B > C ordering)
    const docsC = Array.from({ length: 3 }, (_, i) => ({
      name: `c-doc-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(27),
    }));
    const { store: storeC, manifest: mC } = await setupStoreWithDocs(dir, 'project:gamma', docsC);
    catalog.register(mC);
    stores.set('project:gamma', storeC);

    const resolver = new RecentBrowseResolver(catalog, stores);
    const result = await resolver.list({ since: '30d', limit: 10 });

    assert.strictEqual(result.items.length, 10, `Expected 10 items, got ${result.items.length}`);

    const sources = new Set(result.items.map((i) => i.source));
    assert.ok(sources.has('project:alpha'), 'alpha must be represented');
    assert.ok(sources.has('project:beta'), 'beta must be represented');
    assert.ok(sources.has('project:gamma'), 'gamma must be represented');

    const betaCount = result.items.filter((i) => i.source === 'project:beta').length;
    assert.ok(betaCount >= 1, `beta must have ≥1 item, got ${betaCount}`);

    const gammaCount = result.items.filter((i) => i.source === 'project:gamma').length;
    assert.ok(gammaCount >= 1, `gamma must have ≥1 item, got ${gammaCount}`);

    // Verify global updatedAt ordering
    for (let i = 1; i < result.items.length; i++) {
      assert.ok(
        result.items[i - 1].updatedAt >= result.items[i].updatedAt,
        `Items not sorted by updatedAt desc at index ${i}`,
      );
    }
  });

  test('when eligible collections > limit, picks top by recency', async () => {
    const { RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    // 8 collections each with 1 item, limit=5
    for (let c = 0; c < 8; c++) {
      const id = `project:coll-${c}`;
      const docs = [
        {
          name: `doc-${c}`,
          subdir: 'docs',
          // c=0 → 1h ago (most recent) ... c=7 → ~7d ago; all within the 30d `since` window,
          // strictly descending so limit=5 deterministically picks coll-0..4.
          isoDate: hoursAgo(c * 24 + 1),
        },
      ];
      const { store, manifest } = await setupStoreWithDocs(dir, id, docs);
      catalog.register(manifest);
      stores.set(id, store);
    }

    const resolver = new RecentBrowseResolver(catalog, stores);
    const result = await resolver.list({ since: '30d', limit: 5 });

    assert.strictEqual(result.items.length, 5, `Expected 5 items, got ${result.items.length}`);

    // Should be the 5 most recent collections (coll-0 through coll-4)
    const sources = new Set(result.items.map((i) => i.source));
    for (let c = 0; c < 5; c++) {
      assert.ok(sources.has(`project:coll-${c}`), `coll-${c} (recent) must be in results`);
    }
    for (let c = 5; c < 8; c++) {
      assert.ok(!sources.has(`project:coll-${c}`), `coll-${c} (old) must NOT be in results`);
    }
  });

  test('single collection: all items from that collection', async () => {
    const { RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    const docs = Array.from({ length: 5 }, (_, i) => ({
      name: `doc-${i}`,
      subdir: 'docs',
      // i=0 → 1h ago ... i=4 → ~4d ago; all within 30d, descending → limit=3 picks 3 most recent.
      isoDate: hoursAgo(i * 24 + 1),
    }));
    const { store, manifest } = await setupStoreWithDocs(dir, 'project:solo', docs);
    catalog.register(manifest);
    stores.set('project:solo', store);

    const resolver = new RecentBrowseResolver(catalog, stores);
    const result = await resolver.list({ since: '30d', limit: 3 });

    assert.strictEqual(result.items.length, 3);
    assert.ok(result.items.every((i) => i.source === 'project:solo'));
    // Single collection: groups omitted (only 1 collection)
    assert.strictEqual(result.groups, undefined, 'groups should be undefined for single collection');
  });

  test('returns SelectionGroup metadata with count and available (AC-H3)', async () => {
    const { RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    // collA: 10 items
    const docsA = Array.from({ length: 10 }, (_, i) => ({
      name: `a-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(1),
    }));
    const { store: sA, manifest: mA } = await setupStoreWithDocs(dir, 'project:alpha', docsA);
    catalog.register(mA);
    stores.set('project:alpha', sA);

    // collB: 5 items
    const docsB = Array.from({ length: 5 }, (_, i) => ({
      name: `b-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(25),
    }));
    const { store: sB, manifest: mB } = await setupStoreWithDocs(dir, 'project:beta', docsB);
    catalog.register(mB);
    stores.set('project:beta', sB);

    const resolver = new RecentBrowseResolver(catalog, stores);
    const result = await resolver.list({ since: '30d', limit: 8 });

    assert.ok(result.groups, 'groups must be present for multi-collection results');
    assert.ok(Array.isArray(result.groups));
    assert.strictEqual(result.groups.length, 2);

    const totalCount = result.groups.reduce((sum, g) => sum + g.count, 0);
    assert.strictEqual(totalCount, result.items.length, 'sum of group counts must equal items.length');

    for (const g of result.groups) {
      assert.strictEqual(g.type, 'collection');
      assert.ok(g.label.length > 0, 'label must not be empty');
      assert.ok(g.available >= g.count, `available (${g.available}) must be >= count (${g.count})`);
    }
  });
});

describe('AC-H5 regression fixtures', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'h5-reg-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('cross-collection burst: 3 collections, 1 dominant, all represented in limit=20', async () => {
    const { RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    // Dominant: 50 docs from today
    const docsA = Array.from({ length: 50 }, (_, i) => ({
      name: `burst-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(1),
    }));
    const { store: sA, manifest: mA } = await setupStoreWithDocs(dir, 'project:dominant', docsA);
    catalog.register(mA);
    stores.set('project:dominant', sA);

    // Minor B: 3 docs from yesterday
    const docsB = Array.from({ length: 3 }, (_, i) => ({
      name: `minor-b-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(25),
    }));
    const { store: sB, manifest: mB } = await setupStoreWithDocs(dir, 'project:minor-b', docsB);
    catalog.register(mB);
    stores.set('project:minor-b', sB);

    // Minor C: 3 docs from yesterday
    const docsC = Array.from({ length: 3 }, (_, i) => ({
      name: `minor-c-${i}`,
      subdir: 'docs',
      isoDate: hoursAgo(49),
    }));
    const { store: sC, manifest: mC } = await setupStoreWithDocs(dir, 'project:minor-c', docsC);
    catalog.register(mC);
    stores.set('project:minor-c', sC);

    const resolver = new RecentBrowseResolver(catalog, stores);
    const result = await resolver.list({ since: '30d', limit: 20 });

    assert.strictEqual(result.items.length, 20);

    const sources = new Set(result.items.map((i) => i.source));
    assert.ok(sources.has('project:dominant'), 'dominant must be present');
    assert.ok(sources.has('project:minor-b'), 'minor-b must be present despite burst');
    assert.ok(sources.has('project:minor-c'), 'minor-c must be present despite burst');

    const minorBCount = result.items.filter((i) => i.source === 'project:minor-b').length;
    assert.ok(minorBCount >= 1, `minor-b needs ≥1 slot, got ${minorBCount}`);

    const minorCCount = result.items.filter((i) => i.source === 'project:minor-c').length;
    assert.ok(minorCCount >= 1, `minor-c needs ≥1 slot, got ${minorCCount}`);
  });

  test('overlap privacy: private child docs not visible via parent list_recent', async () => {
    const { computeChildExcludes } = await import('../../dist/domains/memory/factory.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
    const { resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js');
    const { RecentBrowseResolver } = await import('../../dist/domains/memory/RecentBrowseResolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const parentRoot = join(dir, 'docs');
    mkdirSync(join(parentRoot, 'features'), { recursive: true });
    mkdirSync(join(parentRoot, 'library', 'finance'), { recursive: true });

    writeFileSync(join(parentRoot, 'features', 'F001.md'), '---\ntitle: Public\nkind: feature\n---\nPublic doc.\n');
    writeFileSync(
      join(parentRoot, 'library', 'finance', 'secret.md'),
      '---\ntitle: Secret\nkind: research\n---\nPrivate.\n',
    );

    const childManifests = [
      { id: 'domain:finance', root: join(parentRoot, 'library', 'finance'), sensitivity: 'private' },
    ];
    const excludes = computeChildExcludes(parentRoot, childManifests);

    // Parent store — indexed WITH exclude
    const parentManifest = {
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

    const parentDbPath = join(dir, 'parent.sqlite');
    const parentStore = new SqliteEvidenceStore(parentDbPath);
    await parentStore.initialize();
    const parentScanner = resolveCollectionScanner(parentManifest);
    const parentBuilder = new CollectionIndexBuilder(parentStore, parentManifest, parentScanner);
    await parentBuilder.rebuild();

    // Child store — indexed separately
    const childManifest = {
      id: 'domain:finance',
      kind: 'domain',
      name: 'finance',
      displayName: 'Finance',
      root: join(parentRoot, 'library', 'finance'),
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-19',
      updatedAt: '2026-05-19',
    };

    const childDbPath = join(dir, 'child.sqlite');
    const childStore = new SqliteEvidenceStore(childDbPath);
    await childStore.initialize();
    const childScanner = resolveCollectionScanner(childManifest);
    const childBuilder = new CollectionIndexBuilder(childStore, childManifest, childScanner);
    await childBuilder.rebuild();

    const catalog = new LibraryCatalog();
    catalog.register(parentManifest);
    catalog.register(childManifest);

    const stores = new Map();
    stores.set('project:test', parentStore);
    stores.set('domain:finance', childStore);

    const resolver = new RecentBrowseResolver(catalog, stores);

    // Without callerCollections for finance — private child should be invisible
    const result = await resolver.list({ since: '30d', limit: 20 });

    const hasFinanceDocs = result.items.some(
      (i) => i.source === 'domain:finance' || i.anchor.includes('finance') || i.anchor.includes('secret'),
    );
    assert.strictEqual(
      hasFinanceDocs,
      false,
      `Private child docs leaked: ${JSON.stringify(result.items.map((i) => ({ anchor: i.anchor, source: i.source })))}`,
    );

    // Parent should still have its own docs
    const hasParentDocs = result.items.some((i) => i.source === 'project:test');
    assert.strictEqual(hasParentDocs, true, 'Parent docs must be present');
  });
});
