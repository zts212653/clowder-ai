import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { buildTurnCustodyStopGateEval } from '../../dist/infrastructure/harness-eval/turn-custody-stop-gate-eval.js';
import { createMetricAllowlistViews } from '../../dist/infrastructure/telemetry/metric-allowlist.js';
import { parsePrometheusText } from '../../dist/infrastructure/telemetry/metrics-snapshot-store.js';
import {
  TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR,
  TURN_CUSTODY_METRIC_COMPARISON_ATTR,
  TURN_CUSTODY_METRIC_STATE_ATTR,
  TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL,
  TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL,
  TURN_CUSTODY_PROMETHEUS_STATE_LABEL,
} from '../../dist/infrastructure/telemetry/turn-custody-shadow-telemetry.js';

const projectionStates = ['covered_active', 'covered_empty', 'unknown_legacy'];
const comparisons = ['agree_allow', 'agree_block', 'old_only_block'];
const requiredCounters = [
  'cat_cafe.a2a.protocol_action_without_custody_total',
  'cat_cafe.a2a.user_nudge_required_total',
  'cat_cafe.a2a.legacy_guard_without_active_custody_total',
  'cat_cafe.a2a.same_subject_post_terminal_enqueue_total',
  'cat_cafe.a2a.lease_succeeded_subject_nonterminal_total',
];

async function exportTurnCustodyMetrics() {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({ readers: [exporter], views: createMetricAllowlistViews() });
  const meter = provider.getMeter('turn-custody-prometheus-regression');

  const projection = meter.createCounter('cat_cafe.a2a.turn_custody_projection_total');
  for (const state of projectionStates) projection.add(1, { [TURN_CUSTODY_METRIC_STATE_ATTR]: state });

  const comparison = meter.createCounter('cat_cafe.a2a.turn_custody_shadow_comparison_total');
  for (const value of comparisons) {
    comparison.add(1, {
      [TURN_CUSTODY_METRIC_COMPARISON_ATTR]: value,
      [TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR]: 'not_applicable',
    });
  }
  for (const classification of ['justified', 'unjustified', 'unexplained']) {
    comparison.add(classification === 'justified' ? 1 : 0, {
      [TURN_CUSTODY_METRIC_COMPARISON_ATTR]: 'new_only_block',
      [TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR]: classification,
    });
  }

  meter.createCounter('cat_cafe.a2a.turn_custody_shadow_old_block_total').add(2);
  meter.createCounter('cat_cafe.a2a.turn_custody_shadow_new_block_total').add(2);
  for (const name of requiredCounters) meter.createCounter(name).add(0);

  try {
    const { resourceMetrics } = await exporter.collect();
    return new PrometheusSerializer().serialize(resourceMetrics);
  } finally {
    await provider.shutdown();
  }
}

describe('F167 Phase T Prometheus export contract', () => {
  it('preserves bounded stop-gate labels through F152 and into the eval parser', async () => {
    const prometheusText = await exportTurnCustodyMetrics();

    for (const state of projectionStates) {
      assert.match(prometheusText, new RegExp(`${TURN_CUSTODY_PROMETHEUS_STATE_LABEL}="${state}"`));
    }
    for (const comparison of [...comparisons, 'new_only_block']) {
      assert.match(prometheusText, new RegExp(`${TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL}="${comparison}"`));
    }
    for (const classification of ['justified', 'unjustified', 'unexplained']) {
      assert.match(prometheusText, new RegExp(`${TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL}="${classification}"`));
    }

    const component = buildTurnCustodyStopGateEval(parsePrometheusText(prometheusText));
    assert.deepEqual(component.telemetryGaps, []);
    assert.equal(component.confidence, 'medium');
    assert.equal(component.activationCounts['turn_custody.projections_total'], 3);
    assert.equal(component.activationCounts['turn_custody.disagreements_total'], 2);
    assert.equal(component.activationCounts['turn_custody.projected_block_increase_total'], 0);
    assert.equal(component.activationCounts['turn_custody.new_only_classified_total'], 1);
    assert.equal(component.frictionCounts['turn_custody.new_only_classification_gap_total'], 0);
  });
});
