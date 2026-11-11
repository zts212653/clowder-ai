import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { applyMigrations, ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

const g1 = Object.freeze({
  generationId: 'g1',
  documents: 'evidence_vectors_g1',
  passages: 'passage_vectors_g1',
  metadata: 'embedding_meta_g1',
  documentSources: 'document_vector_sources_g1',
  passageSources: 'passage_vector_sources_g1',
});
const unit = (dim) => Float32Array.from({ length: dim }, (_, i) => Number(i === 0));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vector-generations-'));
  const path = join(root, 'evidence.sqlite');
  let db = new Database(path);
  sqliteVec.load(db);
  applyMigrations(db);
  db.prepare(`INSERT INTO evidence_docs(anchor,kind,status,title,updated_at)
    VALUES ('owner-sentinel','decision','active','canonical remains here','2026-11-09')`).run();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = new Database(path);
      sqliteVec.load(db);
    },
  };
}

test('an existing document vec0 table cannot claim a different dimension or destroy G0', (t) => {
  const { db } = fixture(t);
  assert.equal(ensureVectorTable(db, 4), true);
  const legacy = new VectorStore(db, 4);
  legacy.upsert('old', unit(4));
  assert.equal(ensureVectorTable(db, 6), false);
  assert.equal(legacy.search(unit(4), 2)[0].anchor, 'old');
  assert.equal(db.prepare('SELECT title FROM evidence_docs').get().title, 'canonical remains here');
});

test('an existing passage vec0 table cannot claim a different dimension', (t) => {
  const { db } = fixture(t);
  assert.equal(ensurePassageVectorTable(db, 4), true);
  const legacy = new PassageVectorStore(db, 4);
  legacy.upsert('old-passage', unit(4));
  assert.equal(ensurePassageVectorTable(db, 6), false);
  assert.equal(legacy.search(unit(4), 2)[0].passageKey, 'old-passage');
});

test('fixed G0/G1 tables coexist, retain independent metadata and survive reopening', (t) => {
  const f = fixture(t);
  for (const [dim, tables] of [
    [4, undefined],
    [6, g1],
  ]) {
    assert.equal(ensureVectorTable(f.db, dim, tables), true);
    assert.equal(ensurePassageVectorTable(f.db, dim, tables), true);
    const documents = new VectorStore(f.db, dim, tables);
    const passages = new PassageVectorStore(f.db, dim, undefined, tables);
    documents.initMeta({ modelId: 'fixture', modelRev: `v${dim}`, dim });
    documents.upsert(`doc-${dim}`, unit(dim));
    passages.upsert(`passage-${dim}`, unit(dim));
  }
  f.reopen();
  const old = new VectorStore(f.db, 4);
  const next = new VectorStore(f.db, 6, g1);
  const nextPassages = new PassageVectorStore(f.db, 6, undefined, g1);
  assert.equal(old.search(unit(4), 2)[0].anchor, 'doc-4');
  assert.equal(next.search(unit(6), 2)[0].anchor, 'doc-6');
  assert.deepEqual([...nextPassages.existingKeys(['passage-4', 'passage-6'])], ['passage-6']);
  assert.equal(nextPassages.search(unit(6), 2)[0].passageKey, 'passage-6');
  assert.equal(old.getMeta().embedding_dim, '4');
  assert.equal(next.getMeta().embedding_dim, '6');
  next.clearAll();
  nextPassages.clearAll();
  assert.equal(next.count(), 0);
  assert.equal(old.count(), 1);
  assert.equal(new PassageVectorStore(f.db, 4).count(), 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 1);
});

test('host table handles reject mismatched identifiers before executing SQL', (t) => {
  const { db } = fixture(t);
  const injected = { ...g1, documents: 'evidence_vectors; DROP TABLE evidence_docs' };
  assert.equal(ensureVectorTable(db, 6, injected), false);
  assert.throws(() => new VectorStore(db, 6, injected), /generation|table|identifier/i);
  assert.throws(
    () => new PassageVectorStore(db, 6, undefined, { ...g1, passages: 'evidence_vectors' }),
    /generation|table|identifier/i,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 1);
});
