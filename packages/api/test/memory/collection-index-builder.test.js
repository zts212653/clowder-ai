// F186 Phase B Task 4: CollectionIndexBuilder — wires scanner to evidence store
// Orchestrates: scanner.discover() → hash dedup → store.upsert() → stale cleanup

import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('CollectionIndexBuilder', () => {
  let CollectionIndexBuilder, FlatScanner, StructuredScanner, SqliteEvidenceStore;
  let store, dbPath;

  beforeEach(async () => {
    ({ CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js'));
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    ({ StructuredScanner } = await import('../../dist/domains/memory/StructuredScanner.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'col-idx-')), 'test.sqlite');
    store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {}
  });

  const makeManifest = (root) => ({
    id: 'test:col',
    kind: 'domain',
    name: 'col',
    displayName: 'Col',
    root,
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-05-04',
    updatedAt: '2026-05-04',
  });

  it('indexes markdown files into evidence store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-docs-'));
    writeFileSync(join(dir, 'readme.md'), '# README\n\nProject overview.');
    writeFileSync(join(dir, 'guide.md'), '# Guide\n\nHow to use.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:col');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    const result = await builder.rebuild();

    assert.equal(result.indexed, 2);
    const item = await store.getByAnchor('test:col:doc/readme');
    assert.ok(item);
    assert.equal(item.title, 'README');
  });

  it('skips unchanged files on rebuild (hash dedup)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-dedup-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc\n\nContent.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:col');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const r1 = await builder.rebuild();
    assert.equal(r1.indexed, 1);

    const r2 = await builder.rebuild();
    assert.equal(r2.skipped, 1);
    assert.equal(r2.indexed, 0);
  });

  it('cleans stale anchors when file removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-stale-'));
    const file = join(dir, 'temp.md');
    writeFileSync(file, '# Temp\n\nWill be removed.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:col');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    await builder.rebuild();
    assert.ok(await store.getByAnchor('test:col:doc/temp'));

    unlinkSync(file);
    await builder.rebuild();
    assert.equal(await store.getByAnchor('test:col:doc/temp'), null);
  });

  it('force rebuild re-indexes all files regardless of hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-force-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc\n\nContent.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:col');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    await builder.rebuild();
    const r2 = await builder.rebuild({ force: true });
    assert.equal(r2.indexed, 1);
    assert.equal(r2.skipped, 0);
  });

  it('re-indexes when file content changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-update-'));
    const file = join(dir, 'doc.md');
    writeFileSync(file, '# Original\n\nFirst version.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:col');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    await builder.rebuild();
    assert.equal((await store.getByAnchor('test:col:doc/doc'))?.title, 'Original');

    writeFileSync(file, '# Updated\n\nSecond version.');
    const r2 = await builder.rebuild();
    assert.equal(r2.indexed, 1);
    assert.equal((await store.getByAnchor('test:col:doc/doc'))?.title, 'Updated');
  });

  it('only cleans anchors with matching collection prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-prefix-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc');

    // Insert a foreign anchor that should NOT be cleaned
    store.upsert([
      {
        anchor: 'other:col:doc/foreign',
        kind: 'research',
        status: 'active',
        title: 'Foreign',
        sourceHash: 'abc',
        updatedAt: new Date().toISOString(),
      },
    ]);

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:col');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    await builder.rebuild();

    assert.ok(await store.getByAnchor('other:col:doc/foreign'), 'foreign anchor should survive');
    assert.ok(await store.getByAnchor('test:col:doc/doc'), 'own anchor should exist');
  });

  it('cleans frontmatter-anchored items when source file removed (P1-1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-fm-stale-'));
    const file = join(dir, 'adr.md');
    writeFileSync(file, '---\nanchor: ADR-099\ndoc_kind: decision\n---\n# ADR 99\n\nDecision.');

    const manifest = makeManifest(dir);
    const scanner = new StructuredScanner('test:col');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    await builder.rebuild();
    const adr = await store.getByAnchor('test:col:ADR-099');
    assert.ok(adr, 'frontmatter-anchored item should be indexed with collection prefix');

    unlinkSync(file);
    await builder.rebuild();
    assert.equal(
      await store.getByAnchor('test:col:ADR-099'),
      null,
      'frontmatter anchor should be cleaned after file removal',
    );
  });
});
