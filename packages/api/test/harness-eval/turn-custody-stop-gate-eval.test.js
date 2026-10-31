import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateAttributionReport } from '../../dist/infrastructure/harness-eval/attribution.js';
import { generateF167Snapshot } from '../../dist/infrastructure/harness-eval/f167-eval.js';
import {
  buildTurnCustodyStopGateEval,
  TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME,
} from '../../dist/infrastructure/harness-eval/turn-custody-stop-gate-eval.js';
import {
  boundedTurnCustodySourceCategory,
  boundedTurnCustodySourceSemantic,
  classifyTurnCustodyNewOnlyBlock,
  turnCustodyProjectionReason,
  turnCustodySourceSemantic,
} from '../../dist/infrastructure/telemetry/turn-custody-shadow-telemetry.js';

const completeMetrics = {
  'cat_cafe_a2a_turn_custody_projection_total{turn_custody_state="covered_active"}': 8,
  'cat_cafe_a2a_turn_custody_projection_total{turn_custody_state="covered_empty"}': 11,
  'cat_cafe_a2a_turn_custody_projection_total{turn_custody_state="unknown_legacy"}': 1,
  'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="agree_allow"}': 10,
  'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="agree_block"}': 4,
  'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="old_only_block"}': 5,
  'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="new_only_block",turn_custody_classification="justified"}': 1,
  'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="new_only_block",turn_custody_classification="unjustified"}': 0,
  'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="new_only_block",turn_custody_classification="unexplained"}': 0,
  cat_cafe_a2a_turn_custody_shadow_old_block_total: 9,
  cat_cafe_a2a_turn_custody_shadow_new_block_total: 5,
  cat_cafe_a2a_protocol_action_without_custody_total: 0,
  cat_cafe_a2a_user_nudge_required_total: 0,
  cat_cafe_a2a_legacy_guard_without_active_custody_total: 5,
  cat_cafe_a2a_same_subject_post_terminal_enqueue_total: 0,
  cat_cafe_a2a_lease_succeeded_subject_nonterminal_total: 0,
};

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

const phaseTLiveNewOnlyCohorts = [
  {
    count: 2,
    input: {
      state: 'covered_active',
      projectionReason: 'not_applicable',
      sourceCategory: 'a2a',
      sourceSemantic: 'cross_thread_investigate',
      wakeProvenance: 'structured:dispatch',
      closeCheckpoint: 'route_settled',
      transitionObserved: false,
    },
  },
  {
    count: 6,
    input: {
      state: 'covered_active',
      projectionReason: 'not_applicable',
      sourceCategory: 'a2a',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'structured:dispatch',
      closeCheckpoint: 'route_settled',
      transitionObserved: false,
    },
  },
  {
    count: 4,
    input: {
      state: 'covered_active',
      projectionReason: 'not_applicable',
      sourceCategory: 'action_successor',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'action_successor',
      closeCheckpoint: 'next_turn_boundary',
      transitionObserved: false,
    },
  },
  {
    count: 10,
    input: {
      state: 'covered_active',
      projectionReason: 'not_applicable',
      sourceCategory: 'action_successor',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'action_successor',
      closeCheckpoint: 'route_settled',
      transitionObserved: false,
    },
  },
  {
    count: 4,
    input: {
      state: 'unknown_legacy',
      projectionReason: 'action_holder_mismatch',
      sourceCategory: 'action_successor',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'action_successor',
      closeCheckpoint: 'route_settled',
      transitionObserved: false,
    },
  },
  {
    count: 4,
    input: {
      state: 'unknown_legacy',
      projectionReason: 'carrier_missing',
      sourceCategory: 'ci',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'legacy:carrier_missing',
      closeCheckpoint: 'route_settled',
      transitionObserved: false,
    },
  },
  {
    count: 1,
    input: {
      state: 'unknown_legacy',
      projectionReason: 'carrier_missing',
      sourceCategory: 'review',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'legacy:carrier_missing',
      closeCheckpoint: 'route_settled',
      transitionObserved: false,
    },
  },
  {
    count: 3,
    input: {
      state: 'unknown_legacy',
      projectionReason: 'structured_holder_mismatch',
      sourceCategory: 'a2a',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'structured:dispatch',
      closeCheckpoint: 'next_turn_boundary',
      transitionObserved: false,
    },
  },
  {
    count: 2,
    input: {
      state: 'unknown_legacy',
      projectionReason: 'structured_holder_mismatch',
      sourceCategory: 'a2a',
      sourceSemantic: 'not_recorded',
      wakeProvenance: 'structured:dispatch',
      closeCheckpoint: 'route_settled',
      transitionObserved: false,
    },
  },
];

