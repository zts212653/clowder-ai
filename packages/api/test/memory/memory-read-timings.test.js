import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryReadExecution } from '../../dist/domains/memory/memory-read-execution.js';
import { safeNativeReadProgress } from '../../dist/domains/memory/message-read-progress-native.js';

const ended = {
  prepared: true,
  active: true,
  reason: 'active',
  cleanup: true,
  counters: null,
  preload: { attempted: false, started: false, joined: false, logicalBytes: 0, readCalls: 0, errorCode: 0 },
};
const diagnostic = (id, phase, workerElapsedMs, extra = {}) => ({
  type: 'read-diagnostic',
  id,
  diagnostic: { phase, workerElapsedMs, ...extra },
});

test('job-bound timing distinguishes worker clocks, final delivery and cancellation with missing observations preserved', () => {
  const execution = new MemoryReadExecution('message-search');
  execution.onMessage({ type: 'message-vectors-started', id: 4, workerElapsedMs: 120 }, 4);
  const started = execution.snapshot('pending').timings;
  assert.ok(started, 'vectors-started must retain timing on the current attempt');
  assert.equal(started.vectorsStarted.workerElapsedMs, 120);
  assert.equal(started.scopeEndObservation, null);
  assert.equal(started.resultPrepared, null);
  assert.equal(started.resultReceivedMs, null);
  execution.onMessage(diagnostic(3, 'read-window-finished', 170, { readWindow: ended }), 4);
  assert.equal(execution.snapshot('pending').timings.scopeEndObservation, null, 'another job cannot supply completion');
  execution.onMessage(diagnostic(4, 'read-window-finished', 180, { readWindow: ended }), 4);
  execution.onMessage(diagnostic(4, 'result-ready', 220), 4);
  assert.equal(execution.snapshot('pending').timings.resultReceivedMs, null, 'ready is not delivered');
  execution.onMessage({ type: 'result', id: 4, value: 7 }, 4);
  execution.settled();
  const done = execution.snapshot('fulfilled');
  assert.equal(done.timings.parentClock, 'monotonic-since-submit');
  assert.equal(done.timings.workerClock, 'monotonic-since-run');
  assert.equal(done.timings.scopeEndObservation.workerElapsedMs, 180);
  assert.equal(done.timings.resultPrepared.workerElapsedMs, 220);
  assert.ok(done.timings.scopeEndObservation.parentReceivedMs <= done.timings.resultPrepared.parentReceivedMs);
  assert.ok(done.timings.resultPrepared.parentReceivedMs <= done.timings.resultReceivedMs);
  assert.ok(done.timings.resultReceivedMs <= done.timings.settledMs);
  assert.equal(done.timings.cancelRequestedMs, null);
  execution.onMessage(diagnostic(4, 'read-window-finished', 999, { readWindow: ended }), 4);
  assert.deepEqual(
    execution.snapshot('fulfilled').timings,
    done.timings,
    'late observations cannot rewrite a settled attempt',
  );
  const legacy = new MemoryReadExecution('message-search');
  legacy.onMessage({ type: 'message-vectors-started', id: 1 }, 1);
  assert.equal(
    legacy.snapshot('pending').timings.vectorsStarted.workerElapsedMs,
    null,
    'missing producer time is not zero',
  );
});

test('bounded encoding RPC observations are copied and late completion cannot rewrite cancellation', () => {
  const execution = new MemoryReadExecution('message-search');
  for (let rpcId = 1; rpcId <= 9; rpcId++) {
    execution.onMessage({ type: 'embedding', id: rpcId, method: 'embed', texts: ['private-query'] }, 40);
    if (rpcId !== 1) execution.embeddingFinished(rpcId, 'fulfilled');
  }
  const before = execution.snapshot('pending');
  assert.ok(before.timings, 'encoding bridge must leave bounded time evidence');
  assert.equal(before.timings.embeddingCalls.length, 8);
  assert.equal(before.timings.embeddingCallLimit, 8);
  assert.equal(before.timings.embeddingCallsTruncated, true);
  assert.equal(before.timings.embeddingCalls[0].parentSettledMs, null);
  execution.cancelled();
  execution.settled();
  const cancelled = execution.snapshot('rejected');
  execution.embeddingFinished(1, 'rejected');
  assert.deepEqual(execution.snapshot('rejected').timings, cancelled.timings);
  assert.equal(before.timings.cancelRequestedMs, null, 'older snapshots stay immutable');
  const projected = safeNativeReadProgress({
    ...cancelled,
    timings: {
      ...cancelled.timings,
      privatePath: 'private-path',
      embeddingCalls: cancelled.timings.embeddingCalls.map((call) => ({ ...call, texts: ['private-body'] })),
    },
  });
  assert.deepEqual(
    projected.timings,
    cancelled.timings,
    'existing stopped-progress projection keeps the fixed scalars',
  );
  cancelled.timings.embeddingCalls[0].rpcId = 99;
  assert.equal(projected.timings.embeddingCalls[0].rpcId, 1);
  assert.doesNotMatch(JSON.stringify(projected), /private-/);
  for (const invalid of [
    { ...projected.timings, parentClock: 'private-clock' },
    { ...projected.timings, settledMs: Infinity },
    { ...projected.timings, embeddingCalls: Array(9).fill(projected.timings.embeddingCalls[0]) },
  ])
    assert.equal(safeNativeReadProgress({ ...cancelled, timings: invalid }).timings, undefined);
});

test('timing projection captures a changing scalar once and does not execute an array iterator', () => {
  const execution = new MemoryReadExecution('message-search');
  execution.onMessage(diagnostic(1, 'read-window-finished', 10, { readWindow: ended }), 1);
  execution.onMessage({ type: 'embedding', id: 2, method: 'embed' }, 1);
  const raw = execution.snapshot('pending');
  let reads = 0;
  Object.defineProperty(raw.timings.scopeEndObservation, 'workerElapsedMs', {
    get() {
      return ++reads === 1 ? 10 : 'private-timing';
    },
  });
  raw.timings.embeddingCalls[Symbol.iterator] = () => {
    throw new Error('private-iterator');
  };
  const safe = safeNativeReadProgress(raw);
  assert.equal(safe.timings.scopeEndObservation.workerElapsedMs, 10);
  assert.equal(reads, 1);
  assert.equal(safe.timings.embeddingCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(safe), /private-/);
});
