import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeActionRate,
  findingFingerprint,
  generateAttributionReport,
} from '../../dist/infrastructure/harness-eval/attribution.js';

const VALID_CLASSES = [
  'vision_gap',
  'translation_gap',
  'harness_misfit',
  'tool_gap',
  'execution_gap',
  'environment_drift',
  'taste_gap',
];

function makeComponent(overrides) {
  return {
    componentId: 'route-serial',
    componentName: 'route-serial',
    activationCounts: {},
    frictionCounts: {},
    falsePositiveCandidates: [],
    bypassCandidates: [],
    confidence: 'medium',
    telemetryGaps: [],
    ...overrides,
  };
}

describe('F192 Attribution', () => {
  it('produces no-finding record when no friction signals', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            activationCounts: { 'inline_action.checked': 100 },
          }),
        ],
      },
    });
    assert.equal(report.findings.length, 0);
    assert.ok(report.noFindingRecord);
    assert.ok(report.noFindingRecord.reason.length > 0);
    assert.ok(report.noFindingRecord.evidence.length > 0);
  });

  it('detects friction signal from shadow_miss ratio', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            activationCounts: {
              'inline_action.checked': 100,
              'inline_action.detected': 5,
            },
            frictionCounts: { 'inline_action.shadow_miss': 15 },
          }),
        ],
      },
    });
    assert.ok(report.findings.length >= 1);
    const finding = report.findings[0];
    assert.ok(finding.attribution.primaryLayer);
    assert.ok(finding.proposedAction.length > 0);
    assert.equal(finding.status, 'open');
  });

  it('detects observability gap as tool_gap', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'L1',
            confidence: 'no-data',
            telemetryGaps: [
              {
                metric: 'streak_warn_count',
                reason: 'no_counter',
                impact: 'cannot measure L1 activation',
              },
            ],
          }),
        ],
      },
    });
    assert.ok(report.findings.length >= 1);
    const gapFinding = report.findings.find((f) => f.frictionSignal.type === 'observability-gap');
    assert.ok(gapFinding);
    assert.equal(gapFinding.attribution.primaryLayer, 'tool_gap');
    assert.equal(gapFinding.attribution.pipelineOrHuman, 'pipeline');
  });

  it('uses 7-class attribution matrix values only', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            activationCounts: { 'inline_action.checked': 50 },
            frictionCounts: { 'inline_action.shadow_miss': 20 },
          }),
        ],
      },
    });
    for (const finding of report.findings) {
      assert.ok(
        VALID_CLASSES.includes(finding.attribution.primaryLayer),
        `invalid attribution class: ${finding.attribution.primaryLayer}`,
      );
    }
  });

  it('generates proper finding ID format', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            frictionCounts: { 'inline_action.shadow_miss': 10 },
            activationCounts: { 'inline_action.checked': 20 },
          }),
        ],
      },
    });
    for (const finding of report.findings) {
      assert.match(finding.id, /^AR-\d{4}-\d{2}-\d{2}-\d{3}$/);
    }
  });

  it('includes report metadata', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: { components: [makeComponent({})] },
    });
    assert.equal(report.featureId, 'F167');
    assert.ok(report.generatedAt);
    assert.ok(report.evalSnapshotId);
  });

  it('detects high error rate from feedback_write_failed', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            activationCounts: { 'inline_action.checked': 100 },
            frictionCounts: {
              'inline_action.feedback_write_failed': 8,
              'inline_action.feedback_written': 2,
            },
          }),
        ],
      },
    });
    assert.ok(report.findings.length >= 1);
  });

  it('suppresses finding when ratio below threshold but count above (P1 fix)', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            activationCounts: { 'inline_action.checked': 1000 },
            frictionCounts: { 'inline_action.shadow_miss': 4 },
          }),
        ],
      },
    });
    assert.equal(report.findings.length, 0, 'ratio 0.4% should not produce finding even with count=4');
    assert.ok(report.noFindingRecord);
  });

  it('suppresses finding for single-sample events (P1 fix)', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            activationCounts: { 'inline_action.checked': 1 },
            frictionCounts: { 'inline_action.shadow_miss': 1 },
          }),
        ],
      },
    });
    assert.equal(report.findings.length, 0, 'count=1 should not produce finding even with 100% ratio');
  });

  it('marks human-required for ambiguous attributions from mixed counters', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C2',
            confidence: 'low',
            telemetryGaps: [
              {
                metric: 'hint_emitted',
                reason: 'trace_context_incomplete',
                impact: 'Counter mixes routing and verdict hints',
              },
            ],
          }),
        ],
      },
    });
    const gapFinding = report.findings.find((f) => f.frictionSignal.type === 'observability-gap');
    if (gapFinding) {
      assert.ok(['pipeline', 'human-required'].includes(gapFinding.attribution.pipelineOrHuman));
    }
  });

  it('C2 Day-9 fixture generates findings via attribution pipeline (regression)', () => {
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C2',
            frictionCounts: {
              'c2.verdict_without_pass_count': 13,
              'c2.void_hold_hint_emitted': 4,
            },
            activationCounts: {
              'c2.verdict_hint_emitted': 13,
            },
            confidence: 'medium',
          }),
        ],
      },
    });
    assert.equal(report.noFindingRecord, undefined, 'must NOT produce noFindingRecord');
    assert.ok(report.findings.length >= 2, 'must produce findings for both friction signals');
    const types = report.findings.map((f) => f.frictionSignal.type);
    assert.ok(types.includes('c2.verdict_without_pass_count'), 'must detect verdict_without_pass');
    assert.ok(types.includes('c2.void_hold_hint_emitted'), 'must detect void_hold_hint');
  });

  it('does NOT escalate denominator-less C2 friction to human-required (2026-05-29 eval:a2a fix)', () => {
    // Exact shape of the 2026-05-29 live snapshot: verdict_without_pass_count=9 with NO
    // c2.checked denominator. Pre-fix this fabricated ratio=100% → high → human-required,
    // landing a non-measurable signal on the F167 owner.
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C2',
            activationCounts: { 'c2.verdict_hint_emitted': 9 },
            frictionCounts: {
              'c2.verdict_without_pass_count': 9,
              'c2.void_hold_hint_emitted': 1,
            },
            confidence: 'medium',
          }),
        ],
      },
    });
    // Day-9 invariant preserved: friction still surfaces (not silently dropped).
    assert.equal(report.noFindingRecord, undefined);
    const vwp = report.findings.find((f) => f.frictionSignal.type === 'c2.verdict_without_pass_count');
    assert.ok(vwp, 'verdict_without_pass must still surface');
    // ...but NOT escalated: no denominator → cannot grade → low severity / pipeline.
    assert.equal(vwp.frictionSignal.severity, 'low');
    assert.equal(vwp.attribution.pipelineOrHuman, 'pipeline');
    assert.equal(vwp.frictionSignal.confidence, 0.4);
    assert.equal(vwp.proposedAction[0].action, 'add-counter');
    // void_hold (count=1) is below MIN_COUNT → suppressed as noise, not surfaced.
    const vh = report.findings.find((f) => f.frictionSignal.type === 'c2.void_hold_hint_emitted');
    assert.equal(vh, undefined, 'count=1 below MIN_COUNT must not surface');
  });

  it('grades C2 friction by real ratio once c2.checked denominator exists', () => {
    // Low trip-rate (9/300 = 3%) → below RATIO_FLOOR → suppressed (the phantom case).
    const low = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C2',
            activationCounts: { 'c2.checked': 300, 'c2.verdict_hint_emitted': 9 },
            frictionCounts: { 'c2.verdict_without_pass_count': 9 },
          }),
        ],
      },
    });
    assert.equal(
      low.findings.find((f) => f.frictionSignal.type === 'c2.verdict_without_pass_count'),
      undefined,
      '3% trip-rate is normal guard activation, not friction',
    );
    // High trip-rate (9/12 = 75%) → real signal → high / human-required.
    const high = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C2',
            activationCounts: { 'c2.checked': 12, 'c2.verdict_hint_emitted': 9 },
            frictionCounts: { 'c2.verdict_without_pass_count': 9 },
          }),
        ],
      },
    });
    const vwp = high.findings.find((f) => f.frictionSignal.type === 'c2.verdict_without_pass_count');
    assert.ok(vwp);
    assert.equal(vwp.frictionSignal.severity, 'high');
    assert.equal(vwp.attribution.pipelineOrHuman, 'human-required');
    assert.equal(vwp.frictionSignal.confidence, 0.7);
  });

  it('grades C1 friction against its hold_ball_calls denominator, not c1.checked (砚砚 PR #1941 P2)', () => {
    // C1's real activation denominator is hold_ball_calls (buildC1), not c1.checked.
    // The earlier generic <prefix>.checked heuristic would mis-grade a genuine 60%
    // zombie-hold ratio as denominator-less low/pipeline + "add c1.checked".
    const report = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C1',
            activationCounts: { hold_ball_calls: 10 },
            frictionCounts: { 'c1.zombie_hold_count': 6 },
          }),
        ],
      },
    });
    const zombie = report.findings.find((f) => f.frictionSignal.type === 'c1.zombie_hold_count');
    assert.ok(zombie, 'zombie_hold must surface');
    // 6/10 = 60% real ratio → high / human-required, computed against the real denominator.
    assert.equal(zombie.frictionSignal.severity, 'high');
    assert.equal(zombie.attribution.pipelineOrHuman, 'human-required');
    assert.equal(zombie.frictionSignal.confidence, 0.7);
    // Proposed action tunes the real metric (NOT "add c1.checked").
    assert.equal(zombie.proposedAction[0].action, 'harness-tune');
    assert.ok(zombie.attribution.evidence[0].excerpt.includes('hold_ball_calls=10'));
  });

  it('grades C2 void_hold against c2.void_hold_checked, not the verdict denominator (cloud PR #1941 P2)', () => {
    // Latent bug: void_hold must NOT be divided by c2.checked (the verdict-check count).
    // 4 void-hold hits with 300 verdict checks but no void-hold denominator must NOT be
    // suppressed as 4/300; it surfaces denominator-missing (low/pipeline + add the right counter).
    const latent = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C2',
            activationCounts: { 'c2.checked': 300, 'c2.verdict_hint_emitted': 0 },
            frictionCounts: { 'c2.void_hold_hint_emitted': 4 },
          }),
        ],
      },
    });
    const vh = latent.findings.find((f) => f.frictionSignal.type === 'c2.void_hold_hint_emitted');
    assert.ok(vh, 'void_hold must surface, not be suppressed by the verdict denominator');
    assert.equal(vh.frictionSignal.severity, 'low');
    assert.equal(vh.attribution.pipelineOrHuman, 'pipeline');
    assert.equal(vh.proposedAction[0].action, 'add-counter');
    assert.ok(vh.proposedAction[0].target.includes('c2.void_hold_checked'));

    // With its own denominator present, void_hold is graded against it (4/20 = 20% → medium),
    // independent of the verdict-check count.
    const measured = generateAttributionReport({
      featureId: 'F167',
      snapshot: {
        components: [
          makeComponent({
            componentId: 'C2',
            activationCounts: { 'c2.void_hold_checked': 20, 'c2.checked': 300 },
            frictionCounts: { 'c2.void_hold_hint_emitted': 4 },
          }),
        ],
      },
    });
    const vh2 = measured.findings.find((f) => f.frictionSignal.type === 'c2.void_hold_hint_emitted');
    assert.ok(vh2);
    assert.equal(vh2.frictionSignal.severity, 'medium');
    assert.ok(vh2.attribution.evidence[0].excerpt.includes('c2.void_hold_checked=20'));
  });
});

