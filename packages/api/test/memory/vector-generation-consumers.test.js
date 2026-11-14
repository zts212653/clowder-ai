import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  deriveProjectCollectionId,
  ensureProjectCollection,
} from '../../dist/domains/memory/bootstrap-collection-bridge.js';
import { LibraryCatalog } from '../../dist/domains/memory/LibraryCatalog.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { evidenceRoutes } from '../../dist/routes/evidence.js';
import { libraryRoutes } from '../../dist/routes/library.js';

function encoder(generationId) {
  const dim = generationId === 'g0' ? 4 : 6;
  return {
    load: async () => {},
    reprobeIfNeeded: async () => {},
    dispose() {},
    isReady: () => true,
    getModelInfo: () => ({
      modelId: `neutral-${generationId}`,
      modelRev: '1',
      dim,
      generationId,
      ...(generationId === 'g1' ? { representationFingerprint: 'a'.repeat(64) } : {}),
    }),
    embed: async (texts) => texts.map(() => Float32Array.from({ length: dim }, (_, i) => Number(i === 0))),
  };
}

function roots(t) {
  const root = mkdtempSync(join(tmpdir(), 'generation-consumers-'));
  const docs = join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'note.md'), '# Neutral source\n\nAn ordinary paragraph.\n');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { root, docs };
}

test('project bootstrap rebuild opens the selected generation and retains the original projection', async (t) => {
  const { root, docs } = roots(t);
  const stores = new Map();
  const catalog = new LibraryCatalog();
  t.after(() => {
    for (const store of stores.values()) store.close();
  });
  let current = encoder('g0');
  await ensureProjectCollection(docs, catalog, stores, join(root, 'data'), 'owner-a', () => current);
  const store = stores.get(deriveProjectCollectionId(docs));
  const old = openVectorGeneration(store.getDb(), current.getModelInfo());
  const count = old.vectorStore.count();
  assert.ok(count > 0);
  current = encoder('g1');
  await ensureProjectCollection(docs, catalog, stores, join(root, 'data'), 'owner-a', () => current);
  assert.equal(store.getVectorGenerationTables().generationId, 'g1');
  assert.equal(openVectorGeneration(store.getDb(), current.getModelInfo()).vectorStore.count(), count);
  assert.equal(old.vectorStore.count(), count);
  assert.equal(catalog.get(deriveProjectCollectionId(docs)).ownerUserId, 'owner-a');
});

test('library HTTP rebuild consumes the same G1 opener and publishes only after source proofs are ready', async (t) => {
  const { root, docs } = roots(t);
  const stores = new Map();
  const catalog = new LibraryCatalog();
  let current = encoder('g0');
  const app = Fastify();
  t.after(async () => {
    await app.close();
    for (const store of stores.values()) store.close();
  });
  await app.register(libraryRoutes, {
    catalog,
    stores,
    dataDir: join(root, 'data'),
    getEmbeddingService: () => current,
    getEmbedMode: () => 'on',
  });
  let res = await app.inject({
    method: 'POST',
    url: '/api/library/register',
    payload: {
      id: 'domain:neutral',
      kind: 'domain',
      name: 'neutral',
      displayName: 'Neutral',
      root: docs,
      sensitivity: 'internal',
      scannerLevel: 0,
    },
  });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'POST', url: '/api/library/domain:neutral/rebuild' });
  assert.equal(res.statusCode, 200);
  const store = stores.get('domain:neutral');
  const original = store.getVectorGenerationTables();
  current = encoder('g1');
  res = await app.inject({ method: 'POST', url: '/api/library/domain:neutral/rebuild' });
  assert.equal(res.statusCode, 200);
  assert.equal(store.getVectorGenerationTables().generationId, 'g1');
  assert.equal(store.getDb().prepare("SELECT state FROM vector_generations WHERE id='g1'").get().state, 'ready');
  assert.equal(original.generationId, 'g0');
});

test('status counts the bound generation and never calls a quarantined projection supported', async (t) => {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const legacy = encoder('g0');
  const current = encoder('g1');
  const old = openVectorGeneration(store.getDb(), legacy.getModelInfo(), { create: true });
  old.vectorStore.initMeta(legacy.getModelInfo());
  old.vectorStore.upsert('old-1', new Float32Array([1, 0, 0, 0]));
  old.vectorStore.upsert('old-2', new Float32Array([1, 0, 0, 0]));
  const active = openVectorGeneration(store.getDb(), current.getModelInfo(), { create: true });
  active.vectorStore.initMeta(current.getModelInfo());
  active.vectorStore.upsert('new-1', new Float32Array([1, 0, 0, 0, 0, 0]));
  store.setEmbedDeps({ embedding: current, ...active, mode: 'on' });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(evidenceRoutes, { evidenceStore: store, getEmbeddingService: () => current });
  let res = await app.inject('/api/evidence/status');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().vectors_count, 1);
  assert.equal(res.json().embedding_model, 'neutral-g1');
  store.getDb().prepare("INSERT INTO embedding_meta_g1 VALUES('vector_invalidation_quarantined','1')").run();
  res = await app.inject('/api/evidence/status');
  assert.equal(res.json().passage_vectors_supported, false);
  assert.equal(res.json().vectors_count, 1, 'persisted rows remain accurately counted while unavailable');
});
