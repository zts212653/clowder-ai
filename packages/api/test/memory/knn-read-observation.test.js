import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MemoryReadExecution } from '../../dist/domains/memory/memory-read-execution.js';
import { describePassageVectorRead } from '../../dist/domains/memory/native-vector-read-context.js';
import {
  captureNativeReadResources,
  nativeReadResourceDelta,
} from '../../dist/infrastructure/sqlite-native-read-resources.js';
import { createSqliteReadDiagnostics } from '../../dist/infrastructure/sqlite-read-diagnostics.js';

test('native KNN witnesses retain measured time and resources through delayed receipt, hydration and failure', (t) => {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec('CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY,embedding float[4])');
  db.prepare('INSERT INTO passage_vectors VALUES(?,?)').run('private-key-canary', new Float32Array([1, 0, 0, 0]));
  const events = [];
  const detach = createSqliteReadDiagnostics({
    onSlowRead() {},
    onReadStarted: (event) => events.push({ kind: 'start', ...event }),
    onReadFinished: (event) => events.push({ kind: 'finish', ...event }),
    describeNativeRead: (_sql, args) => ({ kind: 'vector-knn', requestedK: args[1], dimensions: args[0].length }),
  })(db);
  try {
    const rows = db
      .prepare('SELECT passage_key,distance FROM passage_vectors WHERE embedding MATCH ? AND k=?')
      .all(new Float32Array([1, 0, 0, 0]), 7);
    assert.deepEqual(rows, [{ passage_key: 'private-key-canary', distance: 0 }]);
    assert.equal(events.length, 2);
    assert.equal(events[0].native?.requestedK, 7, 'real native start must retain the actual requested k');
    assert.equal(events[0].native.dimensions, 4);
    assert.ok(events[0].native.resourcesBefore.userCpuUs >= 0);
    assert.equal(events[0].native.resourcesAfter, undefined, 'no fabricated finish at start');
    assert.ok(events[1].native.resourceDelta.userCpuUs >= 0);
    assert.ok(events[1].native.resourceDelta.systemCpuUs >= 0);
    assert.equal(events[1].native.resourceDelta.maxRssKiB, undefined, 'lifetime high water is not call allocation');
    assert.equal(events[1].rows, 1);
    assert.doesNotMatch(JSON.stringify(events), /private-key-canary|SELECT|embedding|bindings/);

    const execution = new MemoryReadExecution('message-search');
    execution.observe({ phase: 'sql-start', sql: events[0] });
    assert.equal(Object.hasOwn(execution.snapshot('pending').nativeVectorRead, 'elapsedMs'), false);
    // The parent may receive the finish much later than the worker measured the native call.
    t.mock.method(Date, 'now', () => events[0].startedAt + 10000);
    execution.observe({ phase: 'sql-finish', sql: events[1] });
    const completed = execution.snapshot('fulfilled').nativeVectorRead;
    assert.equal(completed.observedAt - completed.startedAt, 10000);
    assert.equal(completed.elapsedMs, events[1].elapsedMs, 'retain producer time instead of parent receipt interval');

    db.prepare('SELECT 7 AS hydrated').all();
    execution.observe({ phase: 'sql-start', sql: events[2] });
    execution.observe({ phase: 'sql-finish', sql: events[3] });
    const laterFailure = new Error('later canonical failure');
    execution.annotate(laterFailure);
    assert.equal(laterFailure.memoryProcess.nativeVectorRead.elapsedMs, events[1].elapsedMs);
    assert.notEqual(
      laterFailure.memoryProcess.lastObservedSql.sqlFingerprint,
      laterFailure.memoryProcess.nativeVectorRead.sqlFingerprint,
    );
    execution.observe({ phase: 'sql-start', sql: events[0] });
    assert.equal(
      Object.hasOwn(execution.snapshot('pending').nativeVectorRead, 'elapsedMs'),
      false,
      'a later unfinished native read must not inherit the previous completed duration',
    );
  } finally {
    detach();
    db.close();
  }
});

test('throwing native context observers preserve successful rows and original SQLite failure', () => {
  const db = new Database(':memory:');
  const detach = createSqliteReadDiagnostics({
    onSlowRead() {},
    onReadStarted() {
      throw new Error('sink unavailable');
    },
    describeNativeRead() {
      throw new Error('context unavailable');
    },
  })(db);
  try {
    assert.deepEqual(db.prepare('SELECT 7 AS value').all(), [{ value: 7 }]);
    db.function('original_failure', () => {
      throw new Error('original native failure');
    });
    assert.throws(() => db.prepare('SELECT original_failure()').all(), /original native failure/);
  } finally {
    detach();
    db.close();
  }
});

test('native input allow-list rejects unrelated SQL and resource failures stay unknown', () => {
  const sql =
    'SELECT passage_key as passageKey, distance FROM passage_vectors\n      WHERE embedding MATCH ? AND k = ?';
  const vector = new Float32Array([0.123456, 0.987654, 0, 0]);
  assert.deepEqual(describePassageVectorRead(sql, [vector, 2000]), {
    kind: 'vector-knn',
    requestedK: 2000,
    dimensions: 4,
  });
  assert.equal(describePassageVectorRead('SELECT private_body FROM somewhere', [vector, 2000]), undefined);
  assert.equal(describePassageVectorRead(sql, [vector, 'private-binding']), undefined);
  assert.equal(
    captureNativeReadResources(() => {
      throw new Error('resource reader unavailable');
    }),
    null,
  );
  assert.equal(nativeReadResourceDelta(null, null), null);
  const before = {
    userCpuUs: 10,
    systemCpuUs: 5,
    fsReadOperations: 0,
    fsWriteOperations: 0,
    voluntaryContextSwitches: 0,
    involuntaryContextSwitches: 0,
    maxRssKiB: 100,
  };
  assert.deepEqual(nativeReadResourceDelta(before, { ...before, userCpuUs: 20, maxRssKiB: 400 }), {
    userCpuUs: 10,
    systemCpuUs: 0,
    fsReadOperations: 0,
    fsWriteOperations: 0,
    voluntaryContextSwitches: 0,
    involuntaryContextSwitches: 0,
  });
  assert.equal(nativeReadResourceDelta(before, { ...before, userCpuUs: 2 }), null);
});

test('a real native dimension error retains finish resources and preserves the native exception', () => {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec('CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY,embedding float[4])');
  const events = [];
  const detach = createSqliteReadDiagnostics({
    onSlowRead() {},
    describeNativeRead: describePassageVectorRead,
    onReadStarted: (event) => events.push(event),
    onReadFinished: (event) => events.push(event),
  })(db);
  try {
    assert.throws(
      () =>
        db
          .prepare('SELECT passage_key as passageKey, distance FROM passage_vectors WHERE embedding MATCH ? AND k = ?')
          .all(new Float32Array([1, 0, 0]), 2000),
      /dimension/i,
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].native.dimensions, 3);
    assert.equal(events[1].rows, null);
    assert.ok(events[1].native.resourcesAfter.userCpuUs >= 0);
  } finally {
    detach();
    db.close();
  }
});
