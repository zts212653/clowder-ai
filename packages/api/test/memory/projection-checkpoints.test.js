import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMemoryCheckpoint } from '../../dist/domains/memory/MemoryProcess.js';
import {
  ProjectionCheckpointBackpressureError,
  ProjectionCheckpoints,
  withProjectionCheckpoints,
} from '../../dist/domains/memory/projection-checkpoints.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'projection-checkpoint-'));
  const path = join(root, 'db.sqlite');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)');
  t.after(() => {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, path, root };
}

function insertPages(db, count) {
  db.prepare(
    `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
     INSERT INTO payload(body) SELECT zeroblob(32768) FROM n`,
  ).run(count);
}

test('loaded SQLite contains the WAL reset fix required by concurrent checkpoints', (t) => {
  const { db } = fixture(t);
  const { version } = db.prepare('SELECT sqlite_version() AS version').get();
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))), version);
});

test('a ledger commit cannot inherit the projection backlog released by a reader', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-checkpoint-'));
  const path = join(root, 'db.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  const db = store.getDb();
  db.exec('CREATE TABLE payload(body BLOB)');
  const reader = new Database(path, { readonly: true });
  t.after(() => {
    if (reader.open) reader.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM payload').get();
  await withProjectionCheckpoints(db, path, async (scope) => {
    insertPages(db, 140);
    reader.exec('ROLLBACK');
    const before = db.pragma('main.wal_checkpoint(NOOP)')[0];
    assert.ok(before.log - before.checkpointed > 1000);
    new RunLedger(db).record({
      task_id: 'fixture',
      subject_key: 'fixture',
      outcome: 'RUN_DELIVERED',
      signal_summary: null,
      duration_ms: 0,
      started_at: Date.now(),
      assigned_cat_id: null,
    });
    const after = db.pragma('main.wal_checkpoint(NOOP)')[0];
    assert.equal(after.checkpointed, before.checkpointed, 'ledger must not backfill projection frames');
    await scope.afterBatch();
    const reclaimed = db.pragma('main.wal_checkpoint(NOOP)')[0];
    assert.equal(reclaimed.log, reclaimed.checkpointed);
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_run_ledger').get().n, 1);
  });
});

test('a separate process checkpoints real WAL frames without creating or migrating a database', async (t) => {
  const { db, path, root } = fixture(t);
  db.pragma('wal_autocheckpoint = 0');
  insertPages(db, 140);
  const before = db.pragma('main.wal_checkpoint(NOOP)')[0];
  const workers = [];
  const events = channel('cat-cafe.memory-process');
  const listener = (event) => {
    if (event.kind === 'checkpoint') workers.push(event.pid);
  };
  events.subscribe(listener);
  t.after(() => events.unsubscribe(listener));
  const result = await runMemoryCheckpoint(path);
  assert.ok(before.log - before.checkpointed > 1000);
  assert.equal(result.busy, 0);
  assert.equal(result.checkpointed, result.log);
  assert.ok(result.checkpointed >= before.log);
  assert.ok(workers.length > 0 && workers.every((pid) => pid !== process.pid));
  assert.equal(db.prepare('SELECT count(*) AS n FROM payload').get().n, 140);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_version'").get(), undefined);
  const missing = join(root, 'missing.sqlite');
  await assert.rejects(runMemoryCheckpoint(missing));
  assert.equal(existsSync(missing), false);
});

for (const automatic of [0, 37]) {
  test(`scope restores exact autocheckpoint=${automatic}, preserves sync, and rejects overlapping owners`, async (t) => {
    const { db, path } = fixture(t);
    db.pragma(`wal_autocheckpoint = ${automatic}`);
    const synchronous = db.pragma('synchronous', { simple: true });
    await withProjectionCheckpoints(db, path, async (scope) => {
      assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 0);
      assert.throws(() => new ProjectionCheckpoints(db, path), /already owns/);
      insertPages(db, 140);
      await scope.afterBatch();
      const state = db.pragma('main.wal_checkpoint(NOOP)')[0];
      assert.equal(state.checkpointed, state.log);
    });
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), automatic);
    assert.equal(db.pragma('synchronous', { simple: true }), synchronous);
    const failure = new Error('source mutation failed');
    await assert.rejects(
      withProjectionCheckpoints(db, path, async () => {
        throw failure;
      }),
      (e) => e === failure,
    );
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), automatic);
  });
}

