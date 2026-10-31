import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateAttributionReport } from '../../dist/infrastructure/harness-eval/attribution.js';
import { generateF167Snapshot } from '../../dist/infrastructure/harness-eval/f167-eval.js';

const emptyInput = {
  traces: { spans: [], count: 0 },
  metrics: {},
  metricsHistory: { snapshots: [], count: 0 },
  traceStats: {
    spanCount: 0,
    maxSpans: 10000,
    maxAgeMs: 86400000,
    oldestStoredAt: null,
    newestStoredAt: null,
  },
};

describe('F167 Phase Q hold lifecycle eval', () => {
  it('adds the Phase Q component to the F167 snapshot', () => {
    const snapshot = generateF167Snapshot(emptyInput);
    assert.equal(snapshot.featureId, 'F167');
    assert.equal(snapshot.components.length, 10);
    const ids = snapshot.components.map((c) => c.componentId).sort();
    assert.deepEqual(ids, [
      'C1',
      'C2',
      'L1',
      'action-successor-single-flight',
      'cross-thread-coordination',
      'event-backed-routing-exit',
      'grounding-phase-o',
      'hold-lifecycle-phase-q',
      'route-serial',
      'turn-custody-stop-gate',
    ]);
  });

  it('reports no Phase Q gaps when hold lifecycle counters exist at zero', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_hold_event_retired_total: 0,
        cat_cafe_a2a_hold_stale_wake_suppressed_total: 0,
        cat_cafe_a2a_hold_expired_after_satisfied_total: 0,
      },
    });

    const phaseQ = snapshot.components.find((c) => c.componentId === 'hold-lifecycle-phase-q');
    assert.ok(phaseQ, 'Phase Q component must exist');
    assert.deepEqual(phaseQ.telemetryGaps, []);
  });

  it('surfaces event retirement and stale-wake suppression counters', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_hold_event_retired_total: 4,
        cat_cafe_a2a_hold_stale_wake_suppressed_total: 4,
        cat_cafe_a2a_hold_expired_after_satisfied_total: 0,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const phaseQ = snapshot.components.find((c) => c.componentId === 'hold-lifecycle-phase-q');
    assert.ok(phaseQ, 'Phase Q component must exist');
    assert.equal(phaseQ.activationCounts['hold_lifecycle.event_retired_total'], 4);
    assert.equal(phaseQ.activationCounts['hold_lifecycle.stale_wake_suppressed_total'], 4);
    assert.equal(phaseQ.frictionCounts['hold_lifecycle.expired_after_satisfied_total'], 0);
    assert.equal(phaseQ.telemetryGaps.length, 0);
    assert.notEqual(phaseQ.confidence, 'no-data');
  });

  it('keeps the zero-tolerance counter required when activation counters exist', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_hold_event_retired_total: 4,
        cat_cafe_a2a_hold_stale_wake_suppressed_total: 4,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const phaseQ = snapshot.components.find((c) => c.componentId === 'hold-lifecycle-phase-q');
    assert.equal(phaseQ.activationCounts['hold_lifecycle.event_retired_total'], 4);
    assert.equal(phaseQ.activationCounts['hold_lifecycle.stale_wake_suppressed_total'], 4);
    assert.equal(phaseQ.frictionCounts['hold_lifecycle.expired_after_satisfied_total'], undefined);
    assert.equal(phaseQ.confidence, 'no-data');
    assert.deepEqual(phaseQ.telemetryGaps, [
      {
        metric: 'hold_lifecycle.expired_after_satisfied_total',
        reason: 'no_counter',
        impact: 'Cannot enforce the zero-tolerance invariant for hold expiry after satisfied wait',
      },
    ]);
  });

  it('gaps a missing Phase Q activation sibling counter instead of defaulting it to zero', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_hold_event_retired_total: 4,
        cat_cafe_a2a_hold_expired_after_satisfied_total: 0,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const phaseQ = snapshot.components.find((c) => c.componentId === 'hold-lifecycle-phase-q');
    assert.equal(phaseQ.activationCounts['hold_lifecycle.event_retired_total'], 4);
    assert.equal(phaseQ.activationCounts['hold_lifecycle.stale_wake_suppressed_total'], null);
    assert.equal(phaseQ.confidence, 'no-data');
    assert.deepEqual(phaseQ.telemetryGaps, [
      {
        metric: 'hold_lifecycle.stale_wake_suppressed_total',
        reason: 'no_counter',
        impact: 'Cannot verify Phase Q stale-wake suppression activation counter',
      },
    ]);
  });

  it('AC-Q7: any expired-after-satisfied count creates a high-severity attribution finding', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_hold_event_retired_total: 4,
        cat_cafe_a2a_hold_stale_wake_suppressed_total: 3,
        cat_cafe_a2a_hold_expired_after_satisfied_total: 1,
      },
      traceStats: {
        spanCount: 10,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.now() - 3600000,
        newestStoredAt: Date.now(),
      },
    });

    const phaseQ = snapshot.components.find((c) => c.componentId === 'hold-lifecycle-phase-q');
    assert.equal(phaseQ.frictionCounts['hold_lifecycle.expired_after_satisfied_total'], 1);

    const report = generateAttributionReport({ featureId: 'F167', snapshot });
    const finding = report.findings.find(
      (f) => f.frictionSignal.type === 'hold_lifecycle.expired_after_satisfied_total',
    );
    assert.ok(finding, 'expired-after-satisfied must not be suppressed by MIN_COUNT');
    assert.equal(finding.frictionSignal.severity, 'high');
    assert.equal(finding.attribution.pipelineOrHuman, 'human-required');
    assert.equal(
      finding.proposedAction[0].target,
      'hold-lifecycle-phase-q/hold_lifecycle.expired_after_satisfied_total',
    );
  });

  it('AC-Q7: expired-after-satisfied sample evidence is attached to the Phase Q finding', () => {
    const firedAt = Date.now();
    const spans = [
      {
        traceId: 'trace-phase-q',
        spanId: 'span-phase-q',
        name: 'scheduler.once.fire',
        startTimeMs: firedAt - 5,
        endTimeMs: firedAt,
        durationMs: 5,
        status: { code: 1 },
        attributes: {},
        events: [
          {
            name: 'hold_lifecycle.expired_after_satisfied_fired',
            timeMs: firedAt,
            attributes: {
              messageId: 'msg-hmac',
              invocationId: 'inv-hmac',
              threadId: 'thread-hmac',
              'agent.id': 'codex',
              'thread.system_kind': 'feature',
              trigger: 'timer_expired_after_event',
              taskIdHash: 'task-hmac',
              subjectKeyHash: 'subject-hmac',
              expectedSignalKey: 'review_feedback',
              sourceKind: 'github_review',
            },
          },
        ],
      },
    ];
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      traces: { spans, count: spans.length },
      metrics: {
        cat_cafe_a2a_hold_event_retired_total: 0,
        cat_cafe_a2a_hold_stale_wake_suppressed_total: 0,
        cat_cafe_a2a_hold_expired_after_satisfied_total: 1,
      },
      traceStats: {
        spanCount: spans.length,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: firedAt,
        newestStoredAt: firedAt,
      },
    });

    const phaseQ = snapshot.components.find((c) => c.componentId === 'hold-lifecycle-phase-q');
    const samples = phaseQ.frictionSamples['hold_lifecycle.expired_after_satisfied_total'];
    assert.equal(samples.length, 1);
    assert.equal(samples[0].trigger, 'timer_expired_after_event');
    assert.deepEqual(samples[0].extras, {
      taskIdHash: 'task-hmac',
      subjectKeyHash: 'subject-hmac',
      expectedSignalKey: 'review_feedback',
      sourceKind: 'github_review',
    });

    const report = generateAttributionReport({ featureId: 'F167', snapshot });
    const finding = report.findings.find(
      (f) => f.frictionSignal.type === 'hold_lifecycle.expired_after_satisfied_total',
    );
    assert.ok(finding);
    assert.deepEqual(finding.sampleCoverage, { sampleCount: 1, metricCount: 1, complete: true });
    assert.equal(finding.attribution.evidence.filter((e) => e.type === 'per-fire-sample').length, 1);
  });
});
