import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranscriptReadDiagnostics } from '../dist/infrastructure/transcript-read-diagnostics.js';

const metrics = {
  status: 'success',
  sessionCount: 1,
  rows: 2,
  prepareMs: 1,
  workerAwaitMs: 10,
  materializeMs: 2,
  elapsedMs: 13,
  sourceBytesScanned: 100,
  hydratedBytes: 50,
  summaryCacheHits: 1,
};
const timing = {
  phase: 'settled',
  outcome: 'success',
  started: true,
  elapsedMs: 10,
  queueMs: 4,
  runMs: 6,
  releaseLagMs: 0,
  activeAtAdmission: 2,
  queuedAtAdmission: 0,
};
test('report caps do not discard coverage; duplicate client IDs keep distinct read sequences', () => {
  const events = [];
  const diagnostic = createTranscriptReadDiagnostics({
    onEvent: (event) => events.push(event),
    maxReports: 1,
    slowMs: 0,
  });
  for (const stage of ['canonical', 'generations']) {
    const read = diagnostic.beginRead('same-client-id', stage);
    assert.ok(read);
    read.onWorkerTiming({ ...timing, input: 'private-worker-body' });
    read.onRead({ ...metrics, body: 'private-source-body' });
    read.onRead(metrics); // a repeated terminal callback cannot invent another completed read
    read.onWorkerTiming({ ...timing, phase: 'released', elapsedMs: 12, releaseLagMs: 2 });
  }
  diagnostic.stop();
  const coverage = events.at(-1);
  assert.ok(coverage);
  assert.equal(coverage.observedReads, 2);
  assert.equal(coverage.completedReads, 2);
  assert.equal(coverage.rows, 4);
  assert.equal(coverage.settledWorkers, 2);
  assert.equal(coverage.releasedWorkers, 2);
  assert.equal(coverage.queueMs, 8);
  assert.equal(coverage.runMs, 12);
  assert.equal(coverage.releaseLagMs, 4);
  assert.equal(coverage.reportedReads, 1);
  assert.equal(coverage.droppedReads, 1);
  assert.equal(coverage.reportedWorkers, 1);
  assert.equal(coverage.droppedWorkers, 3);
  assert.equal(coverage.incompleteReads, 0);
  assert.equal(coverage.settledWithoutRelease, 0);
  assert.equal(JSON.stringify(events).includes('private-'), false);
  const all = [];
  const uncapped = createTranscriptReadDiagnostics({ onEvent: (event) => all.push(event), slowMs: 0 });
  const canonical = uncapped.beginRead('duplicate', 'canonical');
  const generations = uncapped.beginRead('duplicate', 'generations');
  assert.ok(canonical && generations);
  canonical.onRead(metrics);
  generations.onRead(metrics);
  assert.notEqual(all[0].readSequence, all[1].readSequence);
  uncapped.stop();
});
test('expiry is terminal, labels actual in-flight work, and ignores late completion', () => {
  let clock = 0;
  const events = [];
  const diagnostic = createTranscriptReadDiagnostics({
    onEvent: (event) => events.push(event),
    now: () => clock,
    windowMs: 1000,
  });
  const pending = diagnostic.beginRead('req', 'canonical');
  assert.ok(pending);
  pending.onWorkerTiming(timing);
  clock = 1001;
  assert.equal(diagnostic.beginRead('later', 'generations'), undefined);
  pending.onRead(metrics);
  pending.onWorkerTiming({ ...timing, phase: 'released' });
  diagnostic.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'window');
  assert.equal(events[0].incompleteReads, 1);
  assert.equal(events[0].settledWithoutRelease, 1);
});
test('logging exceptions and hundreds of completed reads cannot leak admission slots', () => {
  const diagnostic = createTranscriptReadDiagnostics({
    onEvent: () => {
      throw new Error('logger failure');
    },
    slowMs: 0,
  });
  for (let i = 0; i < 600; ++i) {
    const read = diagnostic.beginRead('req', 'canonical');
    assert.ok(read);
    read.onRead(metrics);
  }
  assert.ok(diagnostic.beginRead('after-600', 'generations'));
  assert.doesNotThrow(() => diagnostic.stop());
});

test('child CPU coverage counts only measured settlements and never copies payload fields', () => {
  const events = [];
  const diagnostic = createTranscriptReadDiagnostics({ onEvent: (event) => events.push(event), slowMs: 0 });
  const read = diagnostic.beginRead('req', 'canonical');
  const processMetrics = {
    moduleLoadWallMs: 4,
    moduleLoadProcessCpuMs: 2,
    operationStarted: true,
    operationWallMs: 200,
    operationProcessCpuMs: 1,
    body: 'private-child-canary',
  };
  read.onWorkerTiming({ ...timing, runMs: 210, processMetrics });
  read.onWorkerTiming({ ...timing, phase: 'released', processMetrics });
  diagnostic.beginRead('req', 'generations').onWorkerTiming(timing);
  diagnostic.stop();
  const worker = events.find((event) => event.type === 'transcript_worker');
  assert.equal(worker.moduleLoadWallMs, 4);
  assert.equal(worker.operationProcessCpuMs, 1);
  assert.equal(worker.parentResidualMs, 6);
  const coverage = events.at(-1);
  assert.equal(coverage.processMeasuredWorkers, 1);
  assert.equal(coverage.processMeasurementMissingWorkers, 1);
  assert.equal(coverage.operationWallMs, 200);
  assert.equal(coverage.operationProcessCpuMs, 1);
  assert.equal(JSON.stringify(events).includes('private-child-canary'), false);
});
