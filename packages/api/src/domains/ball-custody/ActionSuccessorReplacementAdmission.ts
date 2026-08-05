import { successorReplace } from '../../infrastructure/telemetry/instruments.js';
import type {
  ActionSuccessorAdmissionInput,
  ActionSuccessorAdmissionResult,
} from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import {
  type ActionSuccessorLease,
  isReturnedActionSuccessorHolderGeneration,
  type ReturnedActionSuccessorProof,
} from './action-successor-state-machine.js';

type ClaimOrigin = 'structured_transfer' | 'existing_standing';

type ReturnedReplacementResolution =
  | { kind: 'ordinary' }
  | { kind: 'proof_required' }
  | { kind: 'authorized'; proof: ReturnedActionSuccessorProof };

interface ReplacementAdmissionDeps {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'replace'>;
  resolveIssuerStanding(input: ActionSuccessorAdmissionInput, claimOrigin: ClaimOrigin): string;
  resolveVerifiedPredicate(input: ActionSuccessorAdmissionInput): Promise<{
    terminalPredicate: CanonicalActionTerminalPredicate;
    freshnessEvidenceRef: string;
  }>;
  admitted(
    outcome: 'replaced' | 'reattached',
    lease: ActionSuccessorLease,
    dispatchId: string,
  ): ActionSuccessorAdmissionResult;
  resolveTerminalCas(input: ActionSuccessorAdmissionInput): Promise<ActionSuccessorAdmissionResult>;
}

function resolveReturnedReplacement(
  current: ActionSuccessorLease,
  input: ActionSuccessorAdmissionInput,
  claimOrigin: ClaimOrigin,
): ReturnedReplacementResolution {
  if (!isReturnedActionSuccessorHolderGeneration(current)) return { kind: 'ordinary' };
  const transition = current.returnTransitions.at(-1);
  if (
    claimOrigin !== 'structured_transfer' ||
    !transition ||
    current.holderCatIds.length !== 1 ||
    current.holderCatIds[0] !== input.actorCatId ||
    current.holderThreadId !== input.sourceThreadId ||
    transition.predecessorCatId !== input.actorCatId ||
    transition.predecessorThreadId !== input.sourceThreadId
  ) {
    throw new Error('returned-holder replacement must originate from the exact returned holder route');
  }
  if (
    input.incomingActionLeaseRef?.leaseId === current.leaseId &&
    input.incomingActionLeaseRef.generation === current.generation
  ) {
    return {
      kind: 'authorized',
      proof: {
        kind: 'returned_fence',
        leaseId: input.incomingActionLeaseRef.leaseId,
        generation: input.incomingActionLeaseRef.generation,
      },
    };
  }
  if (current.returnDeliveryState === 'delivered' && current.returnDeliveryEvidenceRef) {
    return {
      kind: 'authorized',
      proof: { kind: 'return_delivery', evidenceRef: current.returnDeliveryEvidenceRef },
    };
  }
  return { kind: 'proof_required' };
}

function assertOrdinaryReplacementRoute(
  current: ActionSuccessorLease,
  input: ActionSuccessorAdmissionInput,
  claimOrigin: ClaimOrigin,
): void {
  if (claimOrigin === 'existing_standing') {
    if (current.holderThreadId !== input.sourceThreadId) {
      throw new Error('existing-standing replacement must originate from the persisted holder thread');
    }
    return;
  }
  if (current.predecessorCatId !== input.actorCatId || current.predecessorThreadId !== input.sourceThreadId) {
    throw new Error('replacement must originate from the persisted issuer route');
  }
}

export async function admitActionSuccessorReplacement(
  identityKey: string,
  input: ActionSuccessorAdmissionInput,
  deps: ReplacementAdmissionDeps,
): Promise<ActionSuccessorAdmissionResult> {
  const replacement = input.action.replace;
  if (!replacement) throw new Error('replacement metadata missing');
  const current = await deps.leaseStore.get(replacement.leaseId);
  if (!current) throw new Error(`replacement lease not found: ${replacement.leaseId}`);
  if (current.key !== identityKey) throw new Error('replacement lease identity mismatch');
  const claimOrigin = input.action.claimOrigin ?? 'structured_transfer';
  if (current.claimOrigin !== claimOrigin) {
    throw new Error('replacement claim origin must match the persisted lease');
  }
  const issuerStandingEvidenceRef = deps.resolveIssuerStanding(input, claimOrigin);
  const returnedReplacement = resolveReturnedReplacement(current, input, claimOrigin);
  if (returnedReplacement.kind === 'proof_required') {
    return { admit: false, outcome: 'return_proof_required', lease: current };
  }
  if (returnedReplacement.kind === 'ordinary') assertOrdinaryReplacementRoute(current, input, claimOrigin);
  const { terminalPredicate, freshnessEvidenceRef } = await deps.resolveVerifiedPredicate(input);
  const replacementInput = {
    expectedGeneration: replacement.expectedGeneration,
    holderCatIds: input.holderCatIds,
    holderThreadId: input.targetThreadId,
    dispatchId: input.dispatchId,
    terminalPredicate,
    evidenceRef: input.evidenceRef,
    now: input.now,
  };
  const result = await deps.leaseStore.replace(
    replacement.leaseId,
    claimOrigin === 'existing_standing'
      ? { ...replacementInput, claimOrigin, issuerStandingEvidenceRef }
      : {
          ...replacementInput,
          claimOrigin,
          predecessorCatId: input.actorCatId,
          predecessorThreadId: input.sourceThreadId,
          issuerStandingEvidenceRef,
          ...(returnedReplacement.kind === 'authorized'
            ? {
                returnedHolderCatId: input.actorCatId,
                returnedHolderThreadId: input.sourceThreadId,
                returnProof: returnedReplacement.proof,
                freshnessEvidenceRef,
              }
            : {}),
        },
  );
  if (result.outcome === 'replaced' || result.outcome === 'reattached') {
    successorReplace.add(1);
    return deps.admitted(result.outcome, result.lease, input.dispatchId);
  }
  if (result.outcome === 'subject_terminal') return deps.resolveTerminalCas(input);
  return { admit: false, outcome: result.outcome, lease: result.lease };
}
