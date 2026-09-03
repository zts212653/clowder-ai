import {
  type AssetVersionRefV1,
  assetRefIdentity,
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  type OwnerTruthRefV1,
  refIdentity,
} from '@cat-cafe/shared';
import { evaluateInterventionGate } from './intervention-gate.js';
import type { EvolutionProgramServiceResult } from './program-command-contract.js';
import { guardedAppend } from './program-command-identity.js';
import {
  assessMeasurementJoin,
  assessRubricComparability,
  type RejudgeCell,
  resolveAttribution,
} from './program-eval-bridge.js';
import {
  EvolutionProgramEvaluationError,
  type OwnerMeasurementBundle,
  type ProgramAttributionLinkInput,
  type ProgramEvaluationDependencies,
  type ProgramInterventionLinkInput,
  type ProgramMeasurementLinkInput,
} from './program-evaluation-contract.js';
import {
  measurementJoinInput,
  requireCanonicalSubject,
  requireLinkedEvidence,
  requireOwnerBundle,
} from './program-evaluation-resolution.js';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

/**
 * F311 Phase 3 - the production writer (AC-31-33).
 *
 * Without this, the evaluation and gate logic would only ever be reachable from tests: the Program
 * could render a diagnosis but never actually produce one. Callers cross this boundary with
 * IDENTITIES only: the owner's verdict, cohort, exposure and holdout facts are resolved from F267,
 * candidate evidence must already be connected by Phase 2, and the gate reads the attribution from
 * the Program's own stream. F311 runs the bridges, then appends the canonical event.
 *
 * The ingress contract itself lives in `program-evaluation-contract.ts`; everything here enforces it.
 */

export * from './program-evaluation-contract.js';

/**
 * The ruler the PREVIOUS round was scored with.
 *
 * Read from the Program's own stream, never from the request: "did the ruler move" has to be asked
 * against what the owner actually used last time. A caller that could state the previous rubric
 * could declare a moved ruler unchanged, or an unchanged one moved, and either way decide its own
 * comparability.
 */
function previousRubricRef(events: readonly EvolutionProgramEventEnvelopeV1[]): AssetVersionRefV1 | undefined {
  let seenCurrentRound = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type !== 'measurement_linked') continue;
    if (!seenCurrentRound) {
      seenCurrentRound = true;
      continue;
    }
    return event.rubricRef;
  }
  return undefined;
}

/**
 * Turns each declared 2x2 cell into an owner-resolved result, and checks that the cell is where the
 * caller says it is: a cell claiming the `previous` rubric axis must resolve to a proof the owner
 * scored with the previous ruler. Without this, four arbitrary refs labelled as a full matrix were
 * enough to have the comparison declared comparable.
 */
async function resolveRejudge(
  input: ProgramAttributionLinkInput,
  deps: ProgramEvaluationDependencies,
  rulers: { previous: AssetVersionRefV1; current: AssetVersionRefV1 },
  frozenCohortRef: OwnerTruthRefV1,
): Promise<{ frozenCohortRef: OwnerTruthRefV1; cells: RejudgeCell[] } | undefined> {
  if (input.rejudge === undefined) return undefined;
  const cells: RejudgeCell[] = [];
  for (const cell of input.rejudge.cells) {
    const bundle = await requireOwnerBundle({ ...input, evidenceProofRef: cell.evidenceProofRef }, deps, undefined);
    const { resultRef } = requireCanonicalSubject(bundle);
    const expected = rulers[cell.rubric];
    if (bundle.rubricRef === undefined || assetRefIdentity(bundle.rubricRef) !== assetRefIdentity(expected)) {
      throw new EvolutionProgramEvaluationError(
        'invalid_request',
        `the ${cell.rubric}/${cell.candidate} rejudge cell was not scored with the ${cell.rubric} rubric`,
      );
    }
    if (bundle.frozenCohortRef === undefined || refIdentity(bundle.frozenCohortRef) !== refIdentity(frozenCohortRef)) {
      throw new EvolutionProgramEvaluationError(
        'invalid_request',
        `the ${cell.rubric}/${cell.candidate} rejudge cell was not scored on the frozen cohort`,
      );
    }
    cells.push({ rubric: cell.rubric, candidate: cell.candidate, resultRef });
  }
  return { frozenCohortRef, cells };
}

/**
 * The F267 decision proof this Cycle's measurement was read out of, from the Program's own lineage.
 * Reset on Cycle rotation and on a new round for the same reason the diagnosis is: last round's
 * evidence must never authorise this round's change.
 */
export function landedDecisionProofRef(
  events: readonly EvolutionProgramEventEnvelopeV1[],
): OwnerTruthRefV1 | undefined {
  let landed: OwnerTruthRefV1 | undefined;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === 'decision_recorded' || event.type === 'evaluation_triggered') landed = undefined;
    else if (event.type === 'measurement_linked') {
      landed = event.evidenceRefs.find((ref) => ref.ownerStateRef.startsWith('measurement-proof:'));
    }
  }
  return landed;
}

/** The measurement result this Cycle actually landed on, or null if this round has none yet. */
function landedMeasurementRef(events: readonly EvolutionProgramEventEnvelopeV1[]): OwnerTruthRefV1 | null {
  let landed: OwnerTruthRefV1 | null = null;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === 'decision_recorded' || event.type === 'evaluation_triggered') landed = null;
    else if (event.type === 'measurement_linked') landed = event.measurementResultRef;
  }
  return landed;
}

