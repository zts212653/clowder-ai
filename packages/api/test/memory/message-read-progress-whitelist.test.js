import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageReadObservation, safeMessageReadProgress } from '../../dist/domains/memory/message-search-lifetime.js';
import { executionWitness, FINGERPRINT, SECRET } from '../helpers/prepare-read-stop-fixture.js';

test('private progress preserves only observed SQL/native/CJK scalars with independent copies', () => {
  const { execution } = executionWitness();
  const raw = execution.snapshot('pending');
  const observation = [];
  const read = new MessageReadObservation({ onReadProgress: (v) => observation.push(v) });
  // Start the existing observation; the controlled work is synchronous and returns no private body.
  const result = read.run('retrieval', () => {
    read.worker(raw);
    return 1;
  });
  const value = safeMessageReadProgress(observation.find((v) => v.native));
  assert.ok(value.native.lastObservedSql, 'the existing SQL witness must not disappear at the observer boundary');
  assert.equal(value.native.lastObservedSql.sqlFingerprint, FINGERPRINT);
  assert.equal(value.native.nativeVectorRead.native.dimensions, 768);
  assert.equal(value.native.cjk.bodyUtf16, 4096);
  raw.lastObservedSql.sqlFingerprint = 'b'.repeat(64);
  raw.nativeVectorRead.native.resourcesBefore.userCpuUs = 999;
  raw.cjk.bodyVisits = 0;
  assert.equal(value.native.lastObservedSql.sqlFingerprint, FINGERPRINT);
  assert.equal(value.native.nativeVectorRead.native.resourcesBefore.userCpuUs, 10);
  assert.equal(value.native.cjk.bodyVisits, 256);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(`${SECRET}|databasePath|caller|requestId|executionId|"pid"`));
  return result;
});

test('malformed nested diagnostics and forged termination tags do not enter the stopped log shape', () => {
  const value = safeMessageReadProgress({
    stage: 'retrieval',
    state: 'pending',
    elapsedMs: 1,
    stopReason: SECRET,
    native: {
      phase: 'sql-read',
      outcome: 'pending',
      elapsedMs: 2,
      lastObservedSql: { event: 'sql-start', sqlFingerprint: SECRET, elapsedMs: 123, rows: 1 },
      nativeVectorRead: {
        event: SECRET,
        sqlFingerprint: FINGERPRINT,
        native: { kind: 'vector-knn', requestedK: Infinity, dimensions: -1 },
      },
      cjk: { bodyVisits: -1, bodyUtf16: NaN, checkpoints: 9999, checkpointLimit: 8, outcome: SECRET },
    },
  });
  assert.equal(value.stopReason, undefined);
  assert.equal(value.native.lastObservedSql, undefined);
  assert.equal(value.native.nativeVectorRead, undefined);
  assert.equal(value.native.cjk, undefined);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(SECRET));
});

test('observer throws cannot replace completion, the original rejection or caller cancellation', async () => {
  const caller = new AbortController();
  const original = new Error(SECRET);
  const observer = new MessageReadObservation({
    signal: caller.signal,
    onReadProgress() {
      throw new Error('observer');
    },
  });
  assert.equal(await observer.run('retrieval', async () => 42), 42);
  await assert.rejects(
    observer.run('retrieval', async () => {
      throw original;
    }),
    (error) => error === original,
  );
  caller.abort(original);
  await assert.rejects(
    observer.run('retrieval', async () => 42),
    (error) => error === original,
  );
});

test('a caller stop during the completion observer still rejects late success and records cancellation', async () => {
  const control = new AbortController();
  const original = new Error(SECRET);
  const snapshots = [];
  const observer = new MessageReadObservation({
    signal: control.signal,
    onReadProgress(value) {
      snapshots.push(value);
      if (value.state === 'fulfilled') control.abort(original);
    },
  });
  await assert.rejects(
    observer.run('retrieval', async () => 42),
    (error) => error === original,
  );
  assert.equal(snapshots.at(-1).state, 'rejected');
  assert.equal(snapshots.at(-1).stopReason, 'caller_cancelled');
});

test('a reader rejection observed before caller stop keeps its identity and provenance', async () => {
  const control = new AbortController();
  const original = new Error(SECRET);
  const snapshots = [];
  const observer = new MessageReadObservation({
    signal: control.signal,
    onReadProgress(value) {
      snapshots.push(value);
      if (value.state === 'rejected') control.abort(new Error('later caller stop'));
    },
  });
  await assert.rejects(
    observer.run('retrieval', async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(snapshots.at(-1).stopReason, 'reader_rejected');
});

test('throwing nested getters are discarded without changing the parent read progress', () => {
  const native = {
    phase: 'sql-read',
    outcome: 'pending',
    elapsedMs: 1,
    get lastObservedSql() {
      throw new Error(SECRET);
    },
  };
  const value = safeMessageReadProgress({ stage: 'retrieval', state: 'pending', elapsedMs: 2, native });
  assert.deepEqual(value, { stage: 'retrieval', state: 'pending', elapsedMs: 2 });
});

test('an unfinished SQL witness cannot gain finish duration, rows or native end counters from extra members', () => {
  const { execution } = executionWitness();
  const raw = execution.snapshot('pending');
  Object.assign(raw.lastObservedSql, { elapsedMs: 99, rows: 1 });
  Object.assign(raw.nativeVectorRead, { elapsedMs: 99 });
  Object.assign(raw.nativeVectorRead.native, { resourcesAfter: { userCpuUs: 99 }, resourceDelta: { userCpuUs: 89 } });
  const value = safeMessageReadProgress({ stage: 'retrieval', state: 'pending', elapsedMs: 1, native: raw }).native;
  assert.equal(value.lastObservedSql.elapsedMs, undefined);
  assert.equal(value.lastObservedSql.rows, undefined);
  assert.equal(value.nativeVectorRead.elapsedMs, undefined);
  assert.equal(value.nativeVectorRead.native.resourcesAfter, undefined);
  assert.equal(value.nativeVectorRead.native.resourceDelta, undefined);
});

test('after cancellation, a different unbranded rejection has unknown cause and keeps its own identity', async () => {
  const control = new AbortController();
  const snapshots = [];
  const observer = new MessageReadObservation({ signal: control.signal, onReadProgress: (v) => snapshots.push(v) });
  let reject;
  const pending = observer.run(
    'retrieval',
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  control.abort(new Error('caller stop'));
  const different = new Error('independent late rejection');
  reject(different);
  await assert.rejects(pending, (error) => error === different);
  assert.equal(snapshots.at(-1).stopReason, 'unknown');
});
