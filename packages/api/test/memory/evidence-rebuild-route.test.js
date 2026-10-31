import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { RebuildJobTracker } from '../../dist/domains/memory/RebuildJobTracker.js';
import { evidenceRoutes } from '../../dist/routes/evidence.js';

function createMockStore() {
  return {
    search: async () => [],
    health: async () => true,
    initialize: async () => {},
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
  };
}

function createMockIndexBuilder(rebuildFn) {
  return {
    rebuild: rebuildFn ?? (async () => ({ docsIndexed: 5, docsSkipped: 2, durationMs: 100 })),
    incrementalUpdate: async () => {},
    checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
  };
}

describe('POST /api/evidence/rebuild', () => {
  it('returns taskId on success', async () => {
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      indexBuilder: createMockIndexBuilder(),
      rebuildJobTracker: new RebuildJobTracker(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.taskId, 'should return a taskId');
    assert.equal(typeof body.taskId, 'string');
  });

  it('rejects when rebuild already running', async () => {
    const tracker = new RebuildJobTracker();
    const neverResolve = () => new Promise(() => {});
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      indexBuilder: createMockIndexBuilder(neverResolve),
      rebuildJobTracker: tracker,
    });
    await app.ready();

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res1.statusCode, 200);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res2.statusCode, 409);
  });

  it('returns 503 when indexBuilder unavailable', async () => {
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      rebuildJobTracker: new RebuildJobTracker(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 503);
  });
});

describe('GET /api/evidence/rebuild/:taskId', () => {
  it('returns job status after POST', async () => {
    let resolveRebuild;
    const rebuildPromise = () =>
      new Promise((resolve) => {
        resolveRebuild = resolve;
      });
    const tracker = new RebuildJobTracker();
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      indexBuilder: createMockIndexBuilder(rebuildPromise),
      rebuildJobTracker: tracker,
    });
    await app.ready();

    const postRes = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      remoteAddress: '127.0.0.1',
    });
    const { taskId } = postRes.json();

    // Wait for setImmediate — rebuild is deferred to next tick
    await new Promise((r) => setImmediate(r));

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/evidence/rebuild/${taskId}`,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(getRes.statusCode, 200);
    const job = getRes.json();
    assert.equal(job.id, taskId);
    assert.ok(['pending', 'running'].includes(job.status));

    resolveRebuild({ docsIndexed: 1, docsSkipped: 0, durationMs: 50 });
    await new Promise((r) => setTimeout(r, 50));

    const doneRes = await app.inject({
      method: 'GET',
      url: `/api/evidence/rebuild/${taskId}`,
      remoteAddress: '127.0.0.1',
    });
    const doneJob = doneRes.json();
    assert.equal(doneJob.status, 'done');
    assert.equal(doneJob.result.docsIndexed, 1);
  });

  it('returns 404 for unknown taskId', async () => {
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      rebuildJobTracker: new RebuildJobTracker(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/rebuild/nonexistent',
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects non-localhost GET with 403', async () => {
    const tracker = new RebuildJobTracker();
    const taskId = tracker.create();
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      rebuildJobTracker: tracker,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/evidence/rebuild/${taskId}`,
      remoteAddress: '192.168.1.100',
    });
    assert.equal(res.statusCode, 403, 'GET status should also be localhost-only');
  });
});

describe('POST /api/evidence/rebuild (fire-and-forget)', () => {
  it('returns with job still pending — rebuild deferred via setImmediate', async () => {
    const tracker = new RebuildJobTracker();
    const builder = createMockIndexBuilder(async (opts) => {
      opts?.onProgress?.('scanning', 0);
      await new Promise((r) => setTimeout(r, 50));
      return { docsIndexed: 1, docsSkipped: 0, durationMs: 50 };
    });

    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      indexBuilder: builder,
      rebuildJobTracker: tracker,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 200);
    const { taskId } = res.json();
    const job = tracker.get(taskId);
    assert.equal(job.status, 'pending', 'job should still be pending when POST returns (deferred start)');
  });
});