describe('F167 Phase T turn-custody stop-gate eval', () => {
  it('projects shadow utility, migration coverage, and the five cutover redlines', () => {
    const component = buildTurnCustodyStopGateEval({
      ...completeMetrics,
      // S.1-c is operational health. These counters must not enter this utility verdict.
      cat_cafe_a2a_managed_command_wake_sla_breach_total: 7,
      cat_cafe_a2a_return_delivery_overdue_total: 3,
    });

    assert.deepEqual(component.telemetryGaps, []);
    assert.equal(component.confidence, 'medium');
    assert.equal(component.activationCounts['turn_custody.projections_total'], 20);
    assert.equal(component.activationCounts['turn_custody.covered_active_total'], 8);
    assert.equal(component.activationCounts['turn_custody.covered_empty_total'], 11);
    assert.equal(component.activationCounts['turn_custody.unknown_legacy_total'], 1);
    assert.equal(component.activationCounts['turn_custody.unknown_legacy_rate'], 0.05);
    assert.equal(component.activationCounts['turn_custody.agreements_total'], 14);
    assert.equal(component.activationCounts['turn_custody.shadow_old_block_total'], 9);
    assert.equal(component.activationCounts['turn_custody.shadow_new_block_total'], 5);
    assert.equal(component.activationCounts['turn_custody.projected_block_increase_total'], 0);
    assert.equal(component.activationCounts['turn_custody.new_only_classified_total'], 1);
    assert.equal(component.activationCounts['turn_custody.new_only_justified_total'], 1);

    assert.equal(component.activationCounts['turn_custody.old_only_block_total'], 5);
    assert.equal(component.activationCounts['turn_custody.new_only_block_total'], 1);
    assert.equal(component.frictionCounts['turn_custody.old_only_block_total'], undefined);
    assert.equal(component.frictionCounts['turn_custody.new_only_block_total'], undefined);
    assert.equal(component.frictionCounts['turn_custody.projected_block_increase_total'], undefined);
    assert.equal(component.frictionCounts['turn_custody.new_only_unjustified_total'], 0);
    assert.equal(component.frictionCounts['turn_custody.new_only_unexplained_total'], 0);
    assert.equal(component.frictionCounts['turn_custody.new_only_classification_gap_total'], 0);
    assert.equal(component.frictionCounts['turn_custody.protocol_action_without_custody_total'], 0);
    assert.equal(component.frictionCounts['turn_custody.user_nudge_required_total'], 0);
    assert.equal(component.activationCounts['turn_custody.legacy_guard_without_active_custody_total'], 5);
    assert.equal(component.frictionCounts['turn_custody.legacy_guard_without_active_custody_total'], undefined);
    assert.equal(component.frictionCounts['turn_custody.same_subject_post_terminal_enqueue_total'], 0);
    assert.equal(component.frictionCounts['turn_custody.lease_succeeded_subject_nonterminal_total'], 0);
    assert.equal(component.frictionCounts.managed_command_wake_sla_breach_total, undefined);
    assert.equal(component.frictionCounts.return_delivery_overdue_total, undefined);

    assert.deepEqual(component.falsePositiveCandidates, ['turn_custody.old_only_block_total=5']);
    assert.deepEqual(component.bypassCandidates, ['turn_custody.new_only_block_total=1']);
  });

  it('surfaces redacted per-fire disagreement samples for weekly explanation', () => {
    const component = buildTurnCustodyStopGateEval(completeMetrics, [
      {
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'cat_cafe.a2a.turn_custody_shadow_sample',
        startTimeMs: 100,
        endTimeMs: 101,
        durationMs: 1,
        status: 'ok',
        attributes: {},
        events: [
          {
            name: TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME,
            timeMs: 100,
            attributes: {
              messageId: 'message-hash',
              invocationId: 'invocation-hash',
              threadId: 'thread-hash',
              'agent.id': 'codex-sol',
              'thread.system_kind': 'product',
              trigger: 'old_only_block',
              projectionState: 'covered_empty',
              closeCheckpoint: 'route_settled',
              wakeProvenance: 'unstructured:user_chat',
              transitionObserved: 'false',
              projectionReason: 'not_applicable',
              sourceCategory: 'user',
              sourceSemantic: 'not_recorded',
            },
          },
        ],
      },
    ]);

    const samples = component.frictionSamples['turn_custody.old_only_block_total'];
    assert.equal(samples.length, 1);
    assert.equal(samples[0].messageIdHash, 'message-hash');
    assert.deepEqual(samples[0].extras, {
      projectionState: 'covered_empty',
      closeCheckpoint: 'route_settled',
      wakeProvenance: 'unstructured:user_chat',
      transitionObserved: 'false',
      projectionReason: 'not_applicable',
      sourceCategory: 'user',
      sourceSemantic: 'not_recorded',
    });
  });

  it('surfaces bounded unknown agree-block samples for projection diagnosis', () => {
    const component = buildTurnCustodyStopGateEval(completeMetrics, [
      {
        traceId: 'trace-agree-block',
        spanId: 'span-agree-block',
        name: 'cat_cafe.a2a.turn_custody_shadow_sample',
        startTimeMs: 100,
        endTimeMs: 101,
        durationMs: 1,
        status: 'ok',
        attributes: {},
        events: [
          {
            name: 'turn_custody.unknown_legacy_agree_block',
            timeMs: 100,
            attributes: {
              messageId: 'message-hash',
              invocationId: 'invocation-hash',
              threadId: 'thread-hash',
              'agent.id': 'codex-sol',
              'thread.system_kind': 'product',
              trigger: 'agree_block',
              projectionState: 'unknown_legacy',
              closeCheckpoint: 'route_settled',
              wakeProvenance: 'structured:dispatch',
              transitionObserved: 'false',
              projectionReason: 'dispatch_handoff_missing',
              sourceCategory: 'a2a',
              sourceSemantic: 'cross_thread_investigate',
            },
          },
        ],
      },
    ]);

    const samples = component.frictionSamples['turn_custody.unknown_legacy_total'];
    assert.equal(samples.length, 1);
    assert.equal(samples[0].trigger, 'agree_block');
    assert.deepEqual(samples[0].extras, {
      projectionState: 'unknown_legacy',
      closeCheckpoint: 'route_settled',
      wakeProvenance: 'structured:dispatch',
      transitionObserved: 'false',
      projectionReason: 'dispatch_handoff_missing',
      sourceCategory: 'a2a',
      sourceSemantic: 'cross_thread_investigate',
    });
  });

  it('bounds trace-only diagnosis dimensions instead of admitting arbitrary values', () => {
    assert.equal(
      turnCustodyProjectionReason(['dispatch:subject', 'unknown:dispatch_handoff_missing']),
      'dispatch_handoff_missing',
    );
    assert.equal(turnCustodyProjectionReason(['unknown:user-controlled-value']), 'other');
    assert.equal(turnCustodyProjectionReason(['dispatch:subject']), 'not_applicable');
    assert.equal(boundedTurnCustodySourceCategory('review'), 'review');
    assert.equal(boundedTurnCustodySourceCategory('user-controlled-value'), 'unknown');
    assert.equal(boundedTurnCustodySourceSemantic('cross_thread_investigate'), 'cross_thread_investigate');
    assert.equal(boundedTurnCustodySourceSemantic('user-controlled-value'), 'not_recorded');
    assert.equal(
      turnCustodySourceSemantic({ terminalCoordination: false, effectClass: 'investigate' }),
      'cross_thread_investigate',
    );
    assert.equal(
      turnCustodySourceSemantic({ terminalCoordination: true, effectClass: 'investigate' }),
      'coordination_terminal',
    );
    assert.equal(
      turnCustodySourceSemantic({ terminalCoordination: false, effectClass: 'user-controlled-value' }),
      'not_recorded',
    );
    assert.equal(
      classifyTurnCustodyNewOnlyBlock({
        comparison: 'new_only_block',
        state: 'covered_active',
        projectionReason: 'not_applicable',
        sourceCategory: 'action_successor',
        sourceSemantic: 'not_recorded',
        wakeProvenance: 'action_successor',
        closeCheckpoint: 'route_settled',
        transitionObserved: false,
      }),
      'justified',
    );
    assert.equal(
      classifyTurnCustodyNewOnlyBlock({
        comparison: 'new_only_block',
        state: 'unknown_legacy',
        projectionReason: 'query_failed',
        sourceCategory: 'a2a',
        sourceSemantic: 'not_recorded',
        wakeProvenance: 'legacy:query_failed',
        closeCheckpoint: 'route_settled',
        transitionObserved: false,
      }),
      'unexplained',
    );
    assert.equal(
      classifyTurnCustodyNewOnlyBlock({
        comparison: 'new_only_block',
        state: 'covered_empty',
        projectionReason: 'not_applicable',
        sourceCategory: 'user',
        sourceSemantic: 'not_recorded',
        wakeProvenance: 'unstructured:user_chat',
        closeCheckpoint: 'route_settled',
        transitionObserved: false,
      }),
      'unjustified',
    );
    assert.equal(
      classifyTurnCustodyNewOnlyBlock({
        comparison: 'agree_allow',
        state: 'covered_empty',
        projectionReason: 'not_applicable',
        sourceCategory: 'user',
        sourceSemantic: 'not_recorded',
        wakeProvenance: 'unstructured:user_chat',
        closeCheckpoint: 'route_settled',
        transitionObserved: false,
      }),
      'not_applicable',
    );
  });

  it('classifies the full 36-row live new-only cohort from bounded machine evidence', () => {
    let classifiedRows = 0;
    for (const cohort of phaseTLiveNewOnlyCohorts) {
      assert.equal(classifyTurnCustodyNewOnlyBlock({ comparison: 'new_only_block', ...cohort.input }), 'justified');
      classifiedRows += cohort.count;
    }
    assert.equal(classifiedRows, 36);
  });

  it('keeps incoherent and non-obligation evidence fail-closed instead of laundering blocks', () => {
    const unknownCases = [
      {
        state: 'unknown_legacy',
        projectionReason: 'action_holder_mismatch',
        sourceCategory: 'a2a',
        sourceSemantic: 'not_recorded',
        wakeProvenance: 'action_successor',
        closeCheckpoint: 'route_settled',
        transitionObserved: false,
      },
      {
        state: 'unknown_legacy',
        projectionReason: 'carrier_missing',
        sourceCategory: 'a2a',
        sourceSemantic: 'not_recorded',
        wakeProvenance: 'legacy:carrier_missing',
        closeCheckpoint: 'route_settled',
        transitionObserved: false,
      },
      {
        state: 'covered_active',
        projectionReason: 'not_applicable',
        sourceCategory: 'a2a',
        sourceSemantic: 'cross_thread_coordinate',
        wakeProvenance: 'non_obligation:cross_thread_coordinate',
        closeCheckpoint: 'route_settled',
        transitionObserved: false,
      },
    ];
    for (const input of unknownCases) {
      assert.equal(classifyTurnCustodyNewOnlyBlock({ comparison: 'new_only_block', ...input }), 'unexplained');
    }

    assert.equal(
      classifyTurnCustodyNewOnlyBlock({
        comparison: 'new_only_block',
        state: 'covered_active',
        projectionReason: 'not_applicable',
        sourceCategory: 'action_successor',
        sourceSemantic: 'not_recorded',
        wakeProvenance: 'action_successor',
        closeCheckpoint: 'route_settled',
        transitionObserved: true,
      }),
      'unjustified',
    );
  });

  it('bounds carrier-missing justification to the registered first-party connector families', () => {
    for (const sourceCategory of ['ci', 'review', 'conflict', 'issue', 'continuation']) {
      assert.equal(
        classifyTurnCustodyNewOnlyBlock({
          comparison: 'new_only_block',
          state: 'unknown_legacy',
          projectionReason: 'carrier_missing',
          sourceCategory,
          sourceSemantic: 'not_recorded',
          wakeProvenance: 'legacy:carrier_missing',
          closeCheckpoint: 'route_settled',
          transitionObserved: false,
        }),
        'justified',
      );
    }
  });

  it('fails denominator closed when any new-only row lacks authoritative classification', () => {
    const component = buildTurnCustodyStopGateEval({
      ...completeMetrics,
      'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="new_only_block"}': 1,
    });

    assert.equal(component.activationCounts['turn_custody.new_only_classified_total'], 1);
    assert.equal(component.frictionCounts['turn_custody.new_only_classification_gap_total'], 1);
    assert.ok(component.telemetryGaps.some((candidate) => candidate.metric === 'turn_custody.new_only_classification'));
    assert.equal(component.confidence, 'low');
  });

  it('fails evidence closed when the labelled shadow families or redline counters are absent', () => {
    const component = buildTurnCustodyStopGateEval({});

    assert.equal(component.confidence, 'no-data');
    assert.ok(component.telemetryGaps.some((gap) => gap.metric === 'turn_custody.projection.covered_active'));
    assert.ok(component.telemetryGaps.some((gap) => gap.metric === 'turn_custody.comparison.old_only_block'));
    assert.ok(
      component.telemetryGaps.some((gap) => gap.metric === 'turn_custody.protocol_action_without_custody_total'),
    );
  });

  it('is included in the longitudinal F167 snapshot', () => {
    const snapshot = generateF167Snapshot({ ...emptyInput, metrics: completeMetrics });
    const component = snapshot.components.find((candidate) => candidate.componentId === 'turn-custody-stop-gate');

    assert.ok(component, 'F167 snapshot must consume the Phase T stop-gate shadow');
    assert.equal(component.telemetryGaps.length, 0);
  });

  it('treats every nonzero zero-target cutover redline as actionable', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: { ...completeMetrics, cat_cafe_a2a_user_nudge_required_total: 1 },
    });
    const report = generateAttributionReport({ featureId: 'F167', snapshot });
    const finding = report.findings.find(
      (candidate) => candidate.frictionSignal.type === 'turn_custody.user_nudge_required_total',
    );

    assert.ok(finding, 'one operator nudge must be visible without waiting for a count threshold');
    assert.equal(finding.frictionSignal.severity, 'high');
    assert.equal(finding.attribution.pipelineOrHuman, 'human-required');
  });

  it('treats unexplained and unjustified new-only classifications as zero-tolerance redlines', () => {
    for (const classification of ['unexplained', 'unjustified']) {
      const metrics = {
        ...completeMetrics,
        'cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="new_only_block",turn_custody_classification="justified"}': 0,
        [`cat_cafe_a2a_turn_custody_shadow_comparison_total{turn_custody_comparison="new_only_block",turn_custody_classification="${classification}"}`]: 1,
      };
      const snapshot = generateF167Snapshot({ ...emptyInput, metrics });
      const report = generateAttributionReport({ featureId: 'F167', snapshot });
      const finding = report.findings.find(
        (candidate) => candidate.frictionSignal.type === `turn_custody.new_only_${classification}_total`,
      );

      assert.ok(finding, `${classification} classification must block correctness`);
      assert.equal(finding.frictionSignal.severity, 'high');
    }
  });

  it('keeps projected block increase observational instead of grading legacy equivalence', () => {
    const snapshot = generateF167Snapshot({
      ...emptyInput,
      metrics: {
        ...completeMetrics,
        cat_cafe_a2a_turn_custody_shadow_old_block_total: 1,
        cat_cafe_a2a_turn_custody_shadow_new_block_total: 5,
      },
    });
    const component = snapshot.components.find((candidate) => candidate.componentId === 'turn-custody-stop-gate');
    const report = generateAttributionReport({ featureId: 'F167', snapshot });

    assert.equal(component.activationCounts['turn_custody.projected_block_increase_total'], 4);
    assert.equal(component.frictionCounts['turn_custody.projected_block_increase_total'], undefined);
    assert.equal(
      report.findings.some(
        (candidate) => candidate.frictionSignal.type === 'turn_custody.projected_block_increase_total',
      ),
      false,
    );
  });
});
