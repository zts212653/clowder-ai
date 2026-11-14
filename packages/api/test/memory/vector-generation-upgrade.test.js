import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('V80 upgrade preserves legacy vector bytes, canonical data and unrelated owner state without backdating identity', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'generation-v80-'));
  const path = join(root, 'evidence.sqlite');
  let store = new SqliteEvidenceStore(path);
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert([
    {
      anchor: 'neutral-old',
      title: 'Retained canonical source',
      summary: 'Original body',
      kind: 'thread',
      status: 'active',
      sourceHash: 'h1',
      updatedAt: '2026-11-09',
    },
  ]);
  const model = { modelId: 'neutral-legacy', modelRev: '1', dim: 4 };
  const legacy = openVectorGeneration(store.getDb(), model, { create: true });
  legacy.vectorStore.initMeta(model);
  legacy.vectorStore.upsert('neutral-old', new Float32Array([1, 0, 0, 0]));
  const before = store
    .getDb()
    .prepare('SELECT hex(embedding) AS value FROM evidence_vectors WHERE anchor=?')
    .get('neutral-old');
  const canonical = await store.getByAnchor('neutral-old');
  const db = store.getDb();
  // V81 adds only these ordinary proofs/registry and the revision column to legacy G0.
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'vector_g%'")
    .all())
    db.exec(`DROP TRIGGER ${name}`);
  db.exec(`DROP TABLE vector_generations;DROP TABLE document_vector_sources_g1;DROP TABLE passage_vector_sources_g1;
    DROP TABLE embedding_meta_g1;DROP TABLE passage_vector_sources;
    ALTER TABLE document_vector_sources DROP COLUMN revision_hash;
    INSERT OR REPLACE INTO document_vector_sources(anchor,source_hash) VALUES('neutral-old','h1');
    CREATE TABLE fixture_owner_lifecycle(payload TEXT NOT NULL);
    INSERT INTO fixture_owner_lifecycle VALUES('preserve owner lifecycle and publication state');
    DELETE FROM schema_version WHERE version>=81;`);
  assert.equal(db.prepare('SELECT max(version) AS v FROM schema_version').get().v, 80);
  store.close();
  store = new SqliteEvidenceStore(path);
  await store.initialize();
  const reopened = openVectorGeneration(store.getDb(), model);
  assert.deepEqual(
    store.getDb().prepare('SELECT hex(embedding) AS value FROM evidence_vectors WHERE anchor=?').get('neutral-old'),
    before,
  );
  assert.deepEqual(await store.getByAnchor('neutral-old'), canonical);
  assert.equal(
    store.getDb().prepare('SELECT payload FROM fixture_owner_lifecycle').get().payload,
    'preserve owner lifecycle and publication state',
  );
  assert.equal(reopened.vectorStore.getMeta().embedding_representation_fingerprint, undefined);
  assert.equal(
    store.getDb().prepare('SELECT revision_hash FROM document_vector_sources WHERE anchor=?').get('neutral-old')
      .revision_hash,
    null,
  );
  assert.equal(
    store.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_vectors_g1'").get(),
    undefined,
    'schema installation never constructs the new vector space',
  );
});
