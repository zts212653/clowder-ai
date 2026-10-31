import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { generateAttributionReport } from '../../dist/infrastructure/harness-eval/attribution.js';
import {
  buildExternalCaseClosureHealth,
  evaluateExternalCaseReplay,
  generateExternalCaseClosureSnapshot,
} from '../../dist/infrastructure/harness-eval/external-case-closure-eval.js';

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/f168-external-case-replay.json'), 'utf8'),
);

describe('F168 external case closure eval', () => {
  it('distinguishes no traffic from observed zero violations', () => {
    const noTraffic = buildExternalCaseClosureHealth({
      cat_cafe_external_case_head_observed_total: 0,
      cat_cafe_external_case_verdict_ready_without_delivery_total: 0,
      cat_cafe_external_case_noisy_wake_during_cloud_review_total: 0,
      cat_cafe_external_case_duplicate_reviewer_wake_per_head_total: 0,
      cat_cafe_external_case_user_nudge_required_total: 0,
    });
    assert.equal(noTraffic.confidence, 'no-data');
    assert.deepEqual(noTraffic.activationCounts, {});

    const healthyTraffic = buildExternalCaseClosureHealth({
      cat_cafe_external_case_head_observed_total: 3,
      cat_cafe_external_case_verdict_recorded_total: 1,
      cat_cafe_external_case_reviewer_wake_delivered_total: 1,
      cat_cafe_external_case_verdict_ready_without_delivery_total: 0,
      cat_cafe_external_case_noisy_wake_during_cloud_review_total: 0,
      cat_cafe_external_case_duplicate_reviewer_wake_per_head_total: 0,
      cat_cafe_external_case_user_nudge_required_total: 0,
    });
    assert.notEqual(healthyTraffic.confidence, 'no-data');
    assert.equal(healthyTraffic.frictionCounts['external_case.verdict_ready_without_delivery_total'], 0);
  });

  it('treats a zero-tolerance violation as traffic even without activation counters', () => {
    const violationOnly = buildExternalCaseClosureHealth({
      cat_cafe_external_case_head_observed_total: 0,
      cat_cafe_external_case_verdict_recorded_total: 0,
      cat_cafe_external_case_reviewer_wake_delivered_total: 0,
      cat_cafe_external_case_verdict_ready_without_delivery_total: 1,
      cat_cafe_external_case_noisy_wake_during_cloud_review_total: 0,
      cat_cafe_external_case_duplicate_reviewer_wake_per_head_total: 0,
      cat_cafe_external_case_user_nudge_required_total: 0,
    });

    assert.notEqual(violationOnly.confidence, 'no-data');
    assert.equal(violationOnly.frictionCounts['external_case.verdict_ready_without_delivery_total'], 1);
  });

  it('builds an F168-only snapshot without changing the F167 A2A domain', () => {
    const snapshot = generateExternalCaseClosureSnapshot({
      metrics: {
        cat_cafe_external_case_head_observed_total: 3,
        cat_cafe_external_case_verdict_recorded_total: 1,
        cat_cafe_external_case_reviewer_wake_delivered_total: 1,
        cat_cafe_external_case_verdict_ready_without_delivery_total: 0,
        cat_cafe_external_case_noisy_wake_during_cloud_review_total: 0,
        cat_cafe_external_case_duplicate_reviewer_wake_per_head_total: 0,
        cat_cafe_external_case_user_nudge_required_total: 0,
      },
      traceStats: {
        spanCount: 5,
        maxSpans: 100,
        maxAgeMs: 86_400_000,
        oldestStoredAt: 1_000,
        newestStoredAt: 2_000,
      },
      now: 3_700_000,
      processStartMs: 100_000,
      processUptimeSec: 3_600,
    });

    assert.equal(snapshot.featureId, 'F168');
    assert.equal(snapshot.components.length, 1);
    assert.equal(snapshot.components[0].componentId, 'external-case-closure');
    assert.equal(snapshot.overallConfidence, 'medium');
    assert.equal(snapshot.counterWindow.durationHours, 1);
  });

  it('treats one external-case invariant violation as a finding', () => {
    const component = buildExternalCaseClosureHealth({
      cat_cafe_external_case_head_observed_total: 1,
      cat_cafe_external_case_verdict_ready_without_delivery_total: 1,
      cat_cafe_external_case_noisy_wake_during_cloud_review_total: 0,
      cat_cafe_external_case_duplicate_reviewer_wake_per_head_total: 0,
      cat_cafe_external_case_user_nudge_required_total: 0,
    });
    const report = generateAttributionReport({
      featureId: 'F168',
      snapshot: { components: [component] },
    });

    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].frictionSignal.type, 'external_case.verdict_ready_without_delivery_total');
    assert.equal(report.findings[0].relatedFeature, 'F168');
  });

  it('replays running, blocking, duplicate, stale, delivery failure, identity split, and issue evidence fixtures', () => {
    for (const scenario of fixture.scenarios) {
      const result = evaluateExternalCaseReplay(scenario, fixture.now);
      assert.equal(result.verdict, scenario.expectedVerdict, scenario.id);
    }
  });

  it('counts a wake delivered while cloud review is still running as noise', () => {
    const scenario = fixture.scenarios.find((item) => item.id === 'running-with-noisy-wake');
    const result = evaluateExternalCaseReplay(scenario, fixture.now);
    assert.equal(result.metrics.noisyWakeDuringCloudReview, 1);
    assert.equal(result.verdict, 'fix');
  });
});
