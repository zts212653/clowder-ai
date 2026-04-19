/**
 * Evidence Search Route Tests
 * Covers: normal return, degraded fallback, limit validation.
 * F102 Phase D1: SQLite-only — no Hindsight paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { evidenceRoutes } from '../dist/routes/evidence.js';

/** Create a mock IEvidenceStore */
function createMockEvidenceStore(overrides = {}) {
  return {
    search: async () => [],
    health: async () => true,
    initialize: async () => {},
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    ...overrides,
  };
}

describe('GET /api/evidence/search', () => {
  let app;

  async function setup(storeOverrides = {}) {
    app = Fastify();
    const evidenceStore = createMockEvidenceStore(storeOverrides);
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();
  }

  it('returns results from evidence store', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'docs/decisions/005-hindsight-integration-decisions.md',
          kind: 'decision',
          status: 'active',
          title: 'ADR-005 Hindsight Integration',
          summary: 'ADR-005 decided single bank strategy for Hindsight integration',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          anchor: 'docs/phases/phase-4.0-direction.md',
          kind: 'plan',
          status: 'active',
          title: 'Phase 4 Direction',
          summary: 'Phase 4 completed with 460 tests',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=hindsight+bank',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].sourceType, 'decision');
    assert.equal(body.results[0].confidence, 'mid');
    assert.equal(body.results[1].sourceType, 'phase');
    assert.equal(body.results[1].confidence, 'mid');
  });

  it('passes query and limit to evidence store', async () => {
    let capturedArgs;
    await setup({
      search: async (query, opts) => {
        capturedArgs = { query, opts };
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=10',
    });

    assert.equal(capturedArgs.query, 'test');
    assert.equal(capturedArgs.opts.limit, 10);
  });

  it('defaults limit to 5 when omitted', async () => {
    let capturedOpts;
    await setup({
      search: async (_q, opts) => {
        capturedOpts = opts;
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    assert.equal(capturedOpts.limit, 5);
  });

  it('degrades when evidence store throws', async () => {
    await setup({
      search: async () => {
        throw new Error('SQLite error');
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'evidence_store_error');
    assert.deepEqual(body.results, []);
  });

  // ── AC-K1: depth=raw + non-lexical mode returns degradation signal ──
  it('returns degraded=true with effectiveMode for depth=raw + mode=hybrid', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'thread-1',
          kind: 'thread',
          status: 'active',
          title: 'Thread 1',
          summary: 'A thread',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=hybrid',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'raw_lexical_only');
    assert.equal(body.effectiveMode, 'lexical');
    // Results must still be returned (not swallowed)
    assert.equal(body.results.length, 1);
  });

  it('returns degraded=false for depth=raw + mode=lexical (no degradation)', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=lexical',
    });

    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.effectiveMode, undefined);
  });

  it('returns degraded=false when depth is not raw', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&mode=semantic',
    });

    const body = res.json();
    assert.equal(body.degraded, false);
  });

  it('returns 400 for missing q parameter', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search',
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for limit out of range', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=50',
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for limit=0', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=0',
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns empty results for no matches', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=nonexistent_topic_xyz',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.results.length, 0);
  });

  it('respects limit parameter', async () => {
    await setup({
      search: async (_q, opts) => {
        return Array.from({ length: opts.limit }, (_, i) => ({
          anchor: `F${i}`,
          kind: 'feature',
          status: 'active',
          title: `Feature ${i}`,
          summary: `Summary ${i}`,
          updatedAt: '2026-01-01T00:00:00Z',
        }));
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=3',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results.length, 3);
  });

  // ── F163: variantId + boostSource in response ─────────────────────
  it('F163: response includes variantId (12-char hex)', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.ok(body.variantId, 'variantId should be present');
    assert.equal(body.variantId.length, 12);
    assert.match(body.variantId, /^[0-9a-f]{12}$/);
  });

  it('F163: each result has boostSource array with legacy when flags off', async () => {
    // Ensure all F163 flags are off
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    await setup({
      search: async () => [
        {
          anchor: 'test-1',
          kind: 'lesson',
          status: 'active',
          title: 'Test',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.ok(body.results[0].boostSource);
    assert.ok(Array.isArray(body.results[0].boostSource));
    assert.deepEqual(body.results[0].boostSource, ['legacy']);
  });

  it('F163: degraded response also has variantId', async () => {
    await setup({
      search: async () => {
        throw new Error('db error');
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.ok(body.variantId, 'degraded response should still have variantId');
    assert.equal(body.variantId.length, 12);
  });

  it('maps evidence kinds to source types correctly', async () => {
    await setup({
      search: async () => [
        { anchor: 'A1', kind: 'decision', status: 'active', title: 'D', updatedAt: '2026-01-01T00:00:00Z' },
        { anchor: 'A2', kind: 'plan', status: 'active', title: 'P', updatedAt: '2026-01-01T00:00:00Z' },
        { anchor: 'A3', kind: 'feature', status: 'active', title: 'F', updatedAt: '2026-01-01T00:00:00Z' },
        { anchor: 'A4', kind: 'session', status: 'active', title: 'S', updatedAt: '2026-01-01T00:00:00Z' },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.equal(body.results[0].sourceType, 'decision');
    assert.equal(body.results[1].sourceType, 'phase');
    assert.equal(body.results[2].sourceType, 'feature');
    assert.equal(body.results[3].sourceType, 'discussion');
  });
});

// ── GET /api/evidence/status (AC-D8) ──────────────────────────────────
describe('GET /api/evidence/status', () => {
  it('returns status with doc/edge counts from store with getDb()', async () => {
    const app = Fastify();
    const mockDb = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 42 };
          if (sql.includes('edges') && sql.includes('count')) return { c: 10 };
          if (sql.includes('max(updated_at)')) return { t: '2026-03-17T00:00:00Z' };
          return {};
        },
      }),
    };
    const evidenceStore = {
      ...createMockEvidenceStore(),
      getDb: () => mockDb,
    };
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, true);
    assert.equal(body.docs_count, 42);
    assert.equal(body.edges_count, 10);
    assert.equal(body.last_rebuild_at, '2026-03-17T00:00:00Z');
  });

  it('returns healthy=false when getDb is unavailable', async () => {
    const app = Fastify();
    const evidenceStore = createMockEvidenceStore(); // no getDb
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, false);
    assert.equal(body.reason, 'no_db');
  });

  it('returns healthy=false on query error', async () => {
    const app = Fastify();
    const evidenceStore = {
      ...createMockEvidenceStore(),
      getDb: () => ({
        prepare: () => {
          throw new Error('db locked');
        },
      }),
    };
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, false);
    assert.equal(body.reason, 'query_error');
  });
});

// ── POST /api/evidence/reindex (AC-D11/D12/D19) ──────────────────
describe('POST /api/evidence/reindex', () => {
  it('calls incrementalUpdate and returns ok', async () => {
    const app = Fastify();
    let capturedPaths;
    const mockIndexBuilder = {
      incrementalUpdate: async (paths) => {
        capturedPaths = paths;
      },
      rebuild: async () => ({ docsIndexed: 0, docsSkipped: 0, durationMs: 0 }),
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
    };
    const evidenceStore = createMockEvidenceStore();
    await app.register(evidenceRoutes, { evidenceStore, indexBuilder: mockIndexBuilder });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/reindex',
      payload: { paths: ['docs/features/F042.md'] },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(capturedPaths, ['docs/features/F042.md']);
  });

  it('returns 400 for invalid body', async () => {
    const app = Fastify();
    const mockIndexBuilder = {
      incrementalUpdate: async () => {},
      rebuild: async () => ({ docsIndexed: 0, docsSkipped: 0, durationMs: 0 }),
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
    };
    const evidenceStore = createMockEvidenceStore();
    await app.register(evidenceRoutes, { evidenceStore, indexBuilder: mockIndexBuilder });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/reindex',
      payload: { paths: [] },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 503 when indexBuilder unavailable', async () => {
    const app = Fastify();
    const evidenceStore = createMockEvidenceStore();
    await app.register(evidenceRoutes, { evidenceStore }); // no indexBuilder
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/reindex',
      payload: { paths: ['docs/features/F042.md'] },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 503);
  });
});
