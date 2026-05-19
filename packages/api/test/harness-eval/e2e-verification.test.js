import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateAttributionReport } from '../../dist/infrastructure/harness-eval/attribution.js';
import { generateF167Snapshot } from '../../dist/infrastructure/harness-eval/f167-eval.js';

function makeComponent(overrides) {
  return {
    componentId: 'route-serial',
    activationCounts: {},
    frictionCounts: {},
    telemetryGaps: [],
    confidence: 'medium',
    falsePositiveCandidates: [],
    bypassCandidates: [],
    ...overrides,
  };
}

const now = Date.now();
const healthyTraceStats = {
  spanCount: 100,
  maxSpans: 10000,
  maxAgeMs: 86400000,
  oldestStoredAt: now - 3600000,
  newestStoredAt: now,
};

describe('AC-D3 End-to-End Verification', () => {
  describe('Recall gate — Phase B friction fixtures must be detected', () => {
    it('detects ball-drop pattern (high shadow_miss ratio)', () => {
      const report = generateAttributionReport({
        featureId: 'F167',
        snapshot: {
          components: [
            makeComponent({
              activationCounts: { 'inline_action.checked': 50 },
              frictionCounts: { 'inline_action.shadow_miss': 10 },
            }),
          ],
        },
      });
      assert.ok(report.findings.length >= 1);
      assert.equal(report.findings[0].attribution.primaryLayer, 'harness_misfit');
      assert.equal(report.findings[0].frictionSignal.type, 'inline_action.shadow_miss');
    });

    it('detects feedback write failure pattern', () => {
      const report = generateAttributionReport({
        featureId: 'F167',
        snapshot: {
          components: [
            makeComponent({
              activationCounts: { 'inline_action.checked': 100 },
              frictionCounts: { 'inline_action.feedback_write_failed': 15 },
            }),
          ],
        },
      });
      assert.ok(report.findings.length >= 1);
      assert.equal(report.findings[0].attribution.primaryLayer, 'execution_gap');
    });

    it('detects telemetry gaps as tool_gap findings', () => {
      const report = generateAttributionReport({
        featureId: 'F167',
        snapshot: {
          components: [
            makeComponent({
              telemetryGaps: [{ metric: 'test_counter', reason: 'no_counter', impact: 'Cannot measure X' }],
            }),
          ],
        },
      });
      assert.ok(report.findings.length >= 1);
      assert.equal(report.findings[0].attribution.primaryLayer, 'tool_gap');
    });
  });

  describe('Precision gate — normal traces must not produce false positives', () => {
    it('no false positive on healthy counters', () => {
      const report = generateAttributionReport({
        featureId: 'F167',
        snapshot: {
          components: [
            makeComponent({
              activationCounts: { 'inline_action.checked': 100, 'inline_action.detected': 95 },
              frictionCounts: { 'inline_action.shadow_miss': 1 },
            }),
          ],
        },
      });
      assert.equal(report.findings.length, 0);
      assert.ok(report.noFindingRecord);
    });

    it('no false positive when friction count below minimum threshold', () => {
      const report = generateAttributionReport({
        featureId: 'F167',
        snapshot: {
          components: [
            makeComponent({
              activationCounts: { 'inline_action.checked': 10 },
              frictionCounts: { 'inline_action.shadow_miss': 2 },
            }),
          ],
        },
      });
      assert.equal(report.findings.length, 0);
    });
  });

  describe('Full pipeline integration — snapshot → attribution', () => {
    it('empty input produces snapshot with gaps → attribution finds tool_gap', () => {
      const snapshot = generateF167Snapshot({
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
      });

      const report = generateAttributionReport({
        featureId: snapshot.featureId,
        snapshot: { components: snapshot.components },
      });

      assert.ok(report.findings.length > 0, 'empty input should produce gap findings');
      assert.ok(
        report.findings.some((f) => f.attribution.primaryLayer === 'tool_gap'),
        'should detect telemetry gaps as tool_gap',
      );
    });

    it('healthy counters produce snapshot with no gaps → attribution clean', () => {
      const snapshot = generateF167Snapshot({
        traces: { spans: [], count: 0 },
        metrics: {
          cat_cafe_a2a_inline_action_checked: 100,
          cat_cafe_a2a_inline_action_detected: 95,
          cat_cafe_a2a_line_start_detected: 80,
          cat_cafe_a2a_l1_streak_warn_count: 3,
          cat_cafe_a2a_l1_streak_break_count: 0,
          cat_cafe_a2a_c1_zombie_hold_count: 0,
          cat_cafe_a2a_c1_hold_cancel_count: 1,
          cat_cafe_a2a_c2_verdict_hint_emitted: 2,
          cat_cafe_a2a_c2_void_hold_hint_emitted: 0,
          cat_cafe_a2a_c2_verdict_without_pass_count: 2,
        },
        metricsHistory: { snapshots: [], count: 0 },
        traceStats: healthyTraceStats,
      });

      assert.equal(snapshot.overallConfidence, 'medium');
      assert.ok(
        snapshot.components.every((c) => c.telemetryGaps.length === 0),
        'all D0 gaps should be closed',
      );

      const report = generateAttributionReport({
        featureId: snapshot.featureId,
        snapshot: { components: snapshot.components },
      });

      assert.equal(report.findings.length, 0, 'healthy counters should produce no findings');
      assert.ok(report.noFindingRecord);
    });
  });
});
