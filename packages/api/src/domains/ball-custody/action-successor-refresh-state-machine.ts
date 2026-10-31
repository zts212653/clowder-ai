import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export interface RefreshHandledActionSuccessorInput {
  /** CAS on the exact lease the carrier was classified against; both must still match at commit. */
  expectedGeneration: number;
  expectedRevision: number;
  /**
   * The incoming identity, re-asserted against the lease AT the authoritative transition. The
   * earlier carrier classification is a read; nothing it concluded is trusted here.
   */
  predecessorCatId: string;
  predecessorThreadId: string;
  holderCatIds: readonly string[];
  holderThreadId: string;
  mode: ActionSuccessorLease['mode'];
  parallelIntent?: string;
  terminalPredicateDigest: string;
  /** New dispatch identity: becomes the lease dispatchId and the replacement carrier's append identity. */
  dispatchId: string;
  /** Evidence of THIS request (`callback:<invocation>:<clientMessageId>`); the new issuer standing. */
  evidenceRef: string;
  now: number;
}

export type RefreshHandledActionSuccessorResult = {
  outcome:
    | 'refreshed'
    | 'stale_generation'
    | 'stale_revision'
    | 'lease_not_active'
    | 'not_direct_carrier'
    | 'holder_outcome_present'
    | 'completion_candidate_present'
    | 'return_present'
    | 'authority_mismatch'
    | 'terminal_predicate_mismatch'
    | 'dispatch_unchanged';
  lease: ActionSuccessorLease;
};

/**
 * Durable marker that a generation was produced by a carrier refresh. A same-request retry after a
 * crash reads it to find the replacement carrier's stable append identity again.
 */
export function carrierRefreshEvidenceRef(leaseId: string, generation: number): string {
  return `carrier-refresh:${leaseId}:g${generation}`;
}

export function isCarrierRefreshGeneration(
  lease: Pick<ActionSuccessorLease, 'leaseId' | 'generation' | 'evidenceRefs'>,
): boolean {
  return lease.evidenceRefs.includes(carrierRefreshEvidenceRef(lease.leaseId, lease.generation));
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

/** Direct carriers are minted `post:` (same thread) or `cross-post:` (different thread). */
function directDispatchPrefix(lease: ActionSuccessorLease): 'post:' | 'cross-post:' {
  return lease.predecessorThreadId === lease.holderThreadId ? 'post:' : 'cross-post:';
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

type RefreshOutcome = RefreshHandledActionSuccessorResult['outcome'];

/** What the lease itself says makes it unrefreshable, independent of who is asking. */
function leaseBlocker(current: ActionSuccessorLease): RefreshOutcome | undefined {
  if (current.status !== 'active') return 'lease_not_active';
  if (
    current.claimOrigin !== 'structured_transfer' ||
    current.dispatchDeliveryState !== undefined ||
    !current.terminalPredicate ||
    !current.predecessorCatId ||
    !current.predecessorThreadId
  ) {
    return 'not_direct_carrier';
  }
  if (Object.keys(current.holderOutcomes).length > 0) return 'holder_outcome_present';
  if (Object.keys(current.completionCandidates).length > 0) return 'completion_candidate_present';
  if (current.returnTransitions.length > 0 || current.returnDeliveryState !== undefined) return 'return_present';
  return undefined;
}

/** Whether the incoming request is exactly the authority already stored on the lease. */
function identityBlocker(
  current: ActionSuccessorLease,
  input: RefreshHandledActionSuccessorInput,
): RefreshOutcome | undefined {
  if (current.terminalPredicate?.digest !== input.terminalPredicateDigest) return 'terminal_predicate_mismatch';
  if (
    current.predecessorCatId !== input.predecessorCatId ||
    current.predecessorThreadId !== input.predecessorThreadId ||
    current.holderThreadId !== input.holderThreadId ||
    current.mode !== input.mode ||
    (current.parallelIntent?.trim() || undefined) !== (input.parallelIntent?.trim() || undefined) ||
    !sameMembers(current.holderCatIds, input.holderCatIds)
  ) {
    return 'authority_mismatch';
  }
  const prefix = directDispatchPrefix(current);
  if (!current.dispatchId.startsWith(prefix) || !input.dispatchId.startsWith(prefix)) return 'authority_mismatch';
  if (input.dispatchId === current.dispatchId) return 'dispatch_unchanged';
  return undefined;
}

/**
 * Hand the same active lease to the same holder again after its direct carrier was `handled`.
 *
 * The generation MUST advance. The carrier idempotency key is `action:<leaseId>:<generation>:<cat>`
 * and the Queue creates its InvocationRecord from it; the old record is `succeeded` (not replayable),
 * so an unchanged key is silently consumed as "Duplicate invocation" and no provider ever starts.
 *
 * This transition proves only what the lease itself can prove: the exact revision, an active
 * outcome-free direct lease, and the incoming identity. That the old carrier is `handled` and its
 * execution really ended is evidence outside the lease (message custody + InvocationRecord) and is
 * established by the caller before it asks for this transition; both facts are monotonic, so they
 * cannot be undone between that read and this commit.
 */
export function refreshHandledActionSuccessor(
  current: ActionSuccessorLease,
  input: RefreshHandledActionSuccessorInput,
): RefreshHandledActionSuccessorResult {
  const blocked: RefreshOutcome | undefined =
    input.expectedGeneration !== current.generation
      ? 'stale_generation'
      : input.expectedRevision !== current.revision
        ? 'stale_revision'
        : (leaseBlocker(current) ?? identityBlocker(current, input));
  if (blocked) return { outcome: blocked, lease: current };

  const evidenceRef = requireNonEmpty(input.evidenceRef, 'evidenceRef');
  return {
    outcome: 'refreshed',
    lease: {
      ...current,
      dispatchId: input.dispatchId,
      issuerStandingEvidenceRef: evidenceRef,
      evidenceRefs: [
        ...new Set([
          ...current.evidenceRefs,
          current.issuerStandingEvidenceRef,
          evidenceRef,
          carrierRefreshEvidenceRef(current.leaseId, current.generation + 1),
        ]),
      ],
      generation: current.generation + 1,
      revision: current.revision + 1,
      updatedAt: input.now,
    },
  };
}
