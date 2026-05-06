import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

describe('Collection pipeline E2E (AC-D1)', () => {
  let SqliteEvidenceStore, LibraryCatalog, CollectionIndexBuilder, resolveCollectionScanner, KnowledgeResolver;
  let catalog, stores;

  beforeEach(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
    ({ CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js'));
    ({ resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js'));
    ({ KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js'));
    catalog = new LibraryCatalog();
    stores = new Map();
  });

  it('full pipeline: register → scan → index → search returns results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-'));
    writeFileSync(join(dir, 'lore.md'), '# World Lore\n\nThe ancient civilization built towers of obsidian.');
    writeFileSync(
      join(dir, 'character.md'),
      '---\ndoc_kind: feature\ntopics: [protagonist, backstory]\n---\n# Alexander\n\nA warrior from the northern realm.',
    );
    mkdirSync(join(dir, 'places'));
    writeFileSync(join(dir, 'places', 'citadel.md'), '# The Citadel\n\nA fortress overlooking the valley.');

    const dbPath = join(mkdtempSync(join(tmpdir(), 'e2e-')), 'test.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const manifest = {
      id: 'world:test-lore',
      kind: 'world',
      name: 'test-lore',
      displayName: 'Test Lore',
      root: dir,
      sensitivity: 'internal',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    catalog.register(manifest);
    stores.set('world:test-lore', store);

    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    const result = await builder.rebuild();
    assert.equal(result.indexed, 3);

    const resolver = new KnowledgeResolver({ projectStore: store, catalog, stores });
    const searchResult = await resolver.resolve('ancient civilization', {
      dimension: 'collection',
      collections: ['world:test-lore'],
    });
    assert.ok(searchResult.results.length > 0, 'should find results for "ancient civilization"');
    assert.ok(searchResult.results.some((r) => r.title?.includes('World Lore')));
  });

  it('structured scanner enriches frontmatter docs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'struct-'));
    writeFileSync(
      join(dir, 'char.md'),
      '---\ndoc_kind: feature\ntopics: [warrior, backstory]\nanchor: CHAR-001\n---\n# Character\n\nSee [[World Lore]].',
    );

    const dbPath = join(mkdtempSync(join(tmpdir(), 'struct-db-')), 'test.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const manifest = {
      id: 'world:struct',
      kind: 'world',
      name: 'struct',
      displayName: 'Struct',
      root: dir,
      sensitivity: 'internal',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    catalog.register(manifest);
    stores.set('world:struct', store);
    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    await builder.rebuild();

    const doc = await store.getByAnchor('world:struct:CHAR-001');
    assert.ok(doc, 'frontmatter anchor should be indexed');
    assert.equal(doc.kind, 'feature');
    assert.ok(doc.keywords?.includes('warrior'));
    assert.ok(doc.keywords?.includes('World Lore'), 'WikiLink target should be in keywords');
  });

  it('paths with spaces work correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space dir-'));
    writeFileSync(join(dir, 'note.md'), '# Spaced Path\n\nContent in a spaced directory.');

    const dbPath = join(mkdtempSync(join(tmpdir(), 'space-db-')), 'test.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();

    const manifest = {
      id: 'domain:spaced',
      kind: 'domain',
      name: 'spaced',
      displayName: 'Spaced',
      root: dir,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    catalog.register(manifest);
    stores.set('domain:spaced', store);
    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    const result = await builder.rebuild();
    assert.equal(result.indexed, 1);
  });
});
