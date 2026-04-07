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
});
