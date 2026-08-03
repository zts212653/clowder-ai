import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateAttributionReport } from '../../dist/infrastructure/harness-eval/attribution.js';
import { generateF167Snapshot } from '../../dist/infrastructure/harness-eval/f167-eval.js';
import { buildEventBackedRoutingExitEval } from '../../dist/infrastructure/harness-eval/f177-event-backed-routing-eval.js';

const emptyInput = {
  traces: { spans: [], count: 0 },
  metrics: {},
  metricsHistory: { snapshots: [], count: 0 },
  traceStats: {
    spanCount: 0,
    maxSpans: 10_000,
    maxAgeMs: 86_400_000,
    oldestStoredAt: null,
    newestStoredAt: null,
  },
};

describe('F177 event-backed routing eval', () => {
  it('records bypass, stale/unrelated rejection, and redundant hold prevention separately', () => {
    const component = buildEventBackedRoutingExitEval({
      cat_cafe_a2a_routing_event_wait_bypass_total: 2,
      'cat_cafe_a2a_routing_event_wait_rejected_total{routing_event_wait_reason="task_done"}': 1,
      'cat_cafe_a2a_routing_event_wait_rejected_total{routing_event_wait_reason="subject_mismatch"}': 2,
      'cat_cafe_a2a_routing_event_wait_rejected_total{routing_event_wait_reason="coverage_unconfirmed"}': 3,
      'cat_cafe_a2a_routing_event_wait_rejected_total{routing_event_wait_reason="query_failed"}': 1,
      'cat_cafe_a2a_routing_event_wait_rejected_total{routing_event_wait_reason="no_candidate"}': 4,
      'cat_cafe_a2a_routing_event_wait_rejected_total{routing_event_wait_reason="missing_invocation"}': 5,
      'cat_cafe_a2a_routing_event_wait_rejected_total{routing_event_wait_reason="proof_invalid"}': 6,
      cat_cafe_a2a_routing_event_wait_false_bypass_total: 0,
      cat_cafe_a2a_routing_event_wait_redundant_hold_prevented_total: 2,
      cat_cafe_a2a_routing_terminal_release_clean_stop_total: 3,
      cat_cafe_a2a_routing_terminal_release_remedial_total: 0,
    });

    assert.deepEqual(component.telemetryGaps, []);
    assert.equal(component.activationCounts['event_wait.bypass_total'], 2);
    assert.equal(component.activationCounts['event_wait.rejected_stale_total'], 1);
    assert.equal(component.activationCounts['event_wait.rejected_unrelated_total'], 2);
    assert.equal(component.activationCounts['event_wait.rejected_uncovered_total'], 3);
    assert.equal(component.activationCounts['event_wait.rejected_query_failed_total'], 1);
    assert.equal(component.activationCounts['event_wait.rejected_other_total'], 15);
    assert.equal(component.activationCounts['event_wait.redundant_hold_prevented_total'], 2);
    assert.equal(component.frictionCounts['event_wait.false_bypass_total'], 0);
    assert.equal(component.activationCounts['terminal_release.clean_stop_total'], 3);
    assert.equal(component.frictionCounts['terminal_release.remedial_total'], 0);
  });

  it('treats any false bypass as a zero-tolerance high-severity finding', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        cat_cafe_a2a_routing_event_wait_bypass_total: 1,
        cat_cafe_a2a_routing_event_wait_rejected_total: 0,
        cat_cafe_a2a_routing_event_wait_false_bypass_total: 1,
        cat_cafe_a2a_routing_event_wait_redundant_hold_prevented_total: 0,
        cat_cafe_a2a_routing_terminal_release_clean_stop_total: 0,
        cat_cafe_a2a_routing_terminal_release_remedial_total: 0,
      },
    });

    const component = snapshot.components.find((candidate) => candidate.componentId === 'event-backed-routing-exit');
    assert.ok(component, 'F167 snapshot must include the F177 event-backed exit component');
    assert.equal(component.frictionCounts['event_wait.false_bypass_total'], 1);

    const report = generateAttributionReport({ featureId: 'F167', snapshot });
    const finding = report.findings.find(
      (candidate) => candidate.frictionSignal.type === 'event_wait.false_bypass_total',
    );
    assert.ok(finding, 'false bypass must produce a finding even at count=1');
    assert.equal(finding.frictionSignal.severity, 'high');
    assert.equal(finding.attribution.pipelineOrHuman, 'human-required');
    assert.match(finding.proposedAction[0].rationale, /event-backed routing-exit/i);
    assert.doesNotMatch(finding.proposedAction[0].rationale, /Phase Q hold lifecycle/i);
  });
});
