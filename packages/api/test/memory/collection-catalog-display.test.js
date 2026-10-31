import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('Collection catalog display (AC-D2)', () => {
  let Fastify, libraryRoutes, LibraryCatalog, SqliteEvidenceStore, CollectionIndexBuilder, resolveCollectionScanner;
  let app, catalog, stores, dbPath;

  beforeEach(async () => {
    Fastify = (await import('fastify')).default;
    ({ libraryRoutes } = await import('../../dist/routes/library.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    ({ CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js'));
    ({ resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js'));
    catalog = new LibraryCatalog();
    stores = new Map();
    dbPath = join(mkdtempSync(join(tmpdir(), 'disp-')), 'test.sqlite');
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('catalog endpoint shows overview + health for populated collection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-disp-'));
    writeFileSync(join(dir, 'arch.md'), '---\ndoc_kind: decision\n---\n# Architecture\n\nWe decided on X.');
    writeFileSync(join(dir, 'story.md'), '# Story\n\nOnce upon a time.');
    writeFileSync(join(dir, 'plan.md'), '---\ndoc_kind: plan\n---\n# Plan\n\nPhase 1 does Y.');

    const manifest = {
      id: 'world:display',
      kind: 'world',
      name: 'display',
      displayName: 'Display World',
      root: dir,
      sensitivity: 'internal',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    catalog.register(manifest);

    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
    stores.set('world:display', store);

    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    await builder.rebuild();

    app = Fastify();
    await app.register(libraryRoutes, { catalog, stores });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/library/catalog' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const col = body.collections.find((c) => c.manifest.id === 'world:display');
    assert.ok(col, 'collection should appear in catalog');

    assert.equal(col.overview.docCount, 3);
    assert.ok(col.overview.topKinds.length > 0, 'topKinds should be populated');
    assert.ok(col.overview.recentAnchors.length > 0, 'recentAnchors should be populated');

    assert.ok(col.health.indexFreshness, 'indexFreshness should be set');
    assert.equal(typeof col.health.orphanedAnchorCount, 'number');
  });

  it('detail endpoint shows single collection overview + health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'detail-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc\n\nContent.');
    const manifest = {
      id: 'world:detail',
      kind: 'world',
      name: 'detail',
      displayName: 'Detail World',
      root: dir,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    catalog.register(manifest);
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
    stores.set('world:detail', store);
    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    await builder.rebuild();

    app = Fastify();
    await app.register(libraryRoutes, { catalog, stores });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/library/world:detail' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.overview.docCount, 1);
    assert.ok(body.health.indexFreshness);
  });
});
