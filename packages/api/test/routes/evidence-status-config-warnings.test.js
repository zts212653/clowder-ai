/**
 * F188 Phase K — Task 2 + Task 5: /api/evidence/status response integration
 *
 * Covers:
 *   - healthy + no warnings → functionalStatus='ok' + configWarnings=[]
 *   - healthy + multi warnings → functionalStatus='degraded' + codes present
 *   - reporter #880 fixture regression (AC-K5)
 *   - no-catalog path: docs_root_suspicious skipped, other detectors still run
 *   - healthy=false (no_db): functionalStatus='degraded' + configWarnings=[]
 *
 * Spec: docs/features/F188-library-stewardship.md Phase K AC-K1/K3/K5
 * Plan: docs/plans/2026-06-09-f188-phase-k-config-health-surface.md Task 2/5
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';

// Per-SQL canned responses for the mocked sqlite db.
function makeMockDb(counts) {
  const responses = new Map([
    ['SELECT count(*) AS c FROM evidence_docs', { c: counts.docs_count }],
    ["SELECT count(*) AS c FROM evidence_docs WHERE kind = 'thread'", { c: counts.threads_count }],
    ['SELECT count(*) AS c FROM edges', { c: counts.edges_count }],
    ["SELECT value FROM embedding_meta WHERE key = 'last_rebuild_at'", { value: '2026-06-09T00:00:00Z' }],
    ['SELECT max(updated_at) AS t FROM evidence_docs', { t: '2026-06-09T00:00:00Z' }],
    ['SELECT count(*) AS c FROM evidence_passages', { c: counts.passages_count }],
    ['SELECT count(*) AS c FROM passage_vectors', { c: counts.passage_vectors_count }],
    [
      "SELECT value FROM embedding_meta WHERE key = 'embedding_model_id'",
      counts.embedding_model === null ? undefined : { value: counts.embedding_model },
    ],
    ['SELECT count(*) AS c FROM evidence_vectors', { c: counts.vectors_count }],
  ]);
  return {
    prepare(sql) {
      return {
        get() {
          if (!responses.has(sql)) throw new Error(`unmocked sql: ${sql}`);
          return responses.get(sql);
        },
      };
    },
  };
}

function makeMockEvidenceStore(db) {
  return {
    search: async () => [],
    health: async () => true,
    initialize: async () => {},
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    getDb: () => db,
  };
}

function makeMockCatalog(collections) {
  return {
    list: () => collections,
    getRoutable: () => collections.filter((m) => (m.status ?? 'active') !== 'archived'),
  };
}

describe('GET /api/evidence/status — F188 Phase K config warnings', () => {
  let evidenceRoutes;
  let existingNonEmptyRoot;

  before(async () => {
    ({ evidenceRoutes } = await import('../../dist/routes/evidence.js'));
    existingNonEmptyRoot = mkdtempSync(join(tmpdir(), 'f188-phase-k-status-route-'));
    writeFileSync(join(existingNonEmptyRoot, 'sentinel.md'), '# sentinel\n');
  });

  async function setup({ counts, catalog, embeddingReady = true }) {
    const app = Fastify();
    const db = makeMockDb(counts);
    await app.register(evidenceRoutes, {
      evidenceStore: makeMockEvidenceStore(db),
      embeddingService: { isReady: () => embeddingReady },
      ...(catalog ? { catalog } : {}),
    });
    await app.ready();
    return app;
  }

  it('healthy config (no detectors trigger) → functionalStatus=ok + empty warnings', async () => {
    const app = await setup({
      counts: {
        docs_count: 10,
        threads_count: 1,
        edges_count: 5,
        passages_count: 8,
        passage_vectors_count: 8,
        vectors_count: 8,
        embedding_model: 'cl100k_base',
      },
      catalog: makeMockCatalog([
        {
          id: 'project:test',
          root: existingNonEmptyRoot,
          kind: 'project',
          status: 'active',
        },
      ]),
      embeddingReady: true,
    });

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.healthy, true);
    assert.equal(body.functionalStatus, 'ok');
    assert.deepEqual(body.configWarnings, []);
  });

  it('reporter #880 fixture → functionalStatus=degraded with >=3 warnings (AC-K5)', async () => {
    // Reporter #880 state: API live but everything半瘫 (embedding off, vectors=0,
    // edges=0, sqlite-vec missing). Catalog has 1 healthy root so docs_root_suspicious
    // does NOT fire — replicates reporter's case where backend reports green.
    const app = await setup({
      counts: {
        docs_count: 10,
        threads_count: 1,
        edges_count: 0,
        passages_count: 0,
        passage_vectors_count: 0,
        vectors_count: 0,
        embedding_model: null,
      },
      catalog: makeMockCatalog([
        {
          id: 'project:reporter',
          root: existingNonEmptyRoot,
          kind: 'project',
          status: 'active',
        },
      ]),
      embeddingReady: false,
    });

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.healthy, true, 'healthy field unchanged for backward compat (KD-14)');
    assert.equal(body.functionalStatus, 'degraded');
    assert.ok(body.configWarnings.length >= 3, `expected >=3 warnings, got ${body.configWarnings.length}`);
    const codes = body.configWarnings.map((w) => w.code);
    assert.ok(codes.includes('vectors_empty'), 'vectors_empty must trigger');
    assert.ok(codes.includes('graph_empty'), 'graph_empty must trigger');
    assert.ok(codes.includes('embedding_disabled'), 'embedding_disabled must trigger');
    assert.ok(codes.includes('vec_table_missing'), 'vec_table_missing must trigger');
    // every warning must carry suggestedAction + message
    for (const w of body.configWarnings) {
      assert.ok(typeof w.message === 'string' && w.message.length > 0);
      assert.ok(typeof w.suggestedAction === 'string' && w.suggestedAction.length > 0);
    }
  });

  it('reads a newly activated embedding service without recreating Fastify', async () => {
    const app = Fastify();
    const db = makeMockDb({
      docs_count: 10,
      threads_count: 1,
      edges_count: 5,
      passages_count: 8,
      passage_vectors_count: 8,
      vectors_count: 8,
      embedding_model: 'jinaai/jina-embeddings-v2-base-zh',
    });
    let embeddingService;
    await app.register(evidenceRoutes, {
      evidenceStore: makeMockEvidenceStore(db),
      getEmbeddingService: () => embeddingService,
    });
    await app.ready();

    const before = (await app.inject({ method: 'GET', url: '/api/evidence/status' })).json();
    assert.equal(before.passage_vectors_supported, false);

    embeddingService = { isReady: () => true };
    const after = (await app.inject({ method: 'GET', url: '/api/evidence/status' })).json();
    assert.equal(after.passage_vectors_supported, true);
    assert.ok(!after.configWarnings.some((warning) => warning.code === 'embedding_disabled'));
  });

  it('no-catalog scenario → docs_root_suspicious skipped, other detectors still active', async () => {
    const app = await setup({
      counts: {
        docs_count: 10,
        threads_count: 1,
        edges_count: 0, // triggers graph_empty
        passages_count: 8,
        passage_vectors_count: 8,
        vectors_count: 8,
        embedding_model: 'cl100k_base',
      },
      // no catalog passed → opts.catalog is undefined
      embeddingReady: true,
    });

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.functionalStatus, 'degraded');
    const codes = body.configWarnings.map((w) => w.code);
    assert.ok(codes.includes('graph_empty'));
    assert.ok(!codes.includes('docs_root_suspicious'), 'docs_root_suspicious must skip when catalog absent');
  });

  it('healthy=false (no_db) → functionalStatus=degraded + empty configWarnings (schema parity)', async () => {
    // Stand up evidenceStore WITHOUT a getDb to force the no_db branch.
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: {
        search: async () => [],
        health: async () => false,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
        // no getDb → triggers `if (!db) return fatalShape('no_db')`
      },
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.healthy, false);
    assert.equal(body.reason, 'no_db');
    // Schema parity (砚砚 R3 P2-2): the fatal-shape returns extended schema too.
    assert.equal(body.functionalStatus, 'degraded');
    assert.deepEqual(body.configWarnings, []);
  });
});
