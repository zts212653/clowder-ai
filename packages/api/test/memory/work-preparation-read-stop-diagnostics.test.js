import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINGERPRINT, preparationReadStopFixture, SECRET } from '../helpers/prepare-read-stop-fixture.js';
import { preparationFixture } from '../helpers/work-preparation-fixture.js';

for (const [mode, reason, readReason] of [
  ['budget', 'source_work_budget', undefined],
  ['caller', 'caller_cancelled', undefined],
  ['deadline', 'source_work_budget', 'deadline_exceeded'],
  ['reader', 'source_work_budget', 'reader_rejected'],
  ['spoof-deadline', 'source_work_budget', 'reader_rejected'],
  ['unknown', 'source_work_budget', 'unknown'],
]) {
  test(`stopped preparation retains bounded observed SQL and the actual ${mode} termination`, async (t) => {
    const f = preparationReadStopFixture(t, mode);
    const result = await f.run();
    assert.equal(result.status, mode === 'caller' ? 'cancelled' : 'source_unavailable');
    assert.deepEqual(result.pointers, []);
    assert.equal(f.logs.length, 1);
    assert.equal(
      f.logs[0].stopReason,
      reason,
      'termination is not guessed from error.name/message or elapsed wall time',
    );
    const progress = f.logs[0].sourcePhases.find((s) => s.family === 'message_evidence').readProgress;
    const native = progress.native;
    assert.ok(native.lastObservedSql, 'the existing SQL subsegment witness must survive the private whitelist');
    assert.equal(native.lastObservedSql.sqlFingerprint, FINGERPRINT);
    assert.equal(native.nativeVectorRead.sqlFingerprint, FINGERPRINT);
    assert.equal(native.nativeVectorRead.native.kind, 'vector-knn');
    assert.equal(native.nativeVectorRead.native.requestedK, 20);
    assert.equal(native.nativeVectorRead.native.resourcesBefore.userCpuUs, 10);
    assert.equal(native.cjk.complete, false, 'a canceled read does not invent a CJK finish');
    assert.equal(native.cjk.bodyVisits, 256);
    assert.equal(native.cjk.returnedRows, null);
    if (readReason) assert.equal(progress.stopReason, readReason);
    if (mode === 'reader' || mode === 'spoof-deadline' || mode === 'unknown') {
      assert.equal(native.lastObservedSql.event, 'sql-finish');
      assert.equal(native.lastObservedSql.elapsedMs, 4);
      assert.equal(native.lastObservedSql.rows, null);
    } else {
      assert.equal(native.lastObservedSql.event, 'sql-start');
      assert.equal(native.lastObservedSql.elapsedMs, undefined);
      assert.equal(native.lastObservedSql.rows, undefined);
    }
    assert.doesNotMatch(
      JSON.stringify(f.logs),
      new RegExp(`${SECRET}|candidateAudit|executionId|"pid"|databasePath|"caller"|bindings|"query"`),
    );
    const before = JSON.stringify(f.logs);
    f.caller.abort(new Error('late caller stop'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(f.logs), before, 'late cancellation cannot relabel the recorded termination');
  });
}

test('caller cancellation does not settle a hanging reader; its later rejection cannot rewrite the snapshot', async (t) => {
  const f = preparationReadStopFixture(t, 'late-reject');
  const result = await f.run();
  assert.equal(result.status, 'cancelled');
  assert.equal(f.logs[0].stopReason, 'caller_cancelled');
  const source = f.logs[0].sourcePhases.find((s) => s.family === 'message_evidence');
  assert.equal(source.phases.read.state, 'pending');
  assert.equal(source.readProgress.state, 'pending');
  const before = JSON.stringify(f.logs);
  f.rejectLate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(f.logs), before);
});

for (const mode of ['deadline', 'caller', 'spoof-deadline', 'unknown']) {
  test(`outer preparation ${mode} is classified from its actual producer, without guessing`, async (t) => {
    const logs = [];
    const f = preparationFixture(t, { logger: { warn: (fields) => logs.push(fields) } });
    const controller = new AbortController();
    const failure =
      mode === 'unknown'
        ? { name: 'TimeoutError', message: SECRET }
        : Object.assign(new Error(SECRET), { name: 'TimeoutError' });
    f.deps.authority.bind = async () => {
      throw failure;
    };
    if (mode === 'caller') controller.abort(failure);
    const result = await f.service.prepare({
      auth: f.auth,
      activity: 'html',
      query: SECRET,
      receivedAt: Date.now(),
      signal: controller.signal,
      deadlineAt: Date.now() + (mode === 'deadline' ? -1 : 1000),
    });
    assert.equal(result.status, mode === 'caller' ? 'cancelled' : 'source_unavailable');
    assert.equal(
      logs[0].stopReason,
      {
        deadline: 'deadline_exceeded',
        caller: 'caller_cancelled',
        'spoof-deadline': 'operation_rejected',
        unknown: 'unknown',
      }[mode],
    );
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET));
  });
}

test('private body-shaped error class/name/code values cannot escape through diagnostic tags', async (t) => {
  const logs = [];
  const f = preparationFixture(t, { logger: { warn: (fields) => logs.push(fields) } });
  const original = Object.assign(new Error(SECRET), { name: SECRET, code: SECRET });
  Object.defineProperty(original, 'constructor', { value: { name: SECRET } });
  f.deps.authority.bind = async () => {
    throw original;
  };
  const result = await f.service.prepare({
    auth: f.auth,
    activity: 'html',
    query: SECRET,
    receivedAt: Date.now(),
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'source_unavailable');
  assert.equal(logs[0].stopReason, 'operation_rejected');
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET));
});
