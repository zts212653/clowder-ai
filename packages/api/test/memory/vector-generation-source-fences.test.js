import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';
import { vectorGenerationTables } from '../../dist/domains/memory/vector-generation-tables.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vector-source-fences-'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  const vectors = new VectorStore(db, 4);
  const item = {
    anchor: 'doc',
    title: 'Original',
    summary: 'neutral body',
    kind: 'feature',
    status: 'active',
    sourceHash: 'same-source-hash',
    updatedAt: '2026-11-09T19:00:00Z',
    packId: 'fixture-pack',
  };
  await store.upsert([item]);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, db, vectors, item };
}

test('an encoder result cannot publish after canonical input changes with an unchanged source_hash', async (t) => {
  const f = await fixture(t);
  const embedding = {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 4 }),
    embed: async () => {
      await f.store.upsertForDocumentIndex({ ...f.item, title: 'Changed during encode' });
      return [new Float32Array([1, 0, 0, 0])];
    },
  };
  const builder = new IndexBuilder(f.store, f.root, { embedding, vectorStore: f.vectors });
  const result = await builder.embedMissingDocumentVectors();
  assert.equal(result.docsEmbedded, 0);
  assert.equal(f.vectors.count(), 0);
  assert.equal((await f.store.getByAnchor('doc')).title, 'Changed during encode');
});

test('a canonical delete invalidates retained generations as well as active G0', async (t) => {
  const f = await fixture(t);
  const tables = vectorGenerationTables('g1');
  ensureVectorTable(f.db, 6, tables);
  const next = new VectorStore(f.db, 6, tables);
  f.vectors.upsert('doc', new Float32Array([1, 0, 0, 0]));
  next.upsert('doc', new Float32Array([1, 0, 0, 0, 0, 0]));
  await f.store.deleteByAnchor('doc');
  assert.equal(f.vectors.count(), 0);
  assert.equal(next.count(), 0);
});

test('pack deletion cannot leave a vector behind for a later rollback', async (t) => {
  const f = await fixture(t);
  f.vectors.upsert('doc', new Float32Array([1, 0, 0, 0]));
  assert.equal(await f.store.deleteByPackId('fixture-pack'), 1);
  assert.equal(f.vectors.count(), 0);
});
