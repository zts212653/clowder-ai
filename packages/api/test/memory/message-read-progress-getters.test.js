import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeMessageReadProgress } from '../../dist/domains/memory/message-search-lifetime.js';
import { ReadStopError, readStopReason } from '../../dist/domains/memory/read-stop-diagnostics.js';
import { executionWitness, SECRET } from '../helpers/prepare-read-stop-fixture.js';
import { preparationFixture } from '../helpers/work-preparation-fixture.js';

function input() {
  const { execution, sql } = executionWitness();
  execution.observe({ phase: 'sql-finish', sql: { ...sql, elapsedMs: 4, rows: 2 } });
  const native = execution.snapshot('pending');
  Object.assign(native, { queueMs: 1, observationAgeMs: 0 });
  Object.assign(native.nativeVectorRead.native, {
    resourcesAfter: { userCpuUs: 14 },
    resourceDelta: { userCpuUs: 4 },
  });
  Object.assign(native.cjk, { outcome: 'fulfilled', complete: true, returnedRows: 2 });
  return { stage: 'retrieval', state: 'rejected', elapsedMs: 5, stopReason: 'reader_rejected', native };
}

const cases = [
  ['outer.stage', ['stage'], 1],
  ['outer.state', ['state'], 1],
  ['outer.elapsedMs', ['elapsedMs'], 1],
  ['outer.stopReason', ['stopReason'], 1],
  ['outer.native', ['native'], 1],
  ...[
    'phase',
    'outcome',
    'elapsedMs',
    'queueMs',
    'observationAgeMs',
    'sqlObservations',
    'observedSqlMs',
    'lastObservedSql',
    'nativeVectorRead',
    'cjk',
  ].map((key) => [`native.${key}`, ['native', key], key === 'phase' || key === 'outcome' ? 2 : 1]),
  ...['sqlFingerprint', 'event', 'elapsedMs', 'rows'].map((key) => [
    `SQL.${key}`,
    ['native', 'lastObservedSql', key],
    key === 'sqlFingerprint' || key === 'event' || key === 'rows' ? 2 : 1,
  ]),
  ...['sqlFingerprint', 'event', 'elapsedMs', 'native'].map((key) => [
    `vector.${key}`,
    ['native', 'nativeVectorRead', key],
    key === 'sqlFingerprint' || key === 'event' ? 2 : 1,
  ]),
  ...['kind', 'requestedK', 'dimensions', 'resourcesBefore', 'resourcesAfter', 'resourceDelta'].map((key) => [
    `vector.input.${key}`,
    ['native', 'nativeVectorRead', 'native', key],
    key === 'requestedK' || key === 'dimensions' ? 2 : 1,
  ]),
  ...[
    'bodyVisits',
    'bodyUtf16',
    'checkpoints',
    'checkpointLimit',
    'outcome',
    'complete',
    'returnedRows',
    'elapsedMs',
  ].map((key) => [`CJK.${key}`, ['native', 'cjk', key], key === 'outcome' ? 4 : key === 'checkpoints' ? 2 : 1]),
  ['resource.scalar', ['native', 'nativeVectorRead', 'native', 'resourcesBefore', 'userCpuUs'], 1],
];

for (const [name, path, validReads] of cases) {
  test(`changing getter ${name} cannot replace its validated value with private content`, () => {
    const raw = input();
    const expected = path.reduce((current, member) => current[member], safeMessageReadProgress(raw));
    const owner = path.slice(0, -1).reduce((value, key) => value[key], raw);
    const key = path.at(-1),
      valid = owner[key];
    let reads = 0;
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: true,
      get() {
        return ++reads <= validReads ? valid : SECRET;
      },
    });
    const value = safeMessageReadProgress(raw);
    assert.ok(
      value?.native?.lastObservedSql && value.native.nativeVectorRead && value.native.cjk,
      'a valid first observation remains readable; dropping all diagnostics is not a fix',
    );
    assert.doesNotMatch(JSON.stringify(value), new RegExp(SECRET));
    assert.equal(reads, 1, 'type/range validation and publication use the same captured value');
    assert.deepEqual(
      path.reduce((current, member) => current[member], value),
      expected,
    );
  });
}

