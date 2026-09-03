import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { EvolutionProgramServiceResult } from './program-command-contract.js';
import { guardedAppend } from './program-command-identity.js';
import {
  EvolutionProgramEvaluationError,
  type ProgramEvaluationDependencies,
  type ProgramEvaluationLinkBase,
} from './program-evaluation-contract.js';

/**
 * The two producers a Program needs to leave `constituting` and enter `evaluating`.
 *
 * Without these the canonical lifecycle existed only in the reducer: `create()` landed a Program in
 * `constituting` and nothing public could move it, so every "real Program stream" test had to append
 * events straight into the log. That proves the reducer accepts a transition; it proves nothing about
 * whether the product can perform one. These close that gap through the same service and the same
 * append path as every other command.
 */

export interface ProgramCertificatesLinkInput extends ProgramEvaluationLinkBase {
  /**
   * Governance pointers, not owner verdicts. Which artifact a Program is constituted around is the
   * workspace's decision to state; what that artifact SAYS is never read from here — the measurement
   * certificate named here is later checked against the certificate F267's own verified proof is
   * bound to, so a Program cannot be constituted around one certificate and evaluated on another.
   */
  certificates: { goal: OwnerTruthRefV1; measurement: OwnerTruthRefV1; economic: OwnerTruthRefV1 };
  valueOwnerRef: OwnerTruthRefV1;
  measurementRoleRefs: {
    observer: OwnerTruthRefV1;
    domainOwner: OwnerTruthRefV1;
    consumer: OwnerTruthRefV1;
    calibrator: OwnerTruthRefV1;
    overlapJustification?: string;
  };
}

export interface ProgramEvaluationTriggerInput extends ProgramEvaluationLinkBase {
  ownerUserId: string;
  /** Identity of the F267 decision proof whose exposure facts open this round. */
  evidenceProofRef: OwnerTruthRefV1;
}

/**
 * What F192 returns when a trigger actually fires. `dedupeKey` is F192's own identity for the
 * dispatch, which is why the receipt can name it without F311 inventing an id.
 */
export interface EvolutionTriggerDispatch {
  outcome: string;
  dedupeKey: string;
}

export function linkEvolutionProgramCertificates(
  input: ProgramCertificatesLinkInput,
  deps: ProgramEvaluationDependencies,
): Promise<EvolutionProgramServiceResult> {
  return guardedAppend(input, deps, () => ({
    type: 'certificates_linked' as const,
    certificates: input.certificates,
    valueOwnerRef: input.valueOwnerRef,
    measurementRoleRefs: input.measurementRoleRefs,
  }));
}

/**
 * Opens an evaluation round — but only when F192 says a round opened.
 *
 * A caller cannot start a round on demand: that would let anyone reset the Cycle and discard the
 * diagnosis the previous round landed. The Program asks F192 to dispatch against the registration it
 * already holds, and appends nothing unless F192 reports it fired. The receipt is named from F192's
 * own dedupe key, and the exposure proof comes from F267's normalized projection — neither is
 * accepted from the request.
 */
export function triggerEvolutionProgramEvaluation(
  input: ProgramEvaluationTriggerInput,
  deps: ProgramEvaluationDependencies & {
    dispatchEvaluationTrigger?: (context: { programId: string }) => Promise<EvolutionTriggerDispatch>;
  },
): Promise<EvolutionProgramServiceResult> {
  return guardedAppend(input, deps, async (_events, projection) => {
    const registration = projection.observation.trigger?.registrationRef;
    if (registration === undefined) {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        'no F192 trigger registration is linked to this Program; there is nothing to evaluate against',
      );
    }
    if (!deps.dispatchEvaluationTrigger) {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        'the F192 trigger dispatch lane is not wired; the Program will not open a round on its own authority',
      );
    }
    if (!deps.ownerResolver) {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        'F267 measurement owner contract is not available; a round cannot open without an owner exposure proof',
      );
    }

    const resolution = await deps.ownerResolver.resolveMeasurement({
      ownerUserId: input.ownerUserId,
      evidenceProofRef: input.evidenceProofRef,
    });
    if (resolution.status !== 'ready') {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        `owner exposure evidence unavailable: ${resolution.reason}`,
      );
    }
    const exposureProofRef = resolution.bundle.exposureProofRef;
    if (exposureProofRef === undefined) {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        'the owner published no optimizer-exposure proof for this round; F311 will not substitute one',
      );
    }

    const dispatch = await deps.dispatchEvaluationTrigger({ programId: input.programId });
    if (dispatch.outcome === 'unavailable') {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        'the F192 round dispatch lane is unavailable; the Program will not open a round on its own authority',
      );
    }
    if (dispatch.outcome !== 'dispatched') {
      // F192 declined — a suppressed window or a dedupe. That is an answer, not an error to retry.
      throw new EvolutionProgramEvaluationError(
        'invalid_request',
        `F192 did not open a round for this Program (${dispatch.outcome}); the Cycle stays where it is`,
      );
    }
    return {
      type: 'evaluation_triggered' as const,
      // Named from F192's own dispatch identity, so the receipt points at something F192 can resolve.
      triggerReceiptRef: {
        ownerFeatureId: registration.ownerFeatureId,
        ownerStateRef: `eval-trigger-dispatch:${dispatch.dedupeKey}`,
      },
      exposureProofRef,
    };
  });
}
