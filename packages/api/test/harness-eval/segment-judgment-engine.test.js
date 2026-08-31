/**
 * F257 Segment Judgment Engine tests
 *
 * Verifies:
 *   - Per-segment aggregation from injection traces
 *   - Guard event correlation via ±120s timestamp window
 *   - Deterministic verdict rules (alive / unmeasurable)
 *   - rawGuardEvents preference over snapshot sampleAnchors
 *   - Empty input edge cases
 *   - JudgmentId formatting
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { produceSegmentJudgments } from '../../dist/infrastructure/harness-eval/segment-judgment-engine.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Fake InjectionTraceStore — returns preloaded summaries by threadId. */
class FakeTraceStore {
  constructor(summariesByThread = {}) {
    this.data = summariesByThread; // { threadId → InjectionTraceSummary[] }
  }

  async queryWindow(threadId, startMs, endMs) {
    const all = this.data[threadId] ?? [];
    return all.filter((s) => s.timestamp >= startMs && s.timestamp <= endMs);
  }
}

function makeTrace({ threadId, catId, turnId, timestamp, segments }) {
  return {
    threadId,
    catId,
    turnId: turnId ?? `turn-${timestamp}`,
    timestamp,
    segments,
    delivery: [],
    totals: { charCount: 0, tokenEstimate: 0 },
  };
}

function makeSeg({ segmentId, status = 'observed', pipelineStatus = 'fired', version = null }) {
  return {
    segmentId,
    stage: 'session',
    status,
    pipelineStatus,
    contentHash: 'h',
    charCount: 10,
    tokenEstimate: 3,
    version,
  };
}

