import type { MeasurementDecisionProofResolver } from '../harness-eval/measurement/measurement-decision-proof-resolver.js';
import type { EvaluationOwnerResolver, OwnerMeasurementResolution } from './program-evaluation-linker.js';

/**
 * F311 Phase 3 — the real F267 join for the evaluation ingress.
 *
 * Everything here is READ from F267's verified decision proof; nothing is derived from the request.
 * Specifically, everything comes from the owner's NORMALIZED projection: F267 publishes canonical
 * owner refs for the certificate, result, evaluation cohort, exposure proof and promotion holdout,
 * plus the uncertainty basis its own result artifact states. F311 never reads the proof's raw
 * subject fields — those are repository paths for the owner's reader, and wrapping a path as an
 * owner ref would be this Feature manufacturing owner identity.
 *
 * Facts the owner does not publish stay absent rather than defaulted. A missing baseline, a missing
 * exposure proof or an unknown holdout exposure each drive the Program to `insufficient` /
 * `unresolved`, which is the honest answer; there is no path here by which silence becomes safety.
 *
 * `verified` is about the evidence chain, not the measurement. The owner's
 * `measurementDecisionStatus` is carried through untouched, so a verified proof over an insufficient
 * measurement stays insufficient.
 */

export function createProgramEvaluationOwnerResolver(input: {
  decisionProofResolver: MeasurementDecisionProofResolver;
}): EvaluationOwnerResolver {
  return {
    async resolveMeasurement({ ownerUserId, evidenceProofRef }): Promise<OwnerMeasurementResolution> {
      const resolution = await input.decisionProofResolver.resolve({ ownerUserId, evidenceProofRef });
      if (resolution.status !== 'resolved') {
        return { status: 'unavailable', reason: resolution.reason };
      }
      const proof = resolution.proof;
      if (proof.status !== 'verified') {
        return { status: 'unavailable', reason: 'decision proof is not verified' };
      }
      const normalized = resolution.normalized;
      if (normalized === undefined) {
        // A verified proof with no owner-published identities is an owner-side contract gap, not
        // something to paper over: without canonical refs there is nothing honest to persist.
        return { status: 'unavailable', reason: 'owner published no canonical refs for this proof' };
      }
      // Evidence used for attribution must be role-tagged for attribution by its owner.
      if (!proof.evidenceRole.roles.includes('attribution')) {
        return { status: 'unavailable', reason: 'evidence cohort is not owner-tagged for attribution' };
      }
      return {
        status: 'ready',
        bundle: {
          certificateRef: normalized.certificateRef,
          resultRef: normalized.resultRef,
          ownerDecisionStatus: normalized.measurementDecisionStatus,
          frozenCohortRef: normalized.evaluationCohortRef,
          ...(normalized.baselineRef === undefined ? {} : { baselineRef: normalized.baselineRef }),
          ...(normalized.exposureProofRef === undefined ? {} : { exposureProofRef: normalized.exposureProofRef }),
          ...(normalized.discriminatingLayers === undefined
            ? {}
            : { discriminatingLayers: normalized.discriminatingLayers }),
          ...(normalized.discriminationProofRef === undefined
            ? {}
            : { discriminationProofRef: normalized.discriminationProofRef }),
          ...(normalized.rubricRef === undefined ? {} : { rubricRef: normalized.rubricRef }),
          // The card is assembled entirely from what the owner published, including the holdout and
          // its exposure — F311 contributes no element of it.
          ...(normalized.interventionCard === undefined
            ? {}
            : {
                gateReceiptRef: normalized.interventionCard.gateReceiptRef,
                interventionCard: {
                  ...normalized.interventionCard,
                  ...(normalized.promotionHoldoutRef === undefined
                    ? {}
                    : { promotionHoldoutRef: normalized.promotionHoldoutRef }),
                  ...(normalized.exposureProofRef === undefined
                    ? {}
                    : { holdoutExposureProofRef: normalized.exposureProofRef }),
                  ...(normalized.holdoutOptimizerExposed === undefined
                    ? {}
                    : { holdoutOptimizerExposed: normalized.holdoutOptimizerExposed }),
                },
              }),
          ...(normalized.uncertainty === undefined ? {} : { uncertainty: normalized.uncertainty }),
          ...(normalized.holdoutOptimizerExposed === undefined
            ? {}
            : { holdoutOptimizerExposed: normalized.holdoutOptimizerExposed }),
        },
      };
    },
  };
}
