/**
 * F257 Phase D — segment-judgment-engine unit tests.
 *
 * R7 regression: per-version eval grouping.
 * The engine must produce separate judgments for traces with different versions
 * of the same segment within the same eval window.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── FakeTraceStore ──

class FakeTraceStore {
  constructor() {
    this.traces = new Map(); // threadId → traces[]
  }

  addTrace(trace) {
    const list = this.traces.get(trace.threadId) ?? [];
    list.push(trace);
    this.traces.set(trace.threadId, list);
  }

  async queryWindow(threadId, startMs, endMs) {
    const list = this.traces.get(threadId) ?? [];
    return list.filter((t) => t.timestamp >= startMs && t.timestamp <= endMs);
  }
}

function makeTrace(threadId, catId, timestamp, segments) {
  return { threadId, catId, timestamp, segments };
}

function makeSeg(segmentId, opts = {}) {
  return {
    segmentId,
    status: opts.status ?? 'observed',
    pipelineStatus: opts.pipelineStatus ?? 'fired',
    version: opts.version ?? undefined,
  };
}

function makeSnapshot(startMs, endMs) {
  return {
    evalRunId: 'run-test-001',
    totalEvents: 0,
    window: { startMs, endMs },
    producedAt: '2026-07-14T00:00:00Z',
    guardMetrics: {},
    guardDetails: [],
    evidenceGaps: [],
    evidenceLevel: 'adequate',
  };
}

describe('produceSegmentJudgments', () => {
  test('same segment with two different versions produces two judgments (R7)', async () => {
    const mod = await import('../dist/infrastructure/harness-eval/segment-judgment-engine.js');
    const traceStore = new FakeTraceStore();

    // v1 trace: segment 'sys-guard' fires as version 2
    traceStore.addTrace(makeTrace('t1', 'cat-a', 1000, [makeSeg('sys-guard', { version: 2 })]));
    // v2 trace: same segment fires as version 3
    traceStore.addTrace(makeTrace('t1', 'cat-a', 2000, [makeSeg('sys-guard', { version: 3 })]));

    const judgments = await mod.produceSegmentJudgments(
      { traceStore },
      {
        snapshot: makeSnapshot(0, 5000),
        evalCat: 'eval-cat',
        threadIds: ['t1'],
      },
    );

    assert.equal(judgments.length, 2, 'should produce 2 separate judgments, one per version');
    const versions = judgments.map((j) => j.segmentVersion).sort();
    assert.deepEqual(versions, [2, 3], 'each judgment carries its own version');

    // Each judgment should have injectionCount=1 (not 2)
    for (const j of judgments) {
      assert.equal(j.evidence.injectionCount.value, 1, `version ${j.segmentVersion} should count only its own traces`);
      assert.equal(j.segmentId, 'sys-guard');
      assert.equal(j.verdict, 'alive');
    }
  });

  test('traces without version group together (backward compat)', async () => {
    const mod = await import('../dist/infrastructure/harness-eval/segment-judgment-engine.js');
    const traceStore = new FakeTraceStore();

    traceStore.addTrace(makeTrace('t1', 'cat-a', 1000, [makeSeg('sys-guard')]));
    traceStore.addTrace(makeTrace('t1', 'cat-a', 2000, [makeSeg('sys-guard')]));

    const judgments = await mod.produceSegmentJudgments(
      { traceStore },
      {
        snapshot: makeSnapshot(0, 5000),
        evalCat: 'eval-cat',
        threadIds: ['t1'],
      },
    );

    assert.equal(judgments.length, 1, 'traces without version group into single judgment');
    assert.equal(judgments[0].evidence.injectionCount.value, 2);
    assert.equal(judgments[0].segmentVersion, null);
  });

  test('mixed versioned and unversioned traces produce correct grouping', async () => {
    const mod = await import('../dist/infrastructure/harness-eval/segment-judgment-engine.js');
    const traceStore = new FakeTraceStore();

    // 2 traces with version=2, 1 trace without version, 1 trace with version=3
    traceStore.addTrace(makeTrace('t1', 'cat-a', 1000, [makeSeg('hook-a', { version: 2 })]));
    traceStore.addTrace(makeTrace('t1', 'cat-a', 2000, [makeSeg('hook-a', { version: 2 })]));
    traceStore.addTrace(makeTrace('t1', 'cat-a', 3000, [makeSeg('hook-a')]));
    traceStore.addTrace(makeTrace('t1', 'cat-a', 4000, [makeSeg('hook-a', { version: 3 })]));

    const judgments = await mod.produceSegmentJudgments(
      { traceStore },
      {
        snapshot: makeSnapshot(0, 5000),
        evalCat: 'eval-cat',
        threadIds: ['t1'],
      },
    );

    assert.equal(judgments.length, 3, 'v2 + null + v3 = 3 groups');

    const byVersion = new Map(judgments.map((j) => [j.segmentVersion, j]));
    assert.equal(byVersion.get(2).evidence.injectionCount.value, 2, 'v2 has 2 traces');
    assert.equal(byVersion.get(null).evidence.injectionCount.value, 1, 'null-version has 1 trace');
    assert.equal(byVersion.get(3).evidence.injectionCount.value, 1, 'v3 has 1 trace');
  });

  test('skip IDs are excluded from judgments', async () => {
    const mod = await import('../dist/infrastructure/harness-eval/segment-judgment-engine.js');
    const traceStore = new FakeTraceStore();

    traceStore.addTrace(
      makeTrace('t1', 'cat-a', 1000, [
        makeSeg('per-turn-aggregate'),
        makeSeg('session-init-pack-only'),
        makeSeg('real-hook', { version: 1 }),
      ]),
    );

    const judgments = await mod.produceSegmentJudgments(
      { traceStore },
      {
        snapshot: makeSnapshot(0, 5000),
        evalCat: 'eval-cat',
        threadIds: ['t1'],
      },
    );

    assert.equal(judgments.length, 1, 'only real-hook should produce a judgment');
    assert.equal(judgments[0].segmentId, 'real-hook');
  });

  test('guard event correlation works with per-version grouping', async () => {
    const mod = await import('../dist/infrastructure/harness-eval/segment-judgment-engine.js');
    const traceStore = new FakeTraceStore();

    // v2 fires at t=1000, v3 fires at t=200000 (200s later)
    // Correlation window is ±120s (120,000ms)
    traceStore.addTrace(makeTrace('t1', 'cat-a', 1000, [makeSeg('hook-a', { version: 2 })]));
    traceStore.addTrace(makeTrace('t1', 'cat-a', 200000, [makeSeg('hook-a', { version: 3 })]));

    // Guard event at t=1050 — should correlate with v2 trace (within ±120s),
    // but NOT with v3 trace (|200000-1050| = 198950ms > 120000ms window)
    const guardEvents = [{ eventId: 'g1', guardId: 'guard-x', threadId: 't1', catId: 'cat-a', timestamp: 1050 }];

    const judgments = await mod.produceSegmentJudgments(
      { traceStore },
      {
        snapshot: makeSnapshot(0, 300000),
        evalCat: 'eval-cat',
        threadIds: ['t1'],
        rawGuardEvents: guardEvents,
      },
    );

    assert.equal(judgments.length, 2);
    const v2 = judgments.find((j) => j.segmentVersion === 2);
    const v3 = judgments.find((j) => j.segmentVersion === 3);
    assert.equal(v2.evidence.violationCount.value, 1, 'v2 should have 1 correlated violation');
    assert.equal(v3.evidence.violationCount.value, 0, 'v3 should have 0 violations (guard event too far)');
  });
});
