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
  readonly kind: 'canonical_owner' | 'approved_delegate';
  readonly delegateEvidenceRef?: string;
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
    const delegateMatch =
      freshness.approvedDelegates?.some(
        (d) =>
          input.holderCatIds.length === 1 && d.catId === input.holderCatIds[0] && d.threadId === input.targetThreadId,
      ) ?? false;

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
    const matchedDelegate = freshness.approvedDelegates?.find(
      (d) =>
        input.holderCatIds.length === 1 && d.catId === input.holderCatIds[0] && d.threadId === input.targetThreadId,
    );
    if (matchedDelegate) {
      return { kind: 'approved_delegate', delegateEvidenceRef: matchedDelegate.evidenceRef };
    }
  }
  return { kind: 'canonical_owner' };
}
