/**
 * Standing checks for action successor admission.
 *
 * Extracted from ActionSuccessorAdmissionService to keep file sizes under
 * the 350-line hard limit. These are pure functions + types — no service
 * state, no I/O.
 *
 * F167 × F322: Approved-child delegation allows operator-approved delegates
 * (catId, threadId pairs) to pass standing checks that would otherwise
 * fail for non-canonical owners. Both catId AND threadId must match
 * exactly; partial matches are not suppressed. Tenant is never relaxed.
 */

import type { ActionFreshnessResolution } from './ActionSubjectTruthResolver.js';
import type { ActionSuccessorAdmissionInput } from './ActionSuccessorAdmissionContract.js';
import {
  boundGenerationHasTerminalDelegateOutcome,
  currentDelegateLineageGenerationHasExactEntry,
  delegateLineageHasProposalAnchor,
  delegateLineageHistoryMatchesCanonicalOwner,
} from './action-successor-delegate-lineage.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export type ActionSuccessorStandingMismatchDimension = 'owner' | 'target_thread' | 'tenant';

export class ActionSuccessorStandingError extends Error {
  constructor(
    readonly status: 'mismatch' | 'insufficient',
    readonly reason: string,
    readonly mismatchDimensions: readonly ActionSuccessorStandingMismatchDimension[] = [],
  ) {
    super(`action successor freshness rejected: ${status}: ${reason}`);
    this.name = 'ActionSuccessorStandingError';
  }
}

export type ActionSuccessorStandingSnapshot = Pick<
  ActionSuccessorAdmissionInput,
  'holderCatIds' | 'targetThreadId' | 'tenantScope'
>;

/**
 * The matched standing authority that resolved this standing check.
 * When an approved delegate suppresses owner/thread mismatches, the
 * delegate's server-resolved evidenceRef is returned — callers must
 * propagate it into the lease for auditability.
 */
export interface MatchedStandingAuthority {
  readonly kind:
    | 'canonical_owner'
    | 'approved_delegate'
    | 'returned_delegate_successor'
    | 'human_reassigned_delegate_successor';
  readonly delegateEvidenceRef?: string;
}

type ReturnedDelegateSuccessorInput = ActionSuccessorStandingSnapshot &
  Pick<ActionSuccessorAdmissionInput, 'actorCatId' | 'sourceThreadId' | 'now' | 'action' | 'humanReassignmentEvidence'>;

function findApprovedDelegate(
  input: ActionSuccessorStandingSnapshot,
  freshness: Extract<ActionFreshnessResolution, { status: 'verified' }>,
) {
  if (input.holderCatIds.length !== 1) return undefined;
  const holderCatId = input.holderCatIds[0];
  return freshness.approvedDelegates?.find(
    (delegate) => delegate.catId === holderCatId && delegate.threadId === input.targetThreadId,
  );
}

export function actionSuccessorStandingMismatchDimensions(
  input: ActionSuccessorStandingSnapshot,
  freshness: Extract<ActionFreshnessResolution, { status: 'verified' }>,
): ActionSuccessorStandingMismatchDimension[] {
  const mismatchDimensions: ActionSuccessorStandingMismatchDimension[] = [];
  const ownerMismatch =
    freshness.ownerCatId !== undefined &&
    (input.holderCatIds.length !== 1 || input.holderCatIds[0] !== freshness.ownerCatId);
  const threadMismatch = freshness.holderThreadId !== undefined && input.targetThreadId !== freshness.holderThreadId;

  if (ownerMismatch || threadMismatch) {
    // F167 × F322: check if the incoming (catId, threadId) pair is a
    // operator-approved delegate. Both catId AND threadId must match an entry
    // exactly; partial matches are not suppressed.
    const delegateMatch = findApprovedDelegate(input, freshness) !== undefined;

    if (!delegateMatch) {
      if (ownerMismatch) mismatchDimensions.push('owner');
      if (threadMismatch) mismatchDimensions.push('target_thread');
    }
  }

  if (freshness.tenantScope !== undefined && input.tenantScope !== freshness.tenantScope) {
    mismatchDimensions.push('tenant');
  }
  return mismatchDimensions;
}

export function assertActionSuccessorStanding(
  input: ActionSuccessorStandingSnapshot,
  freshness: Extract<ActionFreshnessResolution, { status: 'verified' }>,
): MatchedStandingAuthority {
  const mismatchDimensions = actionSuccessorStandingMismatchDimensions(input, freshness);
  if (mismatchDimensions.length > 0) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'task standing does not match the persisted owner, tenant, and task thread',
      mismatchDimensions,
    );
  }

  // Determine if standing was granted via an approved delegate.
  // If so, return the delegate's server-resolved evidenceRef for audit.
  const ownerMismatch =
    freshness.ownerCatId !== undefined &&
    (input.holderCatIds.length !== 1 || input.holderCatIds[0] !== freshness.ownerCatId);
  const threadMismatch = freshness.holderThreadId !== undefined && input.targetThreadId !== freshness.holderThreadId;

  if (ownerMismatch || threadMismatch) {
    const matchedDelegate = findApprovedDelegate(input, freshness);
    if (matchedDelegate) {
      return { kind: 'approved_delegate', delegateEvidenceRef: matchedDelegate.evidenceRef };
    }
  }
  return { kind: 'canonical_owner' };
}

