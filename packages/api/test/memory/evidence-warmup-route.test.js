import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
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

describe('POST /api/evidence/warmup', () => {
  it('calls startPassageEmbeddingWarmup and returns ok', async () => {
    let called = false;
    const indexBuilder = {
      startPassageEmbeddingWarmup: () => {
        called = true;
      },
      rebuild: async () => ({}),
      incrementalUpdate: async () => {},
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
    };

    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      indexBuilder,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/warmup',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.ok(called, 'startPassageEmbeddingWarmup should have been called');
  });

  it('rejects non-localhost with 403', async () => {
    const indexBuilder = {
      startPassageEmbeddingWarmup: () => {},
      rebuild: async () => ({}),
      incrementalUpdate: async () => {},
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
    };

    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      indexBuilder,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/warmup',
      remoteAddress: '203.0.113.1',
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'Forbidden: localhost only');
  });

  it('allows proxied loopback (same guard as reindex/rebuild)', async () => {
    let called = false;
    const indexBuilder = {
      startPassageEmbeddingWarmup: () => {
        called = true;
      },
      rebuild: async () => ({}),
      incrementalUpdate: async () => {},
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
    };

    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      indexBuilder,
    });
    await app.ready();

    // Proxy headers don't block warmup — the peer IP is still loopback.
    // This matches the guard used by /reindex and /rebuild.
    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/warmup',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(called, 'startPassageEmbeddingWarmup should still be called');
  });

  it('returns 503 when indexBuilder is not configured', async () => {
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: createMockStore(),
      // no indexBuilder
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/warmup',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'warmup not available');
  });
});
