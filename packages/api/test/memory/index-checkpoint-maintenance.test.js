import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { ProjectionCheckpointBackpressureError } from '../../dist/domains/memory/projection-checkpoints.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

async function fixture(t, inMemory = false) {
  const root = mkdtempSync(join(tmpdir(), 'index-checkpoint-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  const path = join(root, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(inMemory ? ':memory:' : path);
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { docs, store, db: store.getDb(), path };
}

test('online message batches leave WAL backfill to maintenance before releasing the writer queue', async (t) => {
  const { docs, store, db } = await fixture(t);
  const automatic = db.pragma('wal_autocheckpoint', { simple: true });
  const sync = db.pragma('synchronous', { simple: true });
  const messages = Array.from({ length: 256 }, (_, i) => ({
    id: `m-${i}`,
    threadId: 'fixture',
    content: `message ${i} ${'common text '.repeat(3000)}`,
    timestamp: Date.UTC(2026, 0, 1) + i,
  }));
  const builder = new IndexBuilder(
    store,
    docs,
    undefined,
    undefined,
    () => [{ id: 'fixture', title: 'Fixture', participants: [], lastActiveAt: Date.now() }],
    (_thread, limit = 2000) => messages.slice(-limit),
  );
  const transaction = db.transaction.bind(db);
  const commits = [];
  let observing = false;
  t.mock.method(db, 'transaction', (fn) => {
    const tx = transaction(fn);
    return (...args) => {
      if (!observing) return tx(...args);
      const before = db.pragma('main.wal_checkpoint(NOOP)')[0];
      const value = tx(...args);
      const after = db.pragma('main.wal_checkpoint(NOOP)')[0];
      commits.push({ before, after });
      return value;
    };
  });
  const pids = [];
  const telemetry = channel('cat-cafe.memory-process');
  const onProcess = (event) => {
    if (event.kind === 'checkpoint') pids.push(event.pid);
  };
  telemetry.subscribe(onProcess);
  t.after(() => telemetry.unsubscribe(onProcess));
  await builder.rebuild({
    force: true,
    onProgress: (phase) => {
      observing = phase === 'thread-passages';
    },
  });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM evidence_passages WHERE passage_id LIKE 'msg-%'").get().n,
    messages.length,
  );
  assert.ok(commits.length > 1);
  for (const { before, after } of commits) {
    // A WAL restart can reset backfilled frames to zero. A rise within this
    // synchronous commit means that the API itself performed checkpoint I/O.
    assert.ok(
      after.checkpointed <= before.checkpointed,
      `message commit backfilled frames: ${JSON.stringify({ before, after })}`,
    );
  }
  assert.ok(pids.length > 0 && pids.every((pid) => pid !== process.pid));
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), automatic);
  assert.equal(db.pragma('synchronous', { simple: true }), sync);
});

for (const automatic of [0, 37]) {
  test(`indexing maintenance completes before the next queued writer and restores autocheckpoint=${automatic}`, async (t) => {
    const { store, db } = await fixture(t);
    db.exec('CREATE TABLE batch_payload(body BLOB)');
    db.pragma(`wal_autocheckpoint=${automatic}`);
    const synchronous = db.pragma('synchronous', { simple: true });
    const checkpoints = [];
    const telemetry = channel('cat-cafe.entity-mention-checkpoint');
    const listener = (result) => checkpoints.push(result);
    telemetry.subscribe(listener);
    t.after(() => telemetry.unsubscribe(listener));
    const first = store.runCheckpointedBatch(() => {
      db.prepare('INSERT INTO batch_payload VALUES(zeroblob(8388608))').run();
      return 'committed';
    });
    const second = store.runExclusive(() => {
      assert.ok(checkpoints.some((result) => result.busy === 0 && result.log === result.checkpointed));
      assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), automatic);
      assert.equal(db.pragma('synchronous', { simple: true }), synchronous);
      assert.equal(db.prepare('SELECT length(body) AS n FROM batch_payload').get().n, 8388608);
    });
    assert.equal(await first, 'committed');
    await second;
    const original = new Error('index batch rejected');
    await assert.rejects(
      store.runCheckpointedBatch(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO batch_payload VALUES(zeroblob(4096))').run();
          throw original;
        })(),
      ),
      (error) => error === original,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM batch_payload').get().n, 1);
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), automatic);
    assert.equal(await store.runExclusive(() => 42), 42);
  });
}

test('a reader pin stops indexing with committed progress retained and permits retry after release', async (t) => {
  const { store, db, path } = await fixture(t);
  db.exec('CREATE TABLE batch_payload(body BLOB)');
  const reader = new Database(path, { readonly: true });
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM batch_payload').get();
    const automatic = db.pragma('wal_autocheckpoint', { simple: true });
    await assert.rejects(
      store.runCheckpointedBatch(() => {
        db.prepare('INSERT INTO batch_payload VALUES(zeroblob(8388608))').run();
      }),
      ProjectionCheckpointBackpressureError,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM batch_payload').get().n, 1);
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), automatic);
    reader.exec('ROLLBACK');
    await store.runCheckpointedBatch(() => {});
    const state = db.pragma('main.wal_checkpoint(NOOP)')[0];
    assert.equal(state.checkpointed, state.log);
  } finally {
    reader.close();
  }
});

test('memory-only indexing preserves the local transaction result without opening a process', async (t) => {
  const { store, db } = await fixture(t, true);
  const processes = [];
  const telemetry = channel('cat-cafe.memory-process');
  const listener = (event) => processes.push(event);
  telemetry.subscribe(listener);
  t.after(() => telemetry.unsubscribe(listener));
  db.exec('CREATE TABLE batch_payload(value TEXT)');
  assert.equal(
    await store.runCheckpointedBatch(() => {
      db.prepare('INSERT INTO batch_payload VALUES(?)').run('retained');
      return db.prepare('SELECT value FROM batch_payload').get().value;
    }),
    'retained',
  );
  assert.equal(processes.length, 0);
});
