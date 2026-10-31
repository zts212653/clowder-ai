import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  ALL_CELLS,
  COHORT,
  candidate,
  loadEvaluationModules,
  ownerRef,
  RESULT,
  rubricRef,
  validMeasurementInput,
} from './capability-evolution-attribution.helper.mjs';

describe('F311 Phase 3 durable attribution replay and F307 explanation', () => {
  let assessMeasurementJoin;
  let assessRubricComparability;
  let resolveAttribution;
  let evaluateInterventionGate;
  let toAttributionGateView;
  let projectEvolutionAttribution;
  let buildAttributionExplanation;
  let projectAttributionExplanation;

  before(async () => {
    ({
      assessMeasurementJoin,
      assessRubricComparability,
      resolveAttribution,
      evaluateInterventionGate,
      toAttributionGateView,
      projectEvolutionAttribution,
      buildAttributionExplanation,
      projectAttributionExplanation,
    } = await loadEvaluationModules());
  });

  describe('Workbench read path survives restart', () => {
    const envelope = (expectedSequence, event) => ({
      schemaVersion: 1,
      eventId: `event-${expectedSequence}`,
      programId: 'prog-1',
      expectedSequence,
      clientMessageId: `client-${expectedSequence}`,
      actorRef: 'cat:opus5',
      originRef: 'thread:t1',
      occurredAt: '2026-09-01T08:00:00.000Z',
      event,
    });
    const diagnosisEvent = (verdict, extra = {}) =>
      envelope(5, {
        type: 'attribution_linked',
        attributionRef: ownerRef('F311', 'evolution-attribution:prog-1:1'),
        disposition: verdict === 'attributed' ? 'intervention_candidate' : 'no_intervention',
        diagnosis: {
          verdict,
          ...(verdict === 'attributed' ? { primaryLayer: 'execution' } : {}),
          assessedLayers: ['execution'],
          competingLayers: verdict === 'attributed' ? ['execution'] : [],
          evidenceRefs: [RESULT],
          uncertaintyBasis: 'interval',
          comparabilityMode: 'unchanged',
          reasonCodes: verdict === 'attributed' ? [] : ['no_discriminating_evidence'],
          ...extra,
        },
      });

    it('has nothing to show before this cycle produced an attribution', () => {
      assert.equal(projectEvolutionAttribution([]), null);
    });

    it('rebuilds the explanation from the event stream alone', () => {
      const explanation = projectEvolutionAttribution([
        diagnosisEvent('unresolved'),
        envelope(6, {
          type: 'observe_or_insufficient_recorded',
          result: 'observe',
          autoRecheckRef: ownerRef('F192', 'eval-trigger:prog-1'),
          gateBlockers: [{ code: 'intervention_card_missing', ownerFeatureId: 'F267' }],
        }),
      ]);
      assert.equal(explanation.verdict, 'unresolved');
      assert.equal(explanation.gate.status, 'blocked');
      assert.deepEqual(
        explanation.gate.blockers.map((blocker) => blocker.code),
        ['intervention_card_missing'],
      );
      assert.ok(explanation.whyNotChange.some((line) => line.includes('无法把任何一层与其他层区分开')));
    });

    it('shows Change Review as open once the gate actually opened', () => {
      const explanation = projectEvolutionAttribution([
        diagnosisEvent('attributed'),
        envelope(6, {
          type: 'intervention_linked',
          interventionCardRef: ownerRef('F267', 'intervention-card:c1'),
          interventionLayerRef: ownerRef('F202', 'intervention-layer:skill'),
          gateReceiptRef: ownerRef('F267', 'intervention-gate-receipt:c1'),
        }),
      ]);
      assert.equal(explanation.verdict, 'attributed');
      assert.equal(explanation.gate.status, 'ready');
      assert.deepEqual(explanation.whyNotChange, []);
    });

    it('does not carry a closed cycle conclusion into the next one', () => {
      const explanation = projectEvolutionAttribution([
        diagnosisEvent('unresolved'),
        envelope(6, {
          type: 'decision_recorded',
          decision: 'tune',
          decisionRef: ownerRef('F311', 'evolution-decision:prog-1:1'),
        }),
      ]);
      assert.equal(explanation, null);
    });
  });

  describe('F307 explanation speaks human and carries refs only', () => {
    const build = (candidates) => {
      const measurement = assessMeasurementJoin(validMeasurementInput());
      const comparability = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v3'),
      });
      const attribution = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement,
        comparability,
        candidates,
      });
      const gate = evaluateInterventionGate({ attribution: toAttributionGateView(attribution) });
      return buildAttributionExplanation({ measurement, comparability, attribution, gate });
    };

    it('explains evidence, competing attributions, confidence and why not to change', () => {
      const explanation = build([candidate('execution', true), candidate('observation', true)]);
      assert.equal(explanation.schemaVersion, 1);
      assert.equal(explanation.verdict, 'unresolved');
      assert.ok(explanation.headline.length > 0);
      assert.ok(explanation.evidence.length > 0);
      assert.equal(explanation.competingAttributions.length, 2);
      assert.ok(explanation.competingAttributions.every((entry) => entry.label.length > 0));
      assert.equal(explanation.confidence.basis, 'interval');
      assert.ok(explanation.confidence.label.length > 0);
      assert.ok(explanation.whyNotChange.length > 0);
      assert.equal(explanation.gate.status, 'blocked');
    });

    it('names the layers nobody looked at instead of pretending they were ruled out', () => {
      const explanation = build([candidate('execution', true)]);
      assert.deepEqual(
        explanation.notAssessedLayers.map((entry) => entry.layer),
        ['harness', 'rubric', 'observation'],
      );
      assert.ok(explanation.notAssessedLayers.every((entry) => entry.label.length > 0));
    });

    it('rebuilds the same explanation from the durable snapshot after a restart', () => {
      const measurement = assessMeasurementJoin(validMeasurementInput());
      const comparability = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v3'),
      });
      const attribution = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement,
        comparability,
        candidates: [candidate('execution', true), candidate('observation', true)],
      });
      const gate = evaluateInterventionGate({ attribution: toAttributionGateView(attribution) });
      const live = buildAttributionExplanation({ measurement, comparability, attribution, gate });
      const replayed = projectAttributionExplanation({
        diagnosis: attribution.event.diagnosis,
        gateBlockers: gate.fallbackEvent.gateBlockers,
      });

      assert.equal(replayed.verdict, live.verdict);
      assert.equal(replayed.headline, live.headline);
      assert.deepEqual(replayed.competingAttributions, live.competingAttributions);
      assert.deepEqual(replayed.notAssessedLayers, live.notAssessedLayers);
      assert.equal(replayed.confidence.basis, live.confidence.basis);
      assert.equal(replayed.confidence.label, live.confidence.label);
      assert.deepEqual(replayed.comparability, live.comparability);
      assert.deepEqual(
        replayed.evidence.map((entry) => entry.ownerStateRef),
        live.evidence.map((entry) => entry.ownerStateRef),
      );
      assert.equal(replayed.gate.status, 'blocked');
      assert.ok(replayed.whyNotChange.some((line) => line.includes('多层同时被证据支持')));
      assert.ok(replayed.whyNotChange.some((line) => line.includes('intervention card')));
    });

    it('does not narrate a partial 2x2 as if the rejudge had been completed', () => {
      const measurement = assessMeasurementJoin(validMeasurementInput());
      const comparability = assessRubricComparability({
        frozenCohortRef: COHORT,
        previousRubricRef: rubricRef('v3'),
        currentRubricRef: rubricRef('v4'),
        rejudge: { frozenCohortRef: COHORT, cells: ALL_CELLS.slice(0, 3) },
      });
      const attribution = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement,
        comparability,
        candidates: [candidate('execution', true)],
      });
      const gate = evaluateInterventionGate({ attribution: toAttributionGateView(attribution) });
      const explanation = buildAttributionExplanation({ measurement, comparability, attribution, gate });
      assert.equal(explanation.comparability.status, 'incomparable');
      assert.ok(!explanation.comparability.label.includes('跑满'));
      assert.deepEqual(
        projectAttributionExplanation({
          diagnosis: attribution.event.diagnosis,
          gateBlockers: gate.fallbackEvent.gateBlockers,
        }).comparability,
        explanation.comparability,
      );
    });

    it('never carries owner payload, only owner refs', () => {
      const explanation = build([candidate('execution', true)]);
      const serialized = JSON.stringify(explanation);
      for (const forbidden of ['rubricText', 'observedLoss', 'trajectory', 'pointEstimate']) {
        assert.ok(!serialized.includes(forbidden), `${forbidden} must not leak into the F311 explanation`);
      }
      for (const entry of explanation.evidence) {
        assert.equal(typeof entry.ownerFeatureId, 'string');
        assert.equal(typeof entry.ownerStateRef, 'string');
      }
    });
  });
});
