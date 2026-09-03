import type {
  AssetVersionRefV1,
  EvolutionProgramEventEnvelopeV1,
  EvolutionProgramEventV1,
  OwnerTruthRefV1,
} from '@cat-cafe/shared';
import type { AttributionGateView, OwnerHeldInterventionCardRefs } from './intervention-gate.js';
import type { EvolutionProgramServiceResult } from './program-command-contract.js';
import type {
  AttributionCandidateInput,
  EvolutionAttributionLayer,
  MeasurementUncertaintyBasis,
  RejudgeCell,
} from './program-eval-bridge.js';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

/**
 * F311 Phase 3 - the shape of the evaluation ingress, kept apart from the writer that enforces it.
 *
 * These declarations say what a caller may state and what only the owner may state. That boundary is
 * the whole point of the ingress, so it is worth reading on its own without the append machinery
 * around it.
 */

/**
 * Ingress-level rejection. The kind matters to the caller: "the owner cannot prove this yet" is a
 * normal state to retry later, while "this request contradicts the Program's stream" is the
 * caller's bug. Collapsing them into one status told users to wait for evidence that was never
 * the problem.
 */
export type EvolutionProgramEvaluationErrorKind = 'owner_evidence_unavailable' | 'invalid_request';

export class EvolutionProgramEvaluationError extends Error {
  constructor(
    readonly kind: EvolutionProgramEvaluationErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'EvolutionProgramEvaluationError';
  }
}

export interface ProgramEvaluationLinkBase {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  actorRef: string;
  originRef: string;
}

/**
 * What F267 says about a measurement. This is resolved from the owner, never accepted from a
 * caller: a request that could assert `ownerDecisionStatus: 'usable'` plus a well-shaped cohort ref
 * could manufacture an attribution out of nothing.
 */
export interface OwnerMeasurementBundle {
  /** The certificate the owner's proof is bound to; checked against the Program's own constitution. */
  certificateRef?: OwnerTruthRefV1;
  /** The measurement result the proof is bound to, as a canonical owner ref. */
  resultRef?: OwnerTruthRefV1;
  ownerDecisionStatus: 'usable' | 'insufficient';
  frozenCohortRef?: OwnerTruthRefV1;
  baselineRef?: OwnerTruthRefV1;
  exposureProofRef?: OwnerTruthRefV1;
  uncertainty?: { evidenceRef: OwnerTruthRefV1; basis: MeasurementUncertaintyBasis };
  /** Owner-declared per layer: which evidence actually discriminates that layer from the others. */
  discriminatingLayers?: EvolutionAttributionLayer[];
  /** The owner object backing that declaration, persisted so the claim stays auditable. */
  discriminationProofRef?: OwnerTruthRefV1;
  /** The ruler the owner actually scored with, read from its certificate's decision procedure. */
  rubricRef?: AssetVersionRefV1;
  /** The owner-held intervention card, resolved. Absent = the gate has no card and stays closed. */
  interventionCard?: OwnerHeldInterventionCardRefs;
  /** The owner's gate receipt. F311 may not mint this — it would be authorising its own change. */
  gateReceiptRef?: OwnerTruthRefV1;
  /** Owner-declared: has the promotion holdout been seen by the optimizer? */
  holdoutOptimizerExposed?: boolean;
}

export type OwnerMeasurementResolution =
  | { status: 'ready'; bundle: OwnerMeasurementBundle }
  | { status: 'unavailable'; reason: string };

export interface EvaluationOwnerResolver {
  resolveMeasurement(input: {
    ownerUserId: string;
    /** The F267 decision proof to read. Named for what it is, so no caller mistakes it for a result. */
    evidenceProofRef: OwnerTruthRefV1;
  }): Promise<OwnerMeasurementResolution>;
}

export interface ProgramMeasurementLinkInput extends ProgramEvaluationLinkBase {
  ownerUserId: string;
  /** Addresses the owner's decision proof; every measurement fact is read out of it. */
  evidenceProofRef: OwnerTruthRefV1;
}

/**
 * A rejudge cell names the DECISION PROOF behind that cell's result, not the result itself. The
 * Program resolves it, so the cell's rubric axis can be checked against the ruler that proof was
 * actually scored with — a caller could otherwise label any four refs as a complete 2x2 and have the
 * comparison declared comparable.
 */
export interface ProgramRejudgeCellInput {
  rubric: 'previous' | 'current';
  candidate: 'previous' | 'current';
  evidenceProofRef: OwnerTruthRefV1;
}

export interface ProgramAttributionLinkInput extends ProgramMeasurementLinkInput {
  rejudge?: { cells: ProgramRejudgeCellInput[] };
  /** Identity of the decision proof for a rebuilt baseline; the result ref comes from the owner. */
  baselineRebuildProofRef?: OwnerTruthRefV1;
  /** Which layers to consider and with what owner evidence; discrimination comes from the owner. */
  candidates: Array<Omit<AttributionCandidateInput, 'discriminating'>>;
}

export interface ProgramInterventionLinkInput extends ProgramEvaluationLinkBase {
  ownerUserId: string;
  /**
   * Read from the Program's own durable stream by the service — never restated by a caller.
   * A client that could declare its own attribution could walk straight through the gate.
   */
  attribution: AttributionGateView;
  /**
   * The decision proof this round landed on, taken from the Program's own lineage. The card is then
   * resolved from it: nothing about the card — not one falsifier, not the holdout, not the cost —
   * crosses the ingress from the request.
   */
  decisionProofRef: OwnerTruthRefV1;
  /** F192 registration the zero-approval lane re-checks against; owner-held, never invented here. */
  autoRecheckRef: OwnerTruthRefV1;
}

/**
 * The current Cycle's durable attribution, or null. Reset on Cycle rotation and on a new evaluation
 * round for the same reason the read projection resets: a stale diagnosis must never authorise a
 * gate decision about today.
 */
export function latestAttributionGateView(
  events: readonly EvolutionProgramEventEnvelopeV1[],
): AttributionGateView | null {
  let view: AttributionGateView | null = null;
  for (const envelope of events) {
    const event = envelope.event;
    if (
      event.type === 'decision_recorded' ||
      event.type === 'evaluation_triggered' ||
      event.type === 'measurement_linked'
    ) {
      view = null;
    } else if (event.type === 'attribution_linked') {
      view = {
        verdict: event.diagnosis.verdict,
        disposition: event.disposition,
        attributionRef: event.attributionRef,
      };
    }
  }
  return view;
}

export interface ProgramEvaluationDependencies {
  read(programId: string): Promise<EvolutionProgramEventEnvelopeV1[]>;
  project(events: readonly EvolutionProgramEventEnvelopeV1[]): EvolutionProgramProjectionV1;
  envelope(
    input: ProgramEvaluationLinkBase,
    event: EvolutionProgramEventV1,
    commandDigest: string,
  ): EvolutionProgramEventEnvelopeV1;
  append(envelope: EvolutionProgramEventEnvelopeV1): Promise<EvolutionProgramServiceResult>;
  /** Absent resolver = the owner contract is not wired; the ingress then fails closed. */
  ownerResolver?: EvaluationOwnerResolver;
}
