#!/usr/bin/env node
/**
 * F188 Phase K — Task 6 dogfood harness
 *
 * Boots a minimal Fastify with ONLY the evidence routes + injected catalog
 * snapshots and hits /api/evidence/status against three reproducible
 * configurations:
 *   1. healthy-baseline   — every detector silent → functionalStatus='ok'
 *   2. reporter-880       — docs ingested but vectors/edges/embedding all
 *                           absent (the original community-reported state)
 *   3. docs-root-broken   — collection.root points to a missing path
 *                           (validates docs_root_suspicious detector)
 *
 * Run:
 *   node packages/api/scripts/f188-phase-k-dogfood.mjs
 *
 * The output JSON for each scenario is what the Memory Center UI sees
 * verbatim — used as backend dogfood evidence in
 * `docs/harness-feedback/2026-06-09-f188-phase-k-dogfood-report.md`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const evidenceRoutesModule = await import(new URL('../dist/routes/evidence.js', import.meta.url).href);
const { evidenceRoutes } = evidenceRoutesModule;

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

async function runScenario(name, { counts, catalogCollections, embeddingReady }) {
  const app = Fastify({ logger: false });
  await app.register(evidenceRoutes, {
    evidenceStore: {
      search: async () => [],
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      getDb: () => makeMockDb(counts),
    },
    embeddingService: { isReady: () => embeddingReady },
    catalog: {
      list: () => catalogCollections,
      getRoutable: () => catalogCollections.filter((m) => (m.status ?? 'active') !== 'archived'),
    },
  });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
  const body = res.json();
  await app.close();
  console.log(`\n=== scenario: ${name} ===`);
  console.log(JSON.stringify(body, null, 2));
  console.log(`functionalStatus=${body.functionalStatus} configWarnings.length=${body.configWarnings.length}`);
}

const existingRoot = mkdtempSync(join(tmpdir(), 'f188-phase-k-dogfood-'));
writeFileSync(join(existingRoot, 'sentinel.md'), '# dogfood sentinel\n');

await runScenario('healthy-baseline', {
  counts: {
    docs_count: 42,
    threads_count: 7,
    edges_count: 18,
    passages_count: 60,
    passage_vectors_count: 60,
    vectors_count: 60,
    embedding_model: 'cl100k_base',
  },
  catalogCollections: [{ id: 'project:demo', root: existingRoot, kind: 'project', status: 'active' }],
  embeddingReady: true,
});

await runScenario('reporter-880', {
  counts: {
    docs_count: 10,
    threads_count: 1,
    edges_count: 0,
    passages_count: 0,
    passage_vectors_count: 0,
    vectors_count: 0,
    embedding_model: null,
  },
  catalogCollections: [{ id: 'project:reporter', root: existingRoot, kind: 'project', status: 'active' }],
  embeddingReady: false,
});

await runScenario('docs-root-broken', {
  counts: {
    docs_count: 5,
    threads_count: 1,
    edges_count: 3,
    passages_count: 5,
    passage_vectors_count: 5,
    vectors_count: 5,
    embedding_model: 'cl100k_base',
  },
  catalogCollections: [
    {
      id: 'project:broken',
      root: '/var/tmp/cat-cafe-f188-phase-k-nonexistent-zzz',
      kind: 'project',
      status: 'active',
    },
  ],
  embeddingReady: true,
});

console.log('\ndogfood harness complete.');