describe('AC-D9 Action Rate', () => {
  it('returns zero rate for empty prior findings', () => {
    const rate = computeActionRate([], []);
    assert.equal(rate.total, 0);
    assert.equal(rate.actedOn, 0);
    assert.equal(rate.rate, 0);
    assert.equal(rate.sunsetCandidate, false);
  });

  it('counts resolved findings as acted-on', () => {
    const current = [{ fingerprint: 'feedback_failed::C1/feedback' }];
    const prior = [
      { status: 'resolved', fingerprint: 'shadow_miss::route-serial/shadow_miss' },
      { status: 'open', fingerprint: 'feedback_failed::C1/feedback' },
    ];
    const rate = computeActionRate(current, prior);
    assert.equal(rate.total, 2);
    assert.equal(rate.actedOn, 1);
    assert.equal(rate.rate, 0.5);
    assert.equal(rate.sunsetCandidate, false);
  });

  it('counts disappeared findings as acted-on', () => {
    const current = [{ fingerprint: 'shadow_miss::route-serial/shadow_miss' }];
    const prior = [
      { status: 'open', fingerprint: 'shadow_miss::route-serial/shadow_miss' },
      { status: 'open', fingerprint: 'observability-gap::L1/old_metric' },
    ];
    const rate = computeActionRate(current, prior);
    assert.equal(rate.actedOn, 1);
  });

  it('marks sunsetCandidate when rate below 50%', () => {
    const prior = [
      { status: 'open', fingerprint: 'a::X/a' },
      { status: 'open', fingerprint: 'b::X/b' },
      { status: 'open', fingerprint: 'c::X/c' },
    ];
    const rate = computeActionRate([], prior);
    assert.ok(rate.rate > 0);
    assert.equal(rate.sunsetCandidate, rate.rate < 0.5);
  });

  it('does NOT count still-present finding as acted-on (P1-1 fix)', () => {
    const current = [{ fingerprint: 'observability-gap::L1/streak_warn_count' }];
    const prior = [{ status: 'open', fingerprint: 'observability-gap::L1/streak_warn_count' }];
    const rate = computeActionRate(current, prior);
    assert.equal(rate.actedOn, 0, 'same fingerprint still present → not acted-on');
    assert.equal(rate.rate, 0);
  });

  it('distinguishes same-type findings from different components (cloud P1 fix)', () => {
    const current = [{ fingerprint: 'observability-gap::C2/verdict_hint' }];
    const prior = [
      { status: 'open', fingerprint: 'observability-gap::L1/streak_warn_count' },
      { status: 'open', fingerprint: 'observability-gap::C2/verdict_hint' },
    ];
    const rate = computeActionRate(current, prior);
    assert.equal(rate.actedOn, 1, 'L1 gap gone = acted-on, C2 gap still present = not');
  });

  it('counts finding with real AR-id as acted-on only when resolved or gone', () => {
    const current = [{ fingerprint: 'observability-gap::C2/verdict_hint' }];
    const prior = [
      { status: 'resolved', fingerprint: 'shadow_miss::route-serial/shadow_miss' },
      { status: 'open', fingerprint: 'observability-gap::C2/verdict_hint' },
      { status: 'open', fingerprint: 'feedback_failed::C1/feedback_write_failed' },
    ];
    const rate = computeActionRate(current, prior);
    assert.equal(rate.total, 3);
    assert.equal(rate.actedOn, 2, 'resolved + disappeared = acted-on, still-present = not');
  });
});

describe('findingFingerprint', () => {
  it('uses evidence anchor when available', () => {
    const fp = findingFingerprint({
      frictionSignal: { type: 'observability-gap' },
      attribution: { evidence: [{ anchor: 'L1/streak_warn_count' }] },
    });
    assert.equal(fp, 'observability-gap::L1/streak_warn_count');
  });

  it('falls back to type only when no evidence', () => {
    const fp = findingFingerprint({ frictionSignal: { type: 'shadow_miss' } });
    assert.equal(fp, 'shadow_miss');
  });
});
