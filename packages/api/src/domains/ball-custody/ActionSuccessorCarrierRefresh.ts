import {
  type ActionSuccessorAdmissionInput,
  type ActionSuccessorFence,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import { canonicalizeActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease, RefreshHandledActionSuccessorResult } from './action-successor-state-machine.js';

export type ActionSuccessorCarrierRefreshRejection = Exclude<
  RefreshHandledActionSuccessorResult['outcome'],
  'refreshed' | 'stale_generation' | 'stale_revision'
>;

export type ActionSuccessorCarrierRefreshResult =
  | { outcome: 'refreshed'; lease: ActionSuccessorLease; fence: ActionSuccessorFence }
  /** Another transition changed the lease first (a concurrent refresh, or any revision bump). */
  | { outcome: 'superseded'; lease: ActionSuccessorLease }
  | { outcome: 'subject_terminal'; lease: ActionSuccessorLease }
  | { outcome: 'rejected'; reason: ActionSuccessorCarrierRefreshRejection; lease: ActionSuccessorLease };

type IncomingPredicate =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly reason: ActionSuccessorCarrierRefreshRejection };

/** The incoming predicate must be the exact one stored on the lease; anything unreadable is a mismatch. */
function incomingPredicate(lease: ActionSuccessorLease, input: ActionSuccessorAdmissionInput): IncomingPredicate {
  if (!input.action.terminalPredicate) return { ok: false, reason: 'terminal_predicate_mismatch' };
  try {
    const incoming = canonicalizeActionTerminalPredicate({
      actionFamily: input.action.actionFamily,
      subjectRef: input.action.subjectRef,
      predicate: input.action.terminalPredicate,
    });
    return incoming.subjectRef === lease.subjectRef
      ? { ok: true, digest: incoming.digest }
      : { ok: false, reason: 'authority_mismatch' };
  } catch {
    return { ok: false, reason: 'terminal_predicate_mismatch' };
  }
}

/**
 * Commit the carrier refresh for a request whose carrier was already recognised as refreshable.
 *
 * `lease` is the exact lease that recognition read; the store re-checks its generation and revision
 * at commit, so nothing recognised earlier is trusted past that point. Of two concurrent refreshes of
 * the same observed lease exactly one commits; the loser sees the advanced lease and is `superseded`.
 */
export async function refreshHandledActionSuccessorCarrier(input: {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'refreshHandledCarrier'>;
  lease: ActionSuccessorLease;
  admissionInput: ActionSuccessorAdmissionInput;
}): Promise<ActionSuccessorCarrierRefreshResult> {
  const { lease, admissionInput } = input;
  const predicate = incomingPredicate(lease, admissionInput);
  if (!predicate.ok) return { outcome: 'rejected', reason: predicate.reason, lease };

  const result = await input.leaseStore.refreshHandledCarrier(lease.leaseId, {
    expectedGeneration: lease.generation,
    expectedRevision: lease.revision,
    predecessorCatId: admissionInput.actorCatId,
    predecessorThreadId: admissionInput.sourceThreadId,
    holderCatIds: admissionInput.holderCatIds,
    holderThreadId: admissionInput.targetThreadId,
    mode: admissionInput.action.mode,
    parallelIntent: admissionInput.action.parallelIntent,
    terminalPredicateDigest: predicate.digest,
    dispatchId: admissionInput.dispatchId,
    evidenceRef: admissionInput.evidenceRef,
    now: admissionInput.now,
  });

  switch (result.outcome) {
    case 'refreshed':
      return {
        outcome: 'refreshed',
        lease: result.lease,
        fence: buildActionSuccessorFence(result.lease, admissionInput.dispatchId),
      };
    case 'stale_generation':
    case 'stale_revision':
      return { outcome: 'superseded', lease: result.lease };
    case 'subject_terminal':
      return { outcome: 'subject_terminal', lease: result.lease };
    default:
      return { outcome: 'rejected', reason: result.outcome, lease: result.lease };
  }
}
