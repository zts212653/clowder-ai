/**
 * F167 Phase T — authoritative route → metric export → eval contract.
 *
 * The classifier matrix alone cannot detect a dropped or hard-coded binding at
 * routeSerial's metric emission point. This suite drives the real route for the
 * live cohorts, exports the production OTel counter, and lets the eval consume
 * the resulting Prometheus text.
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { metrics } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { runTurnCustodyRoute, turnCustodyTriggerMessage } from './helpers/turn-custody-route-harness.js';

const { createMetricAllowlistViews } = await import('../dist/infrastructure/telemetry/metric-allowlist.js');
const metricExporter = new PrometheusExporter({ preventServerStart: true });
const metricProvider = new MeterProvider({ readers: [metricExporter], views: createMetricAllowlistViews() });
metrics.setGlobalMeterProvider(metricProvider);

const { warmupCounters } = await import('../dist/infrastructure/telemetry/instruments.js');
const { buildTurnCustodyStopGateEval } = await import(
  '../dist/infrastructure/harness-eval/turn-custody-stop-gate-eval.js'
);
const { parsePrometheusText } = await import('../dist/infrastructure/telemetry/metrics-snapshot-store.js');

after(async () => {
  await metricProvider.shutdown();
  metrics.disable();
});

const liveCohorts = [
  {
    count: 2,
    state: 'covered_active',
    reason: 'not_applicable',
    sourceCategory: 'a2a',
    sourceSemantic: 'cross_thread_investigate',
    wakeProvenance: 'structured:dispatch',
    checkpoint: 'route_settled',
  },
  {
    count: 6,
    state: 'covered_active',
    reason: 'not_applicable',
    sourceCategory: 'a2a',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'structured:dispatch',
    checkpoint: 'route_settled',
  },
  {
    count: 4,
    state: 'covered_active',
    reason: 'not_applicable',
    sourceCategory: 'action_successor',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'action_successor',
    checkpoint: 'next_turn_boundary',
  },
  {
    count: 10,
    state: 'covered_active',
    reason: 'not_applicable',
    sourceCategory: 'action_successor',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'action_successor',
    checkpoint: 'route_settled',
  },
  {
    count: 4,
    state: 'unknown_legacy',
    reason: 'action_holder_mismatch',
    sourceCategory: 'action_successor',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'action_successor',
    checkpoint: 'route_settled',
  },
  {
    count: 4,
    state: 'unknown_legacy',
    reason: 'carrier_missing',
    sourceCategory: 'ci',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'legacy:carrier_missing',
    checkpoint: 'route_settled',
  },
  {
    count: 1,
    state: 'unknown_legacy',
    reason: 'carrier_missing',
    sourceCategory: 'review',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'legacy:carrier_missing',
    checkpoint: 'route_settled',
  },
  {
    count: 3,
    state: 'unknown_legacy',
    reason: 'structured_holder_mismatch',
    sourceCategory: 'a2a',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'structured:dispatch',
    checkpoint: 'next_turn_boundary',
  },
  {
    count: 2,
    state: 'unknown_legacy',
    reason: 'structured_holder_mismatch',
    sourceCategory: 'a2a',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'structured:dispatch',
    checkpoint: 'route_settled',
  },
];

const holdouts = [
  {
    count: 1,
    state: 'covered_active',
    reason: 'not_applicable',
    sourceCategory: 'action_successor',
    sourceSemantic: 'cross_thread_investigate',
    wakeProvenance: 'action_successor',
    checkpoint: 'route_settled',
    expected: 'unexplained',
  },
  {
    count: 1,
    state: 'covered_empty',
    reason: 'not_applicable',
    sourceCategory: 'action_successor',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'action_successor',
    checkpoint: 'route_settled',
    expected: 'unjustified',
  },
  {
    count: 1,
    state: 'covered_active',
    reason: 'not_applicable',
    sourceCategory: 'action_successor',
    sourceSemantic: 'not_recorded',
    wakeProvenance: 'action_successor',
    checkpoint: 'route_settled',
    transitionObserved: true,
    expected: 'unjustified',
  },
];

function wakeFor(input, index) {
  if (input.wakeProvenance === 'action_successor') {
    return { kind: 'action_successor', leaseId: `lease-${index}`, generation: 1, holderCatId: 'codex' };
  }
  if (input.wakeProvenance === 'legacy:carrier_missing') {
    return { kind: 'legacy', reason: 'carrier_missing', sourceCategory: input.sourceCategory };
  }
  return {
    kind: 'structured',
    protocol: 'dispatch',
    subjectKey: `ball:thread:metric-thread-${index}`,
    holderCatId: 'codex',
    handoff: {
      sourceEventId: `route:metric-message-${index}:codex`,
      messageId: `metric-message-${index}`,
      fromCatId: 'opus',
    },
  };
}

async function runCase(input, index) {
  const effectClass =
    input.sourceSemantic === 'not_recorded' ? undefined : input.sourceSemantic.replace('cross_thread_', '');
  await runTurnCustodyRoute({
    output: [input.checkpoint === 'next_turn_boundary' ? '@opus' : '@co-creator'],
    triggerMessage: turnCustodyTriggerMessage(`metric-message-${index}`, `metric-thread-${index}`, effectClass),
    wake: wakeFor(input, index),
    projection: {
      state: input.state,
      shouldBlock: true,
      transitionObserved: input.transitionObserved ?? false,
      evidenceRefs: input.reason === 'not_applicable' ? [] : [`unknown:${input.reason}`],
    },
  });
}

describe('F167 Phase T route-to-eval metric binding', () => {
  test('preserves all live cohort and contradiction classifications through Prometheus', async () => {
    warmupCounters();
    let index = 0;
    for (const cohort of [...liveCohorts, ...holdouts]) {
      for (let occurrence = 0; occurrence < cohort.count; occurrence += 1) {
        await runCase(cohort, ++index);
      }
    }

    const { resourceMetrics } = await metricExporter.collect();
    const prometheusText = new PrometheusSerializer().serialize(resourceMetrics);
    const component = buildTurnCustodyStopGateEval(parsePrometheusText(prometheusText));

    assert.equal(
      liveCohorts.reduce((total, cohort) => total + cohort.count, 0),
      36,
    );
    assert.equal(component.activationCounts['turn_custody.new_only_block_total'], 39);
    assert.equal(component.activationCounts['turn_custody.new_only_justified_total'], 36);
    assert.equal(component.frictionCounts['turn_custody.new_only_unjustified_total'], 2);
    assert.equal(component.frictionCounts['turn_custody.new_only_unexplained_total'], 1);
    assert.equal(component.frictionCounts['turn_custody.new_only_classification_gap_total'], 0);
    assert.equal(
      component.activationCounts['turn_custody.new_only_block_total'],
      component.activationCounts['turn_custody.new_only_justified_total'] +
        component.frictionCounts['turn_custody.new_only_unjustified_total'] +
        component.frictionCounts['turn_custody.new_only_unexplained_total'],
    );
  });
});