test('PASSIVE reports pinned-reader backpressure and recovers once the reader ends', async (t) => {
  const { db, path } = fixture(t);
  const reader = new Database(path, { readonly: true });
  t.after(() => {
    if (reader.open) reader.close();
  });
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM payload').get();
  const scope = new ProjectionCheckpoints(db, path);
  try {
    insertPages(db, 2200); // >64 MiB backlog; no retries can force this reader to advance.
    await assert.rejects(scope.afterBatch(), (e) => e instanceof ProjectionCheckpointBackpressureError && e.retryable);
    await assert.rejects(scope.drain(), ProjectionCheckpointBackpressureError);
    reader.exec('ROLLBACK');
    await scope.drain();
    const state = db.pragma('main.wal_checkpoint(NOOP)')[0];
    assert.equal(state.checkpointed, state.log);
    assert.equal(db.prepare('SELECT count(*) AS n FROM payload').get().n, 2200);
  } finally {
    scope.restore();
    reader.close();
  }
});

test('released scopes cannot restore over a successor or enter an existing transaction', async (t) => {
  const { db, path } = fixture(t);
  db.pragma('wal_autocheckpoint = 37');
  const first = new ProjectionCheckpoints(db, path);
  first.restore();
  const second = new ProjectionCheckpoints(db, path);
  first.restore();
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 0);
  second.restore();
  db.exec('BEGIN');
  assert.throws(() => new ProjectionCheckpoints(db, path), /open transaction/);
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 37);
  db.exec('ROLLBACK');
});

test('a failed pragma restore keeps the original owner and policy until the same scope restores it', (t) => {
  const { db, path } = fixture(t);
  db.pragma('wal_autocheckpoint=37');
  const scope = new ProjectionCheckpoints(db, path);
  const pragma = db.pragma.bind(db);
  let attempts = 0;
  t.mock.method(db, 'pragma', (sql, ...args) => {
    if (sql === 'wal_autocheckpoint = 37' && ++attempts === 1) throw new Error('restore failed');
    return pragma(sql, ...args);
  });
  assert.throws(() => scope.restore(), /restore failed/);
  assert.equal(db.open, true);
  assert.throws(() => new ProjectionCheckpoints(db, path), /already owns/);
  scope.restore();
  assert.equal(attempts, 2);
  assert.equal(pragma('wal_autocheckpoint', { simple: true }), 37);
  const successor = new ProjectionCheckpoints(db, path);
  scope.restore();
  assert.equal(pragma('wal_autocheckpoint', { simple: true }), 0);
  successor.restore();
  assert.equal(pragma('wal_autocheckpoint', { simple: true }), 37);
});

test('persistent pragma failure preserves the primary error and fences successors without looping', async (t) => {
  const { db, path } = fixture(t);
  db.pragma('wal_autocheckpoint=37');
  const pragma = db.pragma.bind(db);
  const original = new Error('source operation failed');
  let attempts = 0;
  t.mock.method(db, 'pragma', (sql, ...args) => {
    if (sql === 'wal_autocheckpoint = 37') {
      attempts++;
      throw new Error('restore still failed');
    }
    return pragma(sql, ...args);
  });
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(
    withProjectionCheckpoints(db, path, async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(attempts, 1);
  assert.equal(db.open, true);
  assert.throws(() => new ProjectionCheckpoints(db, path), /already owns/);
});

test('maintenance and closed-connection cleanup errors cannot replace the original failure', async (t) => {
  const { db, path, root } = fixture(t);
  const warnings = t.mock.method(console, 'warn', () => {});
  db.pragma('wal_autocheckpoint=37');
  const original = new Error('original source failure');
  await assert.rejects(
    withProjectionCheckpoints(db, join(root, 'missing.sqlite'), async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 37);
  await assert.rejects(
    withProjectionCheckpoints(db, path, async () => {
      db.close();
      throw original;
    }),
    (error) => error === original,
  );
  assert.ok(warnings.mock.calls.some(({ arguments: args }) => args[0].includes('restoration failed')));
});

test('checkpoint cancellation settles only after the actual child is gone, then a new job can run', async (t) => {
  const { db, path } = fixture(t);
  db.pragma('wal_autocheckpoint = 0');
  insertPages(db, 140);
  const controller = new AbortController();
  const reason = new Error('cancel checkpoint');
  let pid;
  const events = channel('cat-cafe.memory-process');
  const listener = (event) => {
    if (event.kind === 'checkpoint' && !pid) {
      pid = event.pid;
      controller.abort(reason);
    }
  };
  events.subscribe(listener);
  t.after(() => events.unsubscribe(listener));
  await assert.rejects(runMemoryCheckpoint(path, { signal: controller.signal }), (e) => e === reason);
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const result = await runMemoryCheckpoint(path);
  assert.equal(result.busy, 0);
  assert.equal(result.log, result.checkpointed);
});
