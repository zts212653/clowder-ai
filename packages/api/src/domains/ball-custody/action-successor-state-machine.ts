import type { ActionSuccessorClaimOrigin, ActionSuccessorMode } from '@cat-cafe/shared';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionCompletionCandidateSnapshot } from './action-successor-completion-state-machine.js';
import {
  type ActionSuccessorIdentity,
  type ActionSuccessorIdentityInput,
  canonicalizeActionIdentity,
} from './action-successor-identity.js';
import type {
  ActionSuccessorReturnDeliveryState,
  ActionSuccessorReturnTransition,
} from './action-successor-return-state-machine.js';

export type {
  ActionSuccessorActionFamily,
  ActionSuccessorClaimOrigin,
  ActionSuccessorMode,
  ActionSuccessorSlot,
} from '@cat-cafe/shared';
export type {
  ActionSuccessorIdentity,
  ActionSuccessorIdentityErrorCode,
  ActionSuccessorIdentityInput,
} from './action-successor-identity.js';
export {
  ActionSuccessorIdentityError,
  canonicalizeActionIdentity,
  canonicalizeActionSubjectRef,
} from './action-successor-identity.js';

import { recordActionSuccessorOutcome } from './action-successor-outcome-state-machine.js';
export { recordActionSuccessorOutcome };
export type {
  ActionCompletionCandidateSnapshot,
  ActionCompletionTruthVerdict,
  ActionCompletionVerdict,
  ContinueActionSuccessorFreshRevisionInput,
  ContinueActionSuccessorFreshRevisionResult,
} from './action-successor-completion-state-machine.js';
export {
  commitActionCompletionVerdict,
  continueActionSuccessorFreshRevision,
  recordActionCompletionCandidate,
} from './action-successor-completion-state-machine.js';
export type {
  ReplaceActionSuccessorInput,
  ReplaceActionSuccessorResult,
} from './action-successor-replacement-state-machine.js';
export { replaceActionSuccessor } from './action-successor-replacement-state-machine.js';
export type {
  ActionSuccessorReturnDeliveryState,
  ActionSuccessorReturnTransition,
  MarkActionSuccessorReturnDeliveredResult,
  ReattachReturnedActionSuccessorResult,
  RecordActionSuccessorReturnDeliveryAttemptResult,
  ReturnActionSuccessorResult,
  ReturnedActionSuccessorProof,
} from './action-successor-return-state-machine.js';
export {
  ACTION_SUCCESSOR_RETURN_DELIVERY_SLA_MS,
  isActionSuccessorReturnReplay,
  isReturnedActionSuccessorHolderGeneration,
  markActionSuccessorReturnDelivered,
  reattachReturnedActionSuccessor,
  recordActionSuccessorReturnDeliveryAttempt,
  returnActionSuccessorToPredecessor,
} from './action-successor-return-state-machine.js';

export type ActionSuccessorHolderOutcome = 'succeeded' | 'failed' | 'canceled' | 'unavailable' | 'rejected_ownership';
export type ActionSuccessorLeaseStatus = 'active' | 'replaceable' | 'completed';
export type ActionSuccessorDispatchDeliveryState = 'pending' | 'delivered' | 'failed';
export type ActionSuccessorDispatchFailureReason =
  | 'proposal_missing'
  | 'proposal_not_approved'
  | 'proposal_fence_mismatch'
  | 'carrier_source_conflict'
  | 'carrier_receipt_conflict';

