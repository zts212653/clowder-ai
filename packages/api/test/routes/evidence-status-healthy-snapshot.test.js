/**
 * F188 Phase K — Task 3: External healthcheck backward-compat snapshot
 *
 * AC-K6 + KD-14: external healthcheck consumers read `body.healthy` (boolean)
 * and `body.reason` (when healthy=false). Phase K adds `functionalStatus` +
 * `configWarnings[]` ALONGSIDE these fields — never reshapes or replaces them.
 *
 * This snapshot locks the pre-Phase-K contract:
 *   - `healthy` field exists, boolean
 *   - `healthy=true` value preserved on success path
 *   - `healthy=false` + `reason` preserved on no_db / query_error paths
 *   - all pre-existing fields (docs_count, threads_count, edges_count,
 *     vectors_count, passage_vectors_count, passage_vectors_supported,
 *     passages_count, last_rebuild_at, embedding_model, backend) still present
 *     with the same types
 *
 * Spec: docs/features/F188-library-stewardship.md Phase K AC-K6 + KD-14
 * Plan: docs/plans/2026-06-09-f188-phase-k-config-health-surface.md Task 3
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';

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

/**
 * Pre-Phase-K healthy response shape (baseline). Phase K adds 2 new fields
 * but keeps everything else identical. Snapshot the type signature, not
 * literal values for fields driven by db counts / catalog state.
 */
const HEALTHY_BASELINE_FIELD_TYPES = {
  backend: 'string',
  healthy: 'boolean',
  docs_count: 'number',
  threads_count: 'number',
  passages_count: 'number',
  passage_vectors_count: 'number',
  passage_vectors_supported: 'boolean',
  edges_count: 'number',
  vectors_count: 'number',
  // last_rebuild_at can be string | null
  // embedding_model can be string | null
};

const PHASE_K_ADDITIONS = ['functionalStatus', 'configWarnings'];

describe('GET /api/evidence/status — backward-compat snapshot (AC-K6 / KD-14)', () => {
  let evidenceRoutes;
  let existingRoot;

  before(async () => {
    ({ evidenceRoutes } = await import('../../dist/routes/evidence.js'));
    existingRoot = mkdtempSync(join(tmpdir(), 'f188-phase-k-snapshot-'));
    writeFileSync(join(existingRoot, 's.md'), '# s\n');
  });

  it('healthy=true path: pre-Phase-K fields preserved + Phase K fields added (not replacing)', async () => {
    const app = Fastify();
    const db = makeMockDb({
      docs_count: 10,
      threads_count: 2,
      edges_count: 4,
      passages_count: 8,
      passage_vectors_count: 8,
      vectors_count: 8,
      embedding_model: 'cl100k_base',
    });
    await app.register(evidenceRoutes, {
      evidenceStore: makeMockEvidenceStore(db),
      embeddingService: { isReady: () => true },
      catalog: {
        list: () => [{ id: 'project:test', root: existingRoot, kind: 'project', status: 'active' }],
        getRoutable: () => [],
      },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    // ---- baseline contract: every pre-existing field present + correct type
    for (const [field, expectedType] of Object.entries(HEALTHY_BASELINE_FIELD_TYPES)) {
      assert.ok(field in body, `pre-Phase-K field "${field}" missing from response`);
      assert.equal(
        typeof body[field],
        expectedType,
        `pre-Phase-K field "${field}" type changed: expected ${expectedType}, got ${typeof body[field]}`,
      );
    }
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, true, 'healthy=true value preserved');
    // nullable fields: at minimum present (string or null)
    assert.ok('last_rebuild_at' in body);
    assert.ok('embedding_model' in body);

    // ---- Phase K extension: present, added next to existing fields
    for (const field of PHASE_K_ADDITIONS) {
      assert.ok(field in body, `Phase K field "${field}" missing`);
    }
    assert.ok(['ok', 'degraded'].includes(body.functionalStatus));
    assert.ok(Array.isArray(body.configWarnings));
  });

  it('healthy=false (no_db) path: { healthy:false, reason } preserved + Phase K parity', async () => {
    const app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore: {
        search: async () => [],
        health: async () => false,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
        // no getDb → no_db branch
      },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    // pre-Phase-K contract
    assert.equal(body.backend, 'sqlite');
    assert.equal(typeof body.healthy, 'boolean');
    assert.equal(body.healthy, false, 'healthy=false value preserved');
    assert.equal(body.reason, 'no_db', 'reason field preserved');

    // Phase K parity (砚砚 R3 P2-2)
    assert.equal(body.functionalStatus, 'degraded');
    assert.deepEqual(body.configWarnings, []);
  });

  it('healthy=false (query_error) path: same backward-compat contract', async () => {
    const app = Fastify();
    // db that throws on the very first query → exception bubbles → query_error
    const failingDb = {
      prepare() {
        return {
          get() {
            throw new Error('simulated query failure');
          },
        };
      },
    };
    await app.register(evidenceRoutes, {
      evidenceStore: makeMockEvidenceStore(failingDb),
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, false);
    assert.equal(body.reason, 'query_error');
    assert.equal(body.functionalStatus, 'degraded');
    assert.deepEqual(body.configWarnings, []);
  });

  it('external healthcheck contract: { healthy } can be parsed without knowing Phase K fields', () => {
    // Simulate what an external healthcheck script does — only reads `healthy`.
    // The point of this test is to document the contract: external consumers
    // that ignore unknown fields keep working forever as long as `healthy`
    // stays boolean.
    const healthyResponse = {
      backend: 'sqlite',
      healthy: true,
      // ... other fields ...
      functionalStatus: 'degraded',
      configWarnings: [{ code: 'vectors_empty', message: 'x', suggestedAction: 'y' }],
    };
    // External consumer reading just `healthy`:
    const externalDecision = healthyResponse.healthy ? 'live' : 'dead';
    assert.equal(externalDecision, 'live', 'healthy=true still maps to live for external healthchecks');
  });
});