test('changing stop-reason getter cannot publish private content through the real stopped logger', async (t) => {
  const logs = [];
  const f = preparationFixture(t, { logger: { warn: (fields) => logs.push(fields) } });
  const error = new ReadStopError('deadline_exceeded', 'neutral controlled stop');
  let reads = 0;
  Object.defineProperty(error, 'stopReason', {
    get() {
      return ++reads === 1 ? 'deadline_exceeded' : SECRET;
    },
  });
  f.deps.authority.bind = async () => {
    throw error;
  };
  const result = await f.service.prepare({
    auth: f.auth,
    activity: 'html',
    query: 'neutral',
    receivedAt: Date.now(),
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'source_unavailable');
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET));
  assert.equal(logs[0].stopReason, 'deadline_exceeded');
  assert.equal(reads, 1);
});

test('a vector witness ignores an extra rows accessor that is outside its output whitelist', () => {
  const raw = input();
  Object.defineProperty(raw.native.nativeVectorRead, 'rows', {
    get() {
      throw new Error(SECRET);
    },
  });
  const value = safeMessageReadProgress(raw);
  assert.ok(value?.native?.nativeVectorRead);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(SECRET));
});

for (const member of ['lastObservedSql', 'nativeVectorRead']) {
  test(`a changing ${member} event cannot upgrade an observed SQL start to a finish`, () => {
    const raw = input(),
      sql = raw.native[member];
    let reads = 0;
    Object.defineProperty(sql, 'event', {
      get() {
        return ++reads === 1 ? 'sql-start' : 'sql-finish';
      },
    });
    const value = safeMessageReadProgress(raw).native[member];
    assert.equal(value.event, 'sql-start');
    assert.equal(value.elapsedMs, undefined);
    assert.equal(value.rows, undefined);
    if (member === 'nativeVectorRead') {
      assert.equal(value.native.resourcesAfter, undefined);
      assert.equal(value.native.resourceDelta, undefined);
    }
    assert.equal(reads, 1);
  });
}

for (const forged of ['caller_cancelled', 'source_work_budget', 'reader_rejected', 'operation_rejected']) {
  test(`a rewritten controlled error cannot claim the foreign producer ${forged}`, () => {
    const error = new ReadStopError('read_closed', 'neutral controlled stop');
    Object.defineProperty(error, 'stopReason', { value: forged });
    assert.equal(readStopReason(error, undefined, 'operation_rejected'), 'unknown');
  });
}

for (const forged of ['caller_cancelled', 'source_work_budget', 'reader_rejected', 'operation_rejected', SECRET]) {
  test(`the JavaScript constructor refuses an uncontrolled cause ${forged}`, () => {
    assert.throws(() => new ReadStopError(forged, 'neutral'), TypeError);
  });
}

for (const reason of ['deadline_exceeded', 'read_cutoff', 'read_closed']) {
  test(`the real controlled producer ${reason} keeps its name, message and provenance`, () => {
    const error = new ReadStopError(reason, 'neutral controlled stop');
    assert.equal(error.name, reason === 'read_closed' ? 'AbortError' : 'TimeoutError');
    assert.equal(error.message, 'neutral controlled stop');
    assert.equal(readStopReason(error, undefined, 'operation_rejected'), reason);
  });
}

test('a changing controlled cause cannot switch close into a legitimate-looking work-budget timeout', () => {
  const error = new ReadStopError('read_closed', 'neutral');
  let reads = 0;
  Object.defineProperty(error, 'stopReason', {
    get() {
      return ++reads === 1 ? 'read_closed' : 'source_work_budget';
    },
  });
  assert.equal(readStopReason(error, undefined, 'operation_rejected'), 'read_closed');
  assert.equal(reads, 1);
});