interface ActionSuccessorLeaseBase extends ActionSuccessorIdentity {
  leaseId: string;
  mode: ActionSuccessorMode;
  holderCatIds: string[];
  parallelIntent?: string;
  dispatchId: string;
  claimOrigin: ActionSuccessorClaimOrigin;
  holderThreadId: string;
  predecessorCatId?: string;
  predecessorThreadId?: string;
  issuerStandingEvidenceRef: string;
  generation: number;
  status: ActionSuccessorLeaseStatus;
  holderOutcomes: Record<string, { outcome: ActionSuccessorHolderOutcome; evidenceRef: string; at: number }>;
  completionCandidates: Record<string, ActionCompletionCandidateSnapshot>;
  evidenceRefs: string[];
  returnDeliveryState?: ActionSuccessorReturnDeliveryState;
  returnDeliveryEvidenceRef?: string;
  returnDeliveryAttemptCount?: number;
  returnDeliverySlaUntil?: number;
  returnDeliveryLastAttemptAt?: number;
  returnDeliveryOverdueObservedAt?: number;
  returnTransitions: ActionSuccessorReturnTransition[];
  /** Initial approved carrier transport; custody already exists while pending. */
  dispatchDeliveryState?: ActionSuccessorDispatchDeliveryState;
  dispatchDeliveryAttemptCount?: number;
  dispatchDeliveryLastAttemptAt?: number;
  dispatchDeliveredMessageId?: string;
  dispatchFailureReason?: ActionSuccessorDispatchFailureReason;
  dispatchFailureEvidenceRef?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type ActionSuccessorTerminalPredicateState =
  | { readonly kind: 'predicate_backed' }
  | { readonly kind: 'legacy_predicate_absent' };

export type ActionSuccessorLease = ActionSuccessorLeaseBase &
  (
    | {
        terminalPredicateState: { readonly kind: 'predicate_backed' };
        terminalPredicate: CanonicalActionTerminalPredicate;
      }
    | {
        terminalPredicateState: { readonly kind: 'legacy_predicate_absent' };
        terminalPredicate?: undefined;
      }
  );

export interface ClaimActionSuccessorInput extends ActionSuccessorIdentityInput {
  leaseId: string;
  mode: ActionSuccessorMode;
  holderCatIds: string[];
  parallelIntent?: string;
  dispatchId: string;
  claimOrigin: ActionSuccessorClaimOrigin;
  holderThreadId: string;
  predecessorCatId?: string;
  predecessorThreadId?: string;
  issuerStandingEvidenceRef: string;
  evidenceRefs: string[];
  terminalPredicate: CanonicalActionTerminalPredicate;
  now: number;
}

export type ClaimActionSuccessorResult = {
  outcome: 'claimed' | 'replayed' | 'replay_mismatch' | 'safe_wait';
  lease: ActionSuccessorLease;
};

function normalizeHolders(mode: ActionSuccessorMode, holderCatIds: string[], parallelIntent?: string): string[] {
  const holders = [...new Set(holderCatIds.map((catId) => catId.trim()).filter(Boolean))];
  if (holders.length !== holderCatIds.length) throw new Error('holderCatIds must be unique and non-empty');
  if (mode === 'single' && holders.length !== 1) throw new Error('single mode requires exactly one holder');
  if (mode === 'parallel' && holders.length < 2) throw new Error('parallel mode requires at least two holders');
  if (mode === 'parallel' && !parallelIntent?.trim()) {
    throw new Error('parallel mode requires explicit parallel intent');
  }
  return holders;
}

function isSameReplayPayload(
  current: ActionSuccessorLease,
  input: Pick<
    ClaimActionSuccessorInput,
    | 'mode'
    | 'parallelIntent'
    | 'claimOrigin'
    | 'holderThreadId'
    | 'predecessorCatId'
    | 'predecessorThreadId'
    | 'issuerStandingEvidenceRef'
    | 'terminalPredicate'
  >,
  holderCatIds: string[],
): boolean {
  if (current.mode !== input.mode) return false;
  if ((current.parallelIntent?.trim() || undefined) !== (input.parallelIntent?.trim() || undefined)) return false;
  if (current.claimOrigin !== input.claimOrigin) return false;
  if (current.holderThreadId !== input.holderThreadId.trim()) return false;
  if (current.predecessorCatId !== input.predecessorCatId?.trim()) return false;
  if (current.predecessorThreadId !== input.predecessorThreadId?.trim()) return false;
  if (current.issuerStandingEvidenceRef !== input.issuerStandingEvidenceRef.trim()) return false;
  if (current.terminalPredicate?.digest !== input.terminalPredicate?.digest) return false;
  if (current.holderCatIds.length !== holderCatIds.length) return false;
  const currentHolders = new Set(current.holderCatIds);
  return holderCatIds.every((catId) => currentHolders.has(catId));
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function normalizeClaimProvenance(input: ClaimActionSuccessorInput): {
  holderThreadId: string;
  predecessorCatId?: string;
  predecessorThreadId?: string;
  issuerStandingEvidenceRef: string;
} {
  const holderThreadId = requireNonEmpty(input.holderThreadId, 'holderThreadId');
  const issuerStandingEvidenceRef = requireNonEmpty(input.issuerStandingEvidenceRef, 'issuerStandingEvidenceRef');
  if (input.claimOrigin === 'existing_standing') {
    if (input.mode !== 'single') throw new Error('existing standing requires single mode');
    if (input.predecessorCatId || input.predecessorThreadId) {
      throw new Error('existing standing cannot declare a predecessor route');
    }
    return { holderThreadId, issuerStandingEvidenceRef };
  }
  const predecessorCatId = input.predecessorCatId?.trim();
  const predecessorThreadId = input.predecessorThreadId?.trim();
  if (!predecessorCatId || !predecessorThreadId || !issuerStandingEvidenceRef) {
    throw new Error('structured transfer requires predecessor route and issuer standing evidence');
  }
  return { holderThreadId, predecessorCatId, predecessorThreadId, issuerStandingEvidenceRef };
}

export function claimActionSuccessor(
  current: ActionSuccessorLease | null,
  input: ClaimActionSuccessorInput,
): ClaimActionSuccessorResult {
  if (!input.terminalPredicate) {
    throw new Error('terminal predicate is required for a new action successor generation');
  }
  const identity = canonicalizeActionIdentity(input);
  const holderCatIds = normalizeHolders(input.mode, input.holderCatIds, input.parallelIntent);
  const provenance = normalizeClaimProvenance(input);
  if (current) {
    if (current.key !== identity.key) throw new Error('action successor identity mismatch');
    if (current.dispatchId === input.dispatchId) {
      return {
        outcome: isSameReplayPayload(current, input, holderCatIds) ? 'replayed' : 'replay_mismatch',
        lease: current,
      };
    }
    return { outcome: 'safe_wait', lease: current };
  }
  const lease: ActionSuccessorLease = {
    ...identity,
    leaseId: input.leaseId,
    mode: input.mode,
    holderCatIds,
    ...(input.parallelIntent?.trim() ? { parallelIntent: input.parallelIntent.trim() } : {}),
    dispatchId: input.dispatchId,
    claimOrigin: input.claimOrigin,
    ...provenance,
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: input.terminalPredicate,
    completionCandidates: {},
    evidenceRefs: [...new Set([...input.evidenceRefs, provenance.issuerStandingEvidenceRef])],
    returnTransitions: [],
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { outcome: 'claimed', lease };
}

export type ActionSuccessorPreflightResult =
  | { ok: true; reason: 'active' }
  | { ok: false; reason: 'subject_terminal' | 'stale_generation' | 'lease_not_active' | 'predicate_mismatch' };

export function preflightActionSuccessor(
  current: ActionSuccessorLease,
  input: { generation: number; subjectTerminal: boolean; terminalPredicateDigest?: string },
): ActionSuccessorPreflightResult {
  if (input.subjectTerminal) return { ok: false, reason: 'subject_terminal' };
  if (input.generation !== current.generation) return { ok: false, reason: 'stale_generation' };
  if (input.terminalPredicateDigest && current.terminalPredicate?.digest !== input.terminalPredicateDigest) {
    return { ok: false, reason: 'predicate_mismatch' };
  }
  if (current.status !== 'active') return { ok: false, reason: 'lease_not_active' };
  return { ok: true, reason: 'active' };
}
