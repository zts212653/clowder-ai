import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  COHORT,
  candidate,
  completeCard,
  loadEvaluationModules,
  ownerRef,
  rubricRef,
  validMeasurementInput,
} from './capability-evolution-attribution.helper.mjs';

describe('F311 Phase 3 intervention gate', () => {
  let assessMeasurementJoin;
  let assessRubricComparability;
  let resolveAttribution;
  let evaluateInterventionGate;
  let toAttributionGateView;

  before(async () => {
    ({
      assessMeasurementJoin,
      assessRubricComparability,
      resolveAttribution,
      evaluateInterventionGate,
      toAttributionGateView,
    } = await loadEvaluationModules());
  });

  describe('intervention gate guards Change Review', () => {
    const attributed = () =>
      resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput()),
        comparability: assessRubricComparability({
          frozenCohortRef: COHORT,
          previousRubricRef: rubricRef('v3'),
          currentRubricRef: rubricRef('v3'),
        }),
        candidates: [candidate('execution', true)],
      });

    const gateInput = (cardOverrides) => ({
      attribution: toAttributionGateView(attributed()),
      card: completeCard(cardOverrides),
      interventionLayerRef: ownerRef('F202', 'intervention-layer:skill:video-forge'),
      gateReceiptRef: ownerRef('F267', 'intervention-gate-receipt:evolve-video-skill:c1'),
    });

    it('opens Change Review only with a complete owner-held card', () => {
      const verdict = evaluateInterventionGate(gateInput());
      assert.equal(verdict.status, 'ready');
      assert.deepEqual(verdict.blockers, []);
      assert.equal(verdict.event.type, 'intervention_linked');
      assert.deepEqual(verdict.event.interventionCardRef, completeCard().cardRef);
    });

    it('blocks when any required card component is missing', () => {
      const matrix = [
        ['causalHypothesisRef', 'causal_hypothesis_missing'],
        ['expectedDeltaRef', 'expected_delta_missing'],
        ['replayCohortRef', 'replay_cohort_missing'],
        ['promotionHoldoutRef', 'promotion_holdout_missing'],
        ['holdoutExposureProofRef', 'holdout_exposure_proof_missing'],
        ['interventionFalsifierRef', 'intervention_falsifier_missing'],
        ['rubricReopenTriggerRef', 'rubric_reopen_trigger_missing'],
        ['costRef', 'cost_missing'],
        ['rollbackRef', 'rollback_missing'],
      ];
      for (const [field, code] of matrix) {
        const verdict = evaluateInterventionGate(gateInput({ [field]: undefined }));
        assert.equal(verdict.status, 'blocked', field);
        assert.equal(verdict.event, undefined, field);
        assert.ok(
          verdict.blockers.some((blocker) => blocker.code === code),
          `${field} should raise ${code}`,
        );
      }
    });

    it('blocks empty guardrails and single-sided competing attributions', () => {
      assert.ok(
        evaluateInterventionGate(gateInput({ guardrailRefs: [] })).blockers.some(
          (blocker) => blocker.code === 'guardrails_missing',
        ),
      );
      const single = evaluateInterventionGate(
        gateInput({ competingAttributionRefs: [ownerRef('F267', 'competing-attribution:harness')] }),
      );
      assert.ok(single.blockers.some((blocker) => blocker.code === 'competing_attributions_missing'));
    });

    it('blocks a holdout that is the replay cohort or already optimizer-exposed', () => {
      const reused = evaluateInterventionGate(gateInput({ promotionHoldoutRef: COHORT }));
      assert.ok(reused.blockers.some((blocker) => blocker.code === 'promotion_holdout_contaminated'));
      const exposed = evaluateInterventionGate(gateInput({ holdoutOptimizerExposed: true }));
      assert.ok(exposed.blockers.some((blocker) => blocker.code === 'promotion_holdout_contaminated'));
    });

    it('fails closed when the holdout exposure status was never declared', () => {
      const verdict = evaluateInterventionGate(gateInput({ holdoutOptimizerExposed: undefined }));
      assert.equal(verdict.status, 'blocked');
      assert.ok(verdict.blockers.some((blocker) => blocker.code === 'holdout_exposure_status_missing'));
    });

    it('does not let one attribution repeated twice pass as two competing ones', () => {
      const duplicate = ownerRef('F267', 'competing-attribution:harness');
      const verdict = evaluateInterventionGate(gateInput({ competingAttributionRefs: [duplicate, { ...duplicate }] }));
      assert.equal(verdict.status, 'blocked');
      assert.ok(verdict.blockers.some((blocker) => blocker.code === 'competing_attributions_missing'));
    });

    it('blocks a card that F311 would own itself', () => {
      const verdict = evaluateInterventionGate(gateInput({ cardRef: ownerRef('F311', 'local-card:copy') }));
      assert.ok(verdict.blockers.some((blocker) => blocker.code === 'intervention_card_not_owner_held'));
    });

    it('blocks a missing card entirely', () => {
      const verdict = evaluateInterventionGate({ attribution: toAttributionGateView(attributed()) });
      assert.equal(verdict.status, 'blocked');
      assert.ok(verdict.blockers.some((blocker) => blocker.code === 'intervention_card_missing'));
    });

    it('blocks a perfect card when the attribution is not actionable', () => {
      const unresolved = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput()),
        comparability: assessRubricComparability({
          frozenCohortRef: COHORT,
          previousRubricRef: rubricRef('v3'),
          currentRubricRef: rubricRef('v3'),
        }),
        candidates: [candidate('execution', true), candidate('rubric', true)],
      });
      const verdict = evaluateInterventionGate({ ...gateInput(), attribution: toAttributionGateView(unresolved) });
      assert.equal(verdict.status, 'blocked');
      assert.ok(verdict.blockers.some((blocker) => blocker.code === 'attribution_not_actionable'));
    });

    it('offers a zero-approval fallback and human why-not-change text when blocked', () => {
      const verdict = evaluateInterventionGate({ attribution: toAttributionGateView(attributed()) });
      assert.equal(verdict.fallbackEvent.type, 'observe_or_insufficient_recorded');
      assert.equal(verdict.fallbackEvent.result, 'observe');
      assert.deepEqual(
        verdict.fallbackEvent.gateBlockers.map((entry) => entry.code),
        ['intervention_card_missing'],
      );
      assert.ok(verdict.whyNotChange.length > 0);
      assert.ok(verdict.whyNotChange.every((line) => typeof line === 'string' && line.length > 0));
    });

    it('falls back to insufficient when the evidence itself was not usable', () => {
      const insufficient = resolveAttribution({
        programId: 'prog-evolve-video-skill',
        cycle: 1,
        measurement: assessMeasurementJoin(validMeasurementInput({ ownerDecisionStatus: 'insufficient' })),
        comparability: assessRubricComparability({
          frozenCohortRef: COHORT,
          previousRubricRef: rubricRef('v3'),
          currentRubricRef: rubricRef('v3'),
        }),
        candidates: [],
      });
      const verdict = evaluateInterventionGate({ attribution: toAttributionGateView(insufficient) });
      assert.equal(verdict.fallbackEvent.result, 'insufficient');
    });
  });
});
