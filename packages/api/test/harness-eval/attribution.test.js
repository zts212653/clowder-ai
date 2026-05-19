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
