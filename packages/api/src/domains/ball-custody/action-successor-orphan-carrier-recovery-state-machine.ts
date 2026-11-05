import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export interface ActionSuccessorOrphanCarrierRecoveryTransition {
  readonly kind: 'orphan_carrier_recovery';
  readonly fromGeneration: number;
  readonly toGeneration: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly sourceMessageId: string;
  readonly predecessorCatId: string;
  readonly predecessorThreadId: string;
  readonly holderCatId: string;
  readonly holderThreadId: string;
  readonly fromDispatchId: string;
  readonly toDispatchId: string;
  readonly evidenceRef: string;
  readonly at: number;
}

export interface RecoverOrphanActionSuccessorCarrierInput {
  readonly expectedGeneration: number;
  readonly expectedRevision: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly sourceMessageId: string;
  readonly predecessorCatId: string;
  readonly predecessorThreadId: string;
  readonly holderCatId: string;
  readonly holderThreadId: string;
  readonly dispatchId: string;
  readonly evidenceRef: string;
  readonly now: number;
}

export type RecoverOrphanActionSuccessorCarrierResult =
  | { readonly outcome: 'recovered'; readonly lease: ActionSuccessorLease }
  | {
      readonly outcome:
        | 'stale_generation'
        | 'stale_revision'
        | 'lease_not_active'
        | 'not_task_implement'
        | 'not_single_direct_carrier'
        | 'holder_outcome_present'
        | 'completion_candidate_present'
        | 'current_return_present'
        | 'dispatch_state_present'
        | 'authority_mismatch'
        | 'dispatch_unchanged';
      readonly lease: ActionSuccessorLease;
    };

type RecoveryRejection = Exclude<RecoverOrphanActionSuccessorCarrierResult['outcome'], 'recovered'>;

export function currentOrphanCarrierRecovery(
  lease: Pick<ActionSuccessorLease, 'generation' | 'dispatchId' | 'orphanCarrierRecoveryTransitions'>,
): ActionSuccessorOrphanCarrierRecoveryTransition | null {
  const transition = lease.orphanCarrierRecoveryTransitions?.at(-1);
  return transition && transition.toGeneration === lease.generation && transition.toDispatchId === lease.dispatchId
    ? transition
    : null;
}

export function recoverOrphanActionSuccessorCarrier(
  current: ActionSuccessorLease,
  input: RecoverOrphanActionSuccessorCarrierInput,
): RecoverOrphanActionSuccessorCarrierResult {
  if (input.expectedGeneration !== current.generation) return { outcome: 'stale_generation', lease: current };
  if (input.expectedRevision !== current.revision) return { outcome: 'stale_revision', lease: current };
  if (current.status !== 'active') return { outcome: 'lease_not_active', lease: current };

  const taskId = requireNonEmpty(input.taskId, 'taskId');
  const leaseBlocker = orphanRecoveryLeaseBlocker(current, taskId);
  if (leaseBlocker) return { outcome: leaseBlocker, lease: current };

  const holderCatId = requireNonEmpty(input.holderCatId, 'holderCatId');
  const holderThreadId = requireNonEmpty(input.holderThreadId, 'holderThreadId');
  const predecessorCatId = requireNonEmpty(input.predecessorCatId, 'predecessorCatId');
  const predecessorThreadId = requireNonEmpty(input.predecessorThreadId, 'predecessorThreadId');
  if (!sameRecoveryRoute(current, { holderCatId, holderThreadId, predecessorCatId, predecessorThreadId }))
    return { outcome: 'authority_mismatch', lease: current };

  const dispatchId = requireNonEmpty(input.dispatchId, 'dispatchId');
  if (dispatchId === current.dispatchId) return { outcome: 'dispatch_unchanged', lease: current };
  const expectedPrefix = predecessorThreadId === holderThreadId ? 'post:' : 'cross-post:';
  if (!current.dispatchId.startsWith(expectedPrefix) || !dispatchId.startsWith(expectedPrefix)) {
    return { outcome: 'authority_mismatch', lease: current };
  }
  if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision <= 0) {
    throw new Error('taskRevision must be a positive integer');
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error('now must be a non-negative integer');
  const sourceMessageId = requireNonEmpty(input.sourceMessageId, 'sourceMessageId');
  const evidenceRef = requireNonEmpty(input.evidenceRef, 'evidenceRef');
  const nextGeneration = current.generation + 1;
  const transition: ActionSuccessorOrphanCarrierRecoveryTransition = {
    kind: 'orphan_carrier_recovery',
    fromGeneration: current.generation,
    toGeneration: nextGeneration,
    taskId,
    taskRevision: input.taskRevision,
    sourceMessageId,
    predecessorCatId,
    predecessorThreadId,
    holderCatId,
    holderThreadId,
    fromDispatchId: current.dispatchId,
    toDispatchId: dispatchId,
    evidenceRef,
    at: input.now,
  };
  const recoveryEvidenceRef = `orphan-carrier-recovery:${current.leaseId}:g${nextGeneration}:task:${taskId}:r${input.taskRevision}:message:${sourceMessageId}`;
  return {
    outcome: 'recovered',
    lease: {
      ...current,
      dispatchId,
      issuerStandingEvidenceRef: evidenceRef,
      generation: nextGeneration,
      evidenceRefs: [
        ...new Set([...current.evidenceRefs, current.issuerStandingEvidenceRef, evidenceRef, recoveryEvidenceRef]),
      ],
      orphanCarrierRecoveryTransitions: [...(current.orphanCarrierRecoveryTransitions ?? []), transition],
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function orphanRecoveryLeaseBlocker(current: ActionSuccessorLease, taskId: string): RecoveryRejection | undefined {
  const subjectRef = `subject:task:${taskId}`;
  if (
    current.subjectRef !== subjectRef ||
    current.actionFamily !== 'implement' ||
    current.successorSlot !== 'implementer' ||
    current.terminalPredicate?.kind !== 'task_done' ||
    current.terminalPredicate.subjectRef !== subjectRef
  )
    return 'not_task_implement';
  if (
    current.mode !== 'single' ||
    current.claimOrigin !== 'structured_transfer' ||
    current.holderCatIds.length !== 1 ||
    !current.predecessorCatId ||
    !current.predecessorThreadId
  )
    return 'not_single_direct_carrier';
  if (Object.keys(current.holderOutcomes).length > 0) return 'holder_outcome_present';
  if (Object.keys(current.completionCandidates).length > 0) return 'completion_candidate_present';
  if (
    current.returnDeliveryState !== undefined ||
    current.returnDeliveryEvidenceRef !== undefined ||
    current.returnDeliverySlaUntil !== undefined
  )
    return 'current_return_present';
  if (
    current.dispatchDeliveryState !== undefined ||
    current.dispatchDeliveryReservation !== undefined ||
    current.dispatchDeliveredMessageId !== undefined ||
    current.dispatchFailureReason !== undefined
  )
    return 'dispatch_state_present';
  return undefined;
}

function sameRecoveryRoute(
  current: ActionSuccessorLease,
  input: Pick<
    RecoverOrphanActionSuccessorCarrierInput,
    'holderCatId' | 'holderThreadId' | 'predecessorCatId' | 'predecessorThreadId'
  >,
): boolean {
  return (
    current.holderCatIds[0] === input.holderCatId &&
    current.holderThreadId === input.holderThreadId &&
    current.predecessorCatId === input.predecessorCatId &&
    current.predecessorThreadId === input.predecessorThreadId
  );
}