/**
 * A proposal's preferredCats authorize the first writer, not a permanent veto
 * over the Task owner's later same-child recovery. A returned generation may
 * also move to another child only when the incoming cat/thread pair has its own
 * independently approved proposal for the same current Task and scope.
 *
 * The old delegate match is deliberately re-resolved from current Task truth:
 * proposal withdrawal/tampering, owner drift, tenant drift, child drift, or any
 * of the five development-scope fields changing removes the match and keeps the
 * successor fail-closed. The returned child (or current active child segment)
 * must retain a current proposal anchor in both lease evidence and durable
 * holder/return/replacement lineage; either one alone grants no authority.
 */
export function assertDelegateLineageSuccessorStanding(
  current: ActionSuccessorLease,
  input: ReturnedDelegateSuccessorInput,
  freshness: Extract<ActionFreshnessResolution, { status: 'verified' }>,
): MatchedStandingAuthority {
  if (
    freshness.ownerCatId !== input.actorCatId ||
    freshness.holderThreadId !== input.sourceThreadId ||
    freshness.tenantScope !== input.tenantScope
  ) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'returned delegate successor must originate from the canonical Task owner route',
      ['owner', 'target_thread', 'tenant'],
    );
  }

  const ownerRoute = { ownerCatId: input.actorCatId, ownerThreadId: input.sourceThreadId };
  const transition = current.returnTransitions.at(-1);
  if (!transition?.rejectingThreadId && current.generation === 1) {
    return assertInitialHumanReassignmentStanding(current, input, freshness, ownerRoute);
  }
  if (!delegateLineageHistoryMatchesCanonicalOwner(current, ownerRoute)) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'returned delegate lineage must remain on the canonical owner route',
      ['owner', 'target_thread'],
    );
  }

  const returnedChildThreadId = transition?.rejectingThreadId;
  const isReturnedGeneration =
    returnedChildThreadId !== undefined &&
    transition?.toGeneration === current.generation &&
    current.holderCatIds.length === 1 &&
    current.holderCatIds[0] === transition?.predecessorCatId &&
    current.holderThreadId === transition?.predecessorThreadId;
  const currentChildThreadId = isReturnedGeneration ? returnedChildThreadId : current.holderThreadId;
  const currentChildRoute = { ...ownerRoute, childThreadId: currentChildThreadId };
  if (!isReturnedGeneration && !currentDelegateLineageGenerationHasExactEntry(current, currentChildRoute)) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'the active delegate has no exact entry edge in the canonical current-child lineage segment',
      ['owner', 'target_thread'],
    );
  }

  const currentChildDelegate = freshness.approvedDelegates?.find(
    (delegate) => delegate.threadId === currentChildThreadId && delegateLineageHasProposalAnchor(current, delegate),
  );
  if (!currentChildDelegate) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'the returned execution child no longer has current Task, scope, tenant, and proposal standing',
      ['owner', 'target_thread'],
    );
  }
  if (input.holderCatIds.length !== 1 || !input.holderCatIds[0]?.trim()) {
    throw new ActionSuccessorStandingError('mismatch', 'returned delegate successor must name one holder', ['owner']);
  }
  if (input.targetThreadId === currentChildThreadId) {
    return { kind: 'returned_delegate_successor', delegateEvidenceRef: currentChildDelegate.evidenceRef };
  }

  const targetDelegate = findApprovedDelegate(input, freshness);
  if (!targetDelegate) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'moving a returned successor to another child requires an exact independently approved cat and child pair',
      ['owner', 'target_thread'],
    );
  }
  return { kind: 'returned_delegate_successor', delegateEvidenceRef: targetDelegate.evidenceRef };
}

function assertInitialHumanReassignmentStanding(
  current: ActionSuccessorLease,
  input: ReturnedDelegateSuccessorInput,
  freshness: Extract<ActionFreshnessResolution, { status: 'verified' }>,
  ownerRoute: { ownerCatId: string; ownerThreadId: string },
): MatchedStandingAuthority {
  const proof = input.humanReassignmentEvidence;
  const expectedEvidenceRef = proof
    ? `human-reassignment:message:${proof.sourceMessageId}:${proof.sourceMessageRevision}`
    : undefined;
  if (
    current.generation !== 1 ||
    current.mode !== 'single' ||
    current.holderCatIds.length !== 1 ||
    current.predecessorCatId !== ownerRoute.ownerCatId ||
    current.predecessorThreadId !== ownerRoute.ownerThreadId ||
    input.targetThreadId !== current.holderThreadId ||
    input.holderCatIds.length !== 1 ||
    !input.holderCatIds[0]?.trim() ||
    !proof ||
    proof.userId !== input.tenantScope ||
    proof.threadId !== current.holderThreadId ||
    proof.authoredAt <= current.createdAt ||
    proof.authoredAt > input.now ||
    !/^sha256:[a-f0-9]{64}$/.test(proof.sourceMessageRevision) ||
    proof.evidenceRef !== expectedEvidenceRef ||
    input.action.groundingEvidenceRef !== `message:${proof.sourceMessageId}` ||
    !boundGenerationHasTerminalDelegateOutcome(
      current,
      current.generation,
      current.holderCatIds,
      current.holderThreadId,
    )
  ) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'initial delegate reassignment requires exact terminal custody and direct human grounding in the same child',
      ['owner', 'target_thread'],
    );
  }
  const initialDelegate = freshness.approvedDelegates?.find(
    (delegate) =>
      delegate.catId === current.holderCatIds[0] &&
      delegate.threadId === current.holderThreadId &&
      delegateLineageHasProposalAnchor(current, delegate),
  );
  if (!initialDelegate) {
    throw new ActionSuccessorStandingError(
      'mismatch',
      'the initial delegate no longer has current Task, scope, tenant, and proposal standing',
      ['owner', 'target_thread'],
    );
  }
  return { kind: 'human_reassigned_delegate_successor', delegateEvidenceRef: proof.evidenceRef };
}