/** Records F267's measurement verdict; an insufficient bundle routes the Cycle back to observing. */
export function linkEvolutionProgramMeasurement(
  input: ProgramMeasurementLinkInput,
  deps: ProgramEvaluationDependencies,
): Promise<EvolutionProgramServiceResult> {
  return guardedAppend(
    input,
    deps,
    async (_events, projection) =>
      assessMeasurementJoin(measurementJoinInput(input, await requireOwnerBundle(input, deps, projection))).event,
  );
}

/** Runs the four-layer diagnosis and appends it as the Program's own durable snapshot. */
export function linkEvolutionProgramAttribution(
  input: ProgramAttributionLinkInput,
  deps: ProgramEvaluationDependencies,
): Promise<EvolutionProgramServiceResult> {
  return guardedAppend(input, deps, async (events, projection) => {
    // The diagnosis must be about the measurement this Cycle actually landed on. Without this a
    // caller could measure result A and then attribute over evidence from result B.
    //
    // The comparison is result-ref against result-ref. The caller submits a PROOF ref, which is a
    // different identity from the measurement result the proof is about, so resolving the owner
    // first is what makes this check meaningful rather than an unconditional mismatch.
    const landed = landedMeasurementRef(events);
    if (landed === null) {
      throw new EvolutionProgramEvaluationError(
        'invalid_request',
        'this Cycle has no landed measurement to attribute over',
      );
    }
    requireLinkedEvidence(input.candidates, projection);
    const bundle = await requireOwnerBundle(input, deps, projection);
    if (refIdentity(landed) !== refIdentity(requireCanonicalSubject(bundle).resultRef)) {
      throw new EvolutionProgramEvaluationError(
        'invalid_request',
        'the attribution must reference the measurement result this Cycle landed on',
      );
    }
    const measurement = assessMeasurementJoin(measurementJoinInput(input, bundle));
    // Discrimination is the owner's declaration, not the caller's.
    const discriminating = new Set(bundle.discriminatingLayers ?? []);
    const candidates = input.candidates.map((entry) => ({
      ...entry,
      discriminating: discriminating.has(entry.layer),
    }));
    // Both rulers are owner truth: the current one from this round's proof, the previous one from
    // what the Program itself recorded last round.
    const currentRubricRef = bundle.rubricRef;
    if (currentRubricRef === undefined) {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        'the owner published no rubric for this measurement; comparability cannot be established',
      );
    }
    const frozenCohortRef = bundle.frozenCohortRef;
    if (frozenCohortRef === undefined) {
      throw new EvolutionProgramEvaluationError(
        'owner_evidence_unavailable',
        'the owner published no frozen cohort for this measurement; a rejudge has nothing to be frozen on',
      );
    }
    const rulers = { previous: previousRubricRef(events) ?? currentRubricRef, current: currentRubricRef };
    const rejudge = await resolveRejudge(input, deps, rulers, frozenCohortRef);
    // A rebuilt baseline is a measurement result like any other, so it is named by its proof and
    // resolved by the owner rather than accepted as a ref the caller wrote down.
    const baselineRebuildRef =
      input.baselineRebuildProofRef === undefined
        ? undefined
        : requireCanonicalSubject(
            await requireOwnerBundle({ ...input, evidenceProofRef: input.baselineRebuildProofRef }, deps, undefined),
          ).resultRef;
    const comparability = assessRubricComparability({
      frozenCohortRef,
      previousRubricRef: rulers.previous,
      currentRubricRef: rulers.current,
      ...(rejudge === undefined ? {} : { rejudge }),
      ...(baselineRebuildRef === undefined ? {} : { baselineRebuildRef }),
    });
    return resolveAttribution({
      programId: input.programId,
      // The Cycle is the Program's, not the caller's — a caller-supplied cycle could fabricate a round.
      cycle: projection.program.cycle,
      measurement,
      comparability,
      candidates,
    }).event;
  });
}

/**
 * The only door into Change Review. A blocked gate never becomes an Approval — it appends the
 * zero-approval `observe` / `insufficient` event instead, carrying the blocker codes and their
 * owners so the surface can explain itself after a restart.
 */
export function linkEvolutionProgramIntervention(
  input: ProgramInterventionLinkInput,
  deps: ProgramEvaluationDependencies,
): Promise<EvolutionProgramServiceResult> {
  return guardedAppend(input, deps, async (_events, projection) => {
    // Every element of the card comes from the owner's structured publication. A legacy free-text
    // card produces nothing here, so it can describe a plan but can never open Change Review.
    const bundle = await requireOwnerBundle({ ...input, evidenceProofRef: input.decisionProofRef }, deps, projection);
    const verdict = evaluateInterventionGate({
      attribution: input.attribution,
      ...(bundle.interventionCard === undefined ? {} : { card: bundle.interventionCard }),
      // What is being changed is what this Program is about — its own target, not a caller's choice.
      interventionLayerRef: projection.program.objectRef,
      // The receipt is the owner's too. F311 minting it would be authorising its own change, and
      // the gate rightly refuses self-certified authorisation.
      ...(bundle.gateReceiptRef === undefined ? {} : { gateReceiptRef: bundle.gateReceiptRef }),
    });
    if (verdict.status === 'ready' && verdict.event) return verdict.event;
    const fallback = verdict.fallbackEvent;
    if (!fallback) throw new Error('a blocked intervention gate must produce a zero-approval fallback');
    return {
      type: 'observe_or_insufficient_recorded',
      result: fallback.result,
      autoRecheckRef: input.autoRecheckRef,
      gateBlockers: fallback.gateBlockers,
    };
  });
}
