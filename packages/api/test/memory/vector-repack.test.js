import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { repackPassageVectors } from '../../dist/domains/memory/repack-passage-vectors.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable } from '../../dist/domains/memory/schema.js';

async function fixture(t, file = false) {
  const root = mkdtempSync(join(tmpdir(), 'vector-repack-'));
  const path = file ? join(root, 'db.sqlite') : ':memory:';
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  const db = store.getDb();
  sqliteVec.load(db);
  ensurePassageVectorTable(db, 4);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, store, path, vectors: new PassageVectorStore(db, 4) };
}

function sparse(db, survivors = 80) {
  const insert = db.prepare('INSERT INTO passage_vectors(passage_key,embedding) VALUES(?,?)');
  const remove = db.prepare('DELETE FROM passage_vectors WHERE passage_key=?');
  db.transaction(() => {
    for (let i = 0; i < 32 * 1024; i++)
      insert.run(JSON.stringify(['thread"\u0000', `key-${i}`]), new Float32Array([1, 0, 0, 0]));
    for (let i = 0; i < 32 * 1024; i++)
      if (i % 1024 >= survivors) remove.run(JSON.stringify(['thread"\u0000', `key-${i}`]));
  })();
}

test('repack preserves exact native ties across chunk boundaries and the 2000-hit cutoff', async (t) => {
  const { db, vectors } = await fixture(t);
  sparse(db);
  const query = new Float32Array([1, 0, 0, 0]);
  const budgets = [1, 3, 2000, 2560];
  const before = budgets.map((k) => vectors.search(query, k));
  const values = db
    .prepare('SELECT passage_key,hex(embedding) AS bytes FROM passage_vectors ORDER BY passage_key')
    .all();
  assert.deepEqual(repackPassageVectors(db), { status: 'packed', vectors: 2560, chunksBefore: 32, chunksAfter: 3 });
  assert.deepEqual(
    budgets.map((k) => vectors.search(query, k)),
    before,
  );
  assert.deepEqual(
    db.prepare('SELECT passage_key,hex(embedding) AS bytes FROM passage_vectors ORDER BY passage_key').all(),
    values,
  );
  assert.equal(repackPassageVectors(db).status, 'unchanged');
});

test('failure after native DROP restores every original vector and layout in the same transaction', async (t) => {
  const { db, vectors } = await fixture(t);
  sparse(db, 1);
  const before = vectors.search(new Float32Array([1, 0, 0, 0]), 32);
  const exec = db.exec.bind(db);
  db.exec = (sql) => {
    if (/^CREATE VIRTUAL TABLE/.test(sql)) throw new Error('Injected failure after DROP');
    return exec(sql);
  };
  assert.throws(() => repackPassageVectors(db), /Injected failure/);
  db.exec = exec;
  assert.deepEqual(vectors.search(new Float32Array([1, 0, 0, 0]), 32), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM passage_vectors_chunks').get().n, 32);
  assert.equal(db.prepare("SELECT name FROM sqlite_temp_master WHERE name='passage_vector_repack'").get(), undefined);
  assert.equal(repackPassageVectors(db).status, 'packed');
});

test('a reserved temp collision fails without dropping its owner or the native projection', async (t) => {
  const { db, vectors } = await fixture(t);
  sparse(db, 1);
  db.exec("CREATE TEMP TABLE passage_vector_repack(marker TEXT); INSERT INTO passage_vector_repack VALUES('owner')");
  assert.throws(() => repackPassageVectors(db), /already exists/);
  assert.equal(vectors.count(), 32);
  assert.equal(db.prepare('SELECT marker FROM temp.passage_vector_repack').get().marker, 'owner');
});

test('file owner repacks in a child; a concurrent WAL reader sees its complete old snapshot', async (t) => {
  const { db, store, path, vectors } = await fixture(t, true);
  sparse(db);
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  sqliteVec.load(reader);
  reader.exec('BEGIN');
  const query = new Float32Array([1, 0, 0, 0]);
  const sql = 'SELECT passage_key,distance FROM passage_vectors WHERE embedding MATCH ? AND k=?';
  const before = reader.prepare(sql).all(query, 2000);
  const workers = [];
  const events = channel('cat-cafe.memory-process');
  const listener = (event) => {
    if (event.kind === 'vector-repack') workers.push(event.pid);
  };
  events.subscribe(listener);
  try {
    const result = await store.repackPassageVectors();
    assert.equal(result.status, 'packed');
    assert.ok(workers.length === 1 && workers[0] !== process.pid);
    assert.deepEqual(reader.prepare(sql).all(query, 2000), before);
    reader.exec('ROLLBACK');
    assert.equal(reader.prepare('SELECT count(*) AS n FROM passage_vectors_chunks').get().n, 3);
    assert.deepEqual(
      vectors.search(query, 2000).map((r) => ({ passage_key: r.passageKey, distance: r.distance })),
      before,
    );
  } finally {
    events.unsubscribe(listener);
    reader.close();
  }
});

test('cancellation waits for the killed writer to close before the canonical queue advances', async (t) => {
  const { db, store, vectors } = await fixture(t, true);
  sparse(db);
  const before = vectors.search(new Float32Array([1, 0, 0, 0]), 2000);
  const controller = new AbortController();
  const reason = new Error('cancel vector maintenance');
  let pid;
  const events = channel('cat-cafe.memory-process');
  const listener = (event) => {
    if (event.kind === 'vector-repack' && !pid) {
      pid = event.pid;
      controller.abort(reason);
    }
  };
  events.subscribe(listener);
  try {
    const rejected = assert.rejects(store.repackPassageVectors({ signal: controller.signal }), (e) => e === reason);
    const next = store.runExclusive(() => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }));
    await rejected;
    await next;
    assert.deepEqual(vectors.search(new Float32Array([1, 0, 0, 0]), 2000), before);
    assert.equal((await store.repackPassageVectors()).status, 'packed');
  } finally {
    events.unsubscribe(listener);
  }
});

test('read workers cannot schedule a projection rewrite', async (t) => {
  const { path } = await fixture(t, true);
  const reader = new SqliteEvidenceStore(path, undefined, { workerMode: 'read' });
  await reader.initialize();
  try {
    await assert.rejects(reader.repackPassageVectors(), /Read-only/);
  } finally {
    reader.close();
  }
});