function makeSnapshot({ evalRunId = 'hlr-test-001', startMs, endMs, sampleAnchors = [], byGuard = {}, byKind = {} }) {
  return {
    evalRunId,
    producedAt: '2026-07-14T00:00:00.000Z',
    window: { startMs, endMs, durationHours: Math.round((endMs - startMs) / 3_600_000) },
    totalEvents: sampleAnchors.length,
    byKind,
    byGuard,
    sampleAnchors,
    howCounted: 'zset-window-scan',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F257 Segment Judgment Engine', () => {
  const T0 = 1_720_900_000_000; // base timestamp
  const WINDOW_START = T0 - 86_400_000; // 1 day before
  const WINDOW_END = T0 + 86_400_000; // 1 day after

  describe('empty inputs', () => {
    test('returns [] when no threadIds provided', async () => {
      const store = new FakeTraceStore();
      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: [],
        },
      );
      assert.deepStrictEqual(result, []);
    });

    test('returns [] when no traces in window', async () => {
      const store = new FakeTraceStore({ 'thread-1': [] });
      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );
      assert.deepStrictEqual(result, []);
    });
  });

  describe('per-segment aggregation', () => {
    test('counts fired segments across multiple traces', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-identity-contract' }), makeSeg({ segmentId: 'S-safety-rules' })],
          }),
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0 + 60_000,
            segments: [makeSeg({ segmentId: 'S-identity-contract' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result.length, 2);
      const identity = result.find((j) => j.segmentId === 'S-identity-contract');
      const safety = result.find((j) => j.segmentId === 'S-safety-rules');
      assert.equal(identity.evidence.injectionCount.value, 2);
      assert.equal(safety.evidence.injectionCount.value, 1);
    });

    test('skips per-turn-aggregate and session-init-pack-only segments', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [
              makeSeg({ segmentId: 'per-turn-aggregate' }),
              makeSeg({ segmentId: 'session-init-pack-only' }),
              makeSeg({ segmentId: 'S-real-hook' }),
            ],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result.length, 1);
      assert.equal(result[0].segmentId, 'S-real-hook');
    });

    test('does not count non-fired segments', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [
              makeSeg({ segmentId: 'S-hook-a', status: 'observed', pipelineStatus: 'fired' }),
              makeSeg({ segmentId: 'S-hook-b', status: 'observed', pipelineStatus: 'skipped' }),
            ],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      const hookA = result.find((j) => j.segmentId === 'S-hook-a');
      const hookB = result.find((j) => j.segmentId === 'S-hook-b');
      assert.equal(hookA.evidence.injectionCount.value, 1);
      assert.equal(hookA.verdict, 'alive');
      assert.equal(hookB.evidence.injectionCount.value, 0);
      assert.equal(hookB.verdict, 'unmeasurable');
    });

    test('tracks segment version', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook', version: 3 })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result[0].segmentVersion, 3);
    });
  });

  describe('guard event correlation', () => {
    test('correlates events within ±120s of fired trace timestamp (three-key match)', async () => {
      const traceTs = T0;
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: traceTs,
            segments: [makeSeg({ segmentId: 'S-identity' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({
            startMs: WINDOW_START,
            endMs: WINDOW_END,
          }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
          // v1 three-key correlation: rawGuardEvents carry threadId + catId.
          // ev-1: same thread + same cat + within ±120s → matches.
          // ev-2: same thread + same cat but outside ±120s → no match.
          rawGuardEvents: [
            {
              eventId: 'ev-1',
              guardId: 'identity-guard',
              threadId: 'thread-1',
              catId: 'cat-a',
              timestamp: traceTs + 60_000,
            },
            {
              eventId: 'ev-2',
              guardId: 'safety-guard',
              threadId: 'thread-1',
              catId: 'cat-a',
              timestamp: traceTs + 200_000,
            },
          ],
        },
      );

      assert.equal(result[0].evidence.violationCount.value, 1); // ev-1 within ±120s, ev-2 outside
      assert.deepStrictEqual(result[0].evidence.eventRefs, ['ev-1']);
      assert.equal(result[0].verdict, 'alive');
    });

    test('no correlation when guard event outside ±120s window', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({
            startMs: WINDOW_START,
            endMs: WINDOW_END,
          }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
          // Same thread + same cat but 300s away → outside ±120s window.
          rawGuardEvents: [
            { eventId: 'ev-far', guardId: 'g', threadId: 'thread-1', catId: 'cat-a', timestamp: T0 + 300_000 },
          ],
        },
      );

      assert.equal(result[0].evidence.violationCount.value, 0);
      assert.equal(result[0].verdict, 'alive'); // has injections, no correlated violations → still alive
    });
  });

  describe('rawGuardEvents preference', () => {
    test('uses rawGuardEvents over snapshot sampleAnchors', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      // sampleAnchors has an event at +60s (within window)
      // rawGuardEvents has 2 events at +30s and +90s (both within window)
      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({
            startMs: WINDOW_START,
            endMs: WINDOW_END,
            sampleAnchors: [{ eventId: 'anchor-1', kind: 'x', guardId: 'g', timestamp: T0 + 60_000 }],
          }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
          rawGuardEvents: [
            { eventId: 'raw-1', guardId: 'g', threadId: 'thread-1', catId: 'cat-a', timestamp: T0 + 30_000 },
            { eventId: 'raw-2', guardId: 'g', threadId: 'thread-1', catId: 'cat-a', timestamp: T0 + 90_000 },
          ],
        },
      );

      // Should see 2 correlated events from raw, not 1 from sampleAnchors
      assert.equal(result[0].evidence.violationCount.value, 2);
      assert.ok(result[0].evidence.eventRefs.includes('raw-1'));
      assert.ok(result[0].evidence.eventRefs.includes('raw-2'));
      assert.ok(!result[0].evidence.eventRefs.includes('anchor-1'));
    });
  });

  describe('verdict rules', () => {
    test('alive when injections > 0 (even without violations)', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-clean-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result[0].verdict, 'alive');
      assert.equal(result[0].evidence.denominatorKind, 'fired-count');
    });

    test('unmeasurable when injections == 0 (skipped segment)', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-skipped', status: 'observed', pipelineStatus: 'skipped' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result[0].verdict, 'unmeasurable');
      assert.equal(result[0].evidence.denominatorKind, 'none');
    });
  });

  describe('judgment metadata', () => {
    test('judgmentId follows sj-YYYYMMDD-NNN format', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-a' }), makeSeg({ segmentId: 'S-b' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.match(result[0].judgmentId, /^sj-20260714-001$/);
      assert.match(result[1].judgmentId, /^sj-20260714-002$/);
    });

    test('window matches snapshot window', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.deepStrictEqual(result[0].window, { startMs: WINDOW_START, endMs: WINDOW_END });
    });

    test('producedBy carries evalCat and evalRunId', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ evalRunId: 'hlr-test-xyz', startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'fable',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result[0].producedBy.evalCat, 'fable');
      assert.equal(result[0].producedBy.runId, 'hlr-test-xyz');
      assert.equal(result[0].producedBy.domainId, 'eval:harness-ledger');
    });

    test('correlationConfidence is always window in v1', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result[0].evidence.correlationConfidence, 'window');
    });
  });

  describe('multi-thread aggregation', () => {
    test('aggregates same segment across different threads', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-shared-hook' })],
          }),
        ],
        'thread-2': [
          makeTrace({
            threadId: 'thread-2',
            catId: 'cat-b',
            timestamp: T0 + 1000,
            segments: [makeSeg({ segmentId: 'S-shared-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1', 'thread-2'],
        },
      );

      assert.equal(result.length, 1);
      assert.equal(result[0].segmentId, 'S-shared-hook');
      assert.equal(result[0].evidence.injectionCount.value, 2);
    });
  });

  describe('v1 three-key correlation (terra review P1-2)', () => {
    test('same-tuple matches: same threadId + same catId + within ±120s', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
          rawGuardEvents: [
            { eventId: 'ev-match', guardId: 'g', threadId: 'thread-1', catId: 'cat-a', timestamp: T0 + 50_000 },
          ],
        },
      );

      assert.equal(result[0].evidence.violationCount.value, 1);
      assert.deepStrictEqual(result[0].evidence.eventRefs, ['ev-match']);
    });

    test('different threadId within ±120s does NOT match', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
          rawGuardEvents: [
            // Same catId + within ±120s, but different threadId → no match
            {
              eventId: 'ev-cross-thread',
              guardId: 'g',
              threadId: 'thread-OTHER',
              catId: 'cat-a',
              timestamp: T0 + 10_000,
            },
          ],
        },
      );

      assert.equal(result[0].evidence.violationCount.value, 0);
      assert.deepStrictEqual(result[0].evidence.eventRefs, []);
    });

    test('different catId within ±120s does NOT match', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
          rawGuardEvents: [
            // Same threadId + within ±120s, but different catId → no match
            {
              eventId: 'ev-cross-cat',
              guardId: 'g',
              threadId: 'thread-1',
              catId: 'cat-DIFFERENT',
              timestamp: T0 + 10_000,
            },
          ],
        },
      );

      assert.equal(result[0].evidence.violationCount.value, 0);
      assert.deepStrictEqual(result[0].evidence.eventRefs, []);
    });

    test('sampleAnchors without rawGuardEvents yields 0 violations (no false attribution)', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      // sampleAnchors present in snapshot but no rawGuardEvents passed →
      // engine must return 0 violations (sampleAnchors lack threadId/catId).
      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({
            startMs: WINDOW_START,
            endMs: WINDOW_END,
            sampleAnchors: [{ eventId: 'anchor-1', kind: 'x', guardId: 'g', timestamp: T0 + 10_000 }],
          }),
          evalCat: 'ragdoll',
          threadIds: ['thread-1'],
          // rawGuardEvents intentionally omitted
        },
      );

      assert.equal(result[0].evidence.violationCount.value, 0);
      assert.deepStrictEqual(result[0].evidence.eventRefs, []);
    });
  });

  describe('evalCat provenance (terra review P2-2)', () => {
    test('producedBy.evalCat reflects the effective eval cat, not a default', async () => {
      const store = new FakeTraceStore({
        'thread-1': [
          makeTrace({
            threadId: 'thread-1',
            catId: 'cat-a',
            timestamp: T0,
            segments: [makeSeg({ segmentId: 'S-hook' })],
          }),
        ],
      });

      // Simulate override scenario: evalCat is 'maine-coon-override' (not the domain default)
      const result = await produceSegmentJudgments(
        { traceStore: store },
        {
          snapshot: makeSnapshot({ startMs: WINDOW_START, endMs: WINDOW_END }),
          evalCat: 'maine-coon-override',
          threadIds: ['thread-1'],
        },
      );

      assert.equal(result[0].producedBy.evalCat, 'maine-coon-override');
      assert.equal(result[0].producedBy.domainId, 'eval:harness-ledger');
    });
  });
});
