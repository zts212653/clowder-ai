import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Knowledge Feed → Materialize integration', () => {
  let tmpDir;
  let markersDir;
  let queue;
  let app;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-kf-${randomUUID().slice(0, 8)}`);
    markersDir = join(tmpDir, 'docs', 'markers');
    mkdirSync(markersDir, { recursive: true });
    mkdirSync(join(tmpDir, 'docs', 'lessons'), { recursive: true });

    const { MarkerQueue } = await import('../dist/domains/memory/MarkerQueue.js');
    const { MaterializationService } = await import('../dist/domains/memory/MaterializationService.js');
    const { knowledgeFeedRoutes } = await import('../dist/routes/knowledge-feed.js');

    queue = new MarkerQueue(markersDir);
    const matService = new MaterializationService(queue, join(tmpDir, 'docs'));

    // Create a minimal in-memory SQLite db for the feed route
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');

    app = Fastify();
    await knowledgeFeedRoutes(app, { markerQueue: queue, db, materializationService: matService });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/knowledge/approve triggers materialize', async () => {
    const marker = await queue.submit({
      content: 'Knowledge to materialize',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    // Transition to approved state first (approve handler does this)
    // But first we need the marker in a state where approve can transition it
    // MarkerQueue allows captured → approved directly

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/approve',
      payload: { markerId: marker.id },
    });

    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.status, 'approved');
    assert.ok(body.materialized, 'should include materialized result');
    assert.ok(body.materialized.outputPath, 'should have outputPath');

    // Marker should now be in 'materialized' state
    const markers = await queue.list({ status: 'materialized' });
    assert.equal(markers.length, 1);
  });

  it('approve blocks visibility-widening for captured marker without confirmation (F186 AC-A10)', async () => {
    const { knowledgeFeedRoutes } = await import('../dist/routes/knowledge-feed.js');
    const { LibraryCatalog } = await import('../dist/domains/memory/LibraryCatalog.js');
    const Database = (await import('better-sqlite3')).default;

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'world:lexander',
      kind: 'world',
      name: 'lexander',
      displayName: 'Lexander World',
      root: '/tmp',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });
    catalog.register({
      id: 'global:methods',
      kind: 'global',
      name: 'methods',
      displayName: 'Global Methods',
      root: '/tmp',
      sensitivity: 'public',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const db = new Database(':memory:');
    const app2 = Fastify();
    await knowledgeFeedRoutes(app2, { markerQueue: queue, db, catalog });
    await app2.ready();

    // Submit a captured marker from a private collection
    const marker = await queue.submit({
      content: 'Secret method from lexander world',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
      sourceCollectionId: 'world:lexander',
      sourceSensitivity: 'private',
    });

    // Approve with widening target but NO confirmation — must be blocked
    const res = await app2.inject({
      method: 'POST',
      url: '/api/knowledge/approve',
      payload: {
        markerId: marker.id,
        targetCollectionId: 'global:methods',
      },
    });

    assert.equal(res.statusCode, 400, 'should block widening without confirmation');
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('visibility-widening'), 'error should mention visibility-widening');

    await app2.close();
  });

  it('approve blocks widening when source collection missing from catalog but marker has sourceSensitivity (cloud R3 P1)', async () => {
    const { knowledgeFeedRoutes } = await import('../dist/routes/knowledge-feed.js');
    const { LibraryCatalog } = await import('../dist/domains/memory/LibraryCatalog.js');
    const Database = (await import('better-sqlite3')).default;

    const catalog = new LibraryCatalog();
    // Only register target — source deliberately NOT in catalog
    catalog.register({
      id: 'global:methods',
      kind: 'global',
      name: 'methods',
      displayName: 'Global Methods',
      root: '/tmp',
      sensitivity: 'public',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const db = new Database(':memory:');
    const app4 = Fastify();
    await knowledgeFeedRoutes(app4, { markerQueue: queue, db, catalog });
    await app4.ready();

    // Marker carries sourceSensitivity=private but sourceCollectionId is NOT in catalog
    const marker = await queue.submit({
      content: 'Private knowledge from unregistered source',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
      sourceCollectionId: 'world:unregistered',
      sourceSensitivity: 'private',
    });

    const res = await app4.inject({
      method: 'POST',
      url: '/api/knowledge/approve',
      payload: {
        markerId: marker.id,
        targetCollectionId: 'global:methods',
      },
    });

    assert.equal(res.statusCode, 400, 'should block widening even when source not in catalog');
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('visibility-widening'), 'error should mention visibility-widening');

    await app4.close();
  });

  it('approve blocks widening when marker has sourceSensitivity without sourceCollectionId (cloud R4 P1)', async () => {
    const { knowledgeFeedRoutes } = await import('../dist/routes/knowledge-feed.js');
    const { LibraryCatalog } = await import('../dist/domains/memory/LibraryCatalog.js');
    const Database = (await import('better-sqlite3')).default;

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'global:methods',
      kind: 'global',
      name: 'methods',
      displayName: 'Global Methods',
      root: '/tmp',
      sensitivity: 'public',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const db = new Database(':memory:');
    const app5 = Fastify();
    await knowledgeFeedRoutes(app5, { markerQueue: queue, db, catalog });
    await app5.ready();

    const marker = await queue.submit({
      content: 'Private knowledge from a backfilled marker',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
      sourceSensitivity: 'private',
    });

    const res = await app5.inject({
      method: 'POST',
      url: '/api/knowledge/approve',
      payload: {
        markerId: marker.id,
        targetCollectionId: 'global:methods',
      },
    });

    assert.equal(res.statusCode, 400, 'should block widening from marker sourceSensitivity alone');
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('visibility-widening'), 'error should mention visibility-widening');

    await app5.close();
  });

  it('approve blocks widening when sourceSensitivity is malformed/unknown (cloud R5 P1)', async () => {
    const { knowledgeFeedRoutes } = await import('../dist/routes/knowledge-feed.js');
    const { LibraryCatalog } = await import('../dist/domains/memory/LibraryCatalog.js');
    const Database = (await import('better-sqlite3')).default;

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'global:methods',
      kind: 'global',
      name: 'methods',
      displayName: 'Global Methods',
      root: '/tmp',
      sensitivity: 'public',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const db = new Database(':memory:');
    const app6 = Fastify();
    await knowledgeFeedRoutes(app6, { markerQueue: queue, db, catalog });
    await app6.ready();

    const marker = await queue.submit({
      content: 'Marker with garbage sensitivity',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
      sourceSensitivity: 'garbage-value',
    });

    const res = await app6.inject({
      method: 'POST',
      url: '/api/knowledge/approve',
      payload: {
        markerId: marker.id,
        targetCollectionId: 'global:methods',
      },
    });

    assert.equal(res.statusCode, 400, 'unknown sensitivity should fail closed');
    const body = JSON.parse(res.body);
    assert.ok(
      body.error.includes('visibility-widening') || body.error.includes('sensitivity'),
      'should block unknown sensitivity',
    );

    await app6.close();
  });

  it('approve rejects unknown targetCollectionId (cloud P1 fix)', async () => {
    const { knowledgeFeedRoutes } = await import('../dist/routes/knowledge-feed.js');
    const { LibraryCatalog } = await import('../dist/domains/memory/LibraryCatalog.js');
    const Database = (await import('better-sqlite3')).default;

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'project:a',
      kind: 'project',
      name: 'a',
      displayName: 'A',
      root: '/tmp',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-03',
      updatedAt: '2026-05-03',
    });

    const db = new Database(':memory:');
    const app3 = Fastify();
    await knowledgeFeedRoutes(app3, { markerQueue: queue, db, catalog });
    await app3.ready();

    const marker = await queue.submit({
      content: 'test content',
      source: 'opus:t1',
      status: 'captured',
    });

    const res = await app3.inject({
      method: 'POST',
      url: '/api/knowledge/approve',
      payload: { markerId: marker.id, targetCollectionId: 'nonexistent:typo' },
    });

    assert.equal(res.statusCode, 400, 'should reject unknown target collection');
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Unknown target collection'));

    await app3.close();
  });

  it('approve requires targetCollectionId for private/restricted source markers (cloud R7 P1)', async () => {
    const { knowledgeFeedRoutes } = await import('../dist/routes/knowledge-feed.js');
    const { LibraryCatalog } = await import('../dist/domains/memory/LibraryCatalog.js');
    const Database = (await import('better-sqlite3')).default;

    const catalog = new LibraryCatalog();
    const db = new Database(':memory:');
    const app7 = Fastify();
    await knowledgeFeedRoutes(app7, { markerQueue: queue, db, catalog });
    await app7.ready();

    const marker = await queue.submit({
      content: 'Private knowledge without explicit target',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
      sourceCollectionId: 'world:secret',
      sourceSensitivity: 'private',
    });

    // Approve WITHOUT targetCollectionId — should be blocked for private source
    const res = await app7.inject({
      method: 'POST',
      url: '/api/knowledge/approve',
      payload: { markerId: marker.id },
    });

    assert.equal(res.statusCode, 400, 'should block approval of private marker without explicit target');

    await app7.close();
  });
});
