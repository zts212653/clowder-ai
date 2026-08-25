import type {
  RecoverActiveLocalReviewVerdictInput,
  RecoverActiveLocalReviewVerdictResult,
} from './action-successor-local-review-recovery-state-machine.js';
import type {
  ActionCompletionVerdict,
  ActionSuccessorDispatchFailureReason,
  ActionSuccessorIdentityInput,
  ActionSuccessorLease,
  ActionSuccessorPreflightResult,
  ClaimActionSuccessorInput,
  ClaimActionSuccessorResult,
  ContinueActionSuccessorFreshRevisionInput,
  ContinueActionSuccessorFreshRevisionResult,
  MarkActionSuccessorReturnDeliveredResult,
  RecordActionSuccessorReturnDeliveryAttemptResult,
  ReplaceActionSuccessorInput,
  ReplaceActionSuccessorResult,
  RetirePendingDispatchForFreshnessMismatchResult,
  ReturnActionSuccessorResult,
} from './action-successor-state-machine.js';

export interface ActionSubjectTerminalTruth {
  subjectRef: string;
  state: 'merged' | 'closed' | 'declined';
  evidenceRef: string;
  observedAt: number;
}

export type ActionSuccessorOutputPreflightResult =
  | { ok: true; reason: 'active' | 'verified_success' }
  | {
      ok: false;
      reason:
        | 'subject_terminal'
        | 'stale_generation'
        | 'lease_not_active'
        | 'predicate_mismatch'
        | 'holder_not_assigned'
        | 'holder_terminal';
    };

export type ActionSuccessorClaimStoreResult =
  | ClaimActionSuccessorResult
  | { outcome: 'subject_terminal'; terminal: ActionSubjectTerminalTruth };

export type ActionSuccessorReplaceStoreResult =
  | ReplaceActionSuccessorResult
  | { outcome: 'subject_terminal'; lease: ActionSuccessorLease };

export type ActionSuccessorReturnStoreResult =
  | ReturnActionSuccessorResult
  | { outcome: 'subject_terminal'; lease: ActionSuccessorLease };

export type ActionSuccessorDispatchAttemptResult = {
  outcome:
    | 'recorded'
    | 'subject_terminal'
    | 'stale_generation'
    | 'stale_revision'
    | 'predicate_mismatch'
    | 'dispatch_not_pending'
    | 'lease_not_active'
    | 'holder_terminal';
  lease: ActionSuccessorLease;
};

export type ActionSuccessorDispatchReservationResult = {
  outcome:
    | 'reserved'
    | 'subject_terminal'
    | 'stale_generation'
    | 'stale_revision'
    | 'predicate_mismatch'
    | 'dispatch_not_pending'
    | 'dispatch_reserved'
    | 'lease_not_active'
    | 'holder_terminal'
    | 'attempt_missing';
  lease: ActionSuccessorLease;
};

export type ActionSuccessorFreshnessMismatchRetirementResult =
  | RetirePendingDispatchForFreshnessMismatchResult
  | { outcome: 'subject_terminal'; lease: ActionSuccessorLease };

export type ActionSuccessorDispatchDeliveredResult = {
  outcome:
    | 'delivered'
    | 'stale_generation'
    | 'stale_revision'
    | 'predicate_mismatch'
    | 'dispatch_not_pending'
    | 'reservation_mismatch';
  lease: ActionSuccessorLease;
};

export type ActionSuccessorDispatchFailedResult = {
  outcome: 'failed' | 'stale_generation' | 'stale_revision' | 'predicate_mismatch' | 'dispatch_not_pending';
  lease: ActionSuccessorLease;
};

export type ActionSuccessorCommitOutcomeResult =
  | { outcome: 'recorded'; lease: ActionSuccessorLease }
  | {
      outcome: 'subject_terminal' | 'stale_generation' | 'lease_not_active' | 'holder_outcome_exists' | 'lease_missing';
      lease: ActionSuccessorLease | null;
    };

export type ActionSuccessorLocalReviewRecoveryStoreResult =
  | RecoverActiveLocalReviewVerdictResult
  | { outcome: 'subject_terminal'; lease: ActionSuccessorLease };

export interface ActionSuccessorLeaseStore {
  get(leaseId: string): Promise<ActionSuccessorLease | null>;
  getByIdentity(input: ActionSuccessorIdentityInput): Promise<ActionSuccessorLease | null>;
  listActiveTaskLeases(limit?: number): Promise<ActionSuccessorLease[]>;
  listPendingReturns(limit?: number): Promise<ActionSuccessorLease[]>;
  listPendingDispatches(limit?: number): Promise<ActionSuccessorLease[]>;
  claim(input: ClaimActionSuccessorInput): Promise<ActionSuccessorClaimStoreResult>;
  commitOutcome(
    leaseId: string,
    input: {
      generation: number;
      catId: string;
      outcome: ActionSuccessorLease['holderOutcomes'][string]['outcome'];
      evidenceRef: string;
      now: number;
    },
  ): Promise<ActionSuccessorCommitOutcomeResult>;
  recoverLocalReviewVerdict(
    leaseId: string,
    input: RecoverActiveLocalReviewVerdictInput,
  ): Promise<ActionSuccessorLocalReviewRecoveryStoreResult>;
  recordCompletionCandidate(
    leaseId: string,
    input: { generation: number; catId: string; evidenceRefs: string[]; now: number },
  ): Promise<ActionSuccessorCommitOutcomeResult>;
  commitCompletionVerdict(
    leaseId: string,
    input: { generation: number; catId: string; verdict: ActionCompletionVerdict; now: number },
  ): Promise<
    | { outcome: 'committed'; lease: ActionSuccessorLease }
    | {
        outcome:
          | 'subject_terminal'
          | 'stale_generation'
          | 'lease_not_active'
          | 'holder_outcome_exists'
          | 'candidate_changed'
          | 'lease_missing';
        lease: ActionSuccessorLease | null;
      }
  >;
  continueFreshRevision(
    leaseId: string,
    input: ContinueActionSuccessorFreshRevisionInput,
  ): Promise<ContinueActionSuccessorFreshRevisionResult>;
  replace(leaseId: string, input: ReplaceActionSuccessorInput): Promise<ActionSuccessorReplaceStoreResult>;
  returnToPredecessor(
    leaseId: string,
    input: {
      expectedGeneration: number;
      rejectingCatId: string;
      rejectingThreadId: string;
      dispatchId: string;
      groundingEvidenceRef: string;
      now: number;
    },
  ): Promise<ActionSuccessorReturnStoreResult>;
  markReturnDelivered(
    leaseId: string,
    input: { expectedGeneration: number; evidenceRef: string; now: number },
  ): Promise<MarkActionSuccessorReturnDeliveredResult>;
  recordReturnDeliveryAttempt(
    leaseId: string,
    input: { expectedGeneration: number; now: number },
  ): Promise<RecordActionSuccessorReturnDeliveryAttemptResult>;
  recordDispatchDeliveryAttempt(
    leaseId: string,
    input: {
      expectedGeneration: number;
      expectedRevision: number;
      expectedPredicateDigest: string;
      freshnessEvidenceRef: string;
      now: number;
    },
  ): Promise<ActionSuccessorDispatchAttemptResult>;
  reserveDispatchDelivery(
    leaseId: string,
    input: {
      expectedGeneration: number;
      expectedRevision: number;
      expectedPredicateDigest: string;
      freshnessEvidenceRef: string;
      now: number;
    },
  ): Promise<ActionSuccessorDispatchReservationResult>;
  retirePendingDispatchForFreshnessMismatch(
    leaseId: string,
    input: {
      expectedGeneration: number;
      expectedRevision: number;
      expectedPredicateDigest: string;
      evidenceRef: string;
      now: number;
    },
  ): Promise<ActionSuccessorFreshnessMismatchRetirementResult>;
  markDispatchDelivered(
    leaseId: string,
    input: {
      expectedGeneration: number;
      expectedRevision: number;
      expectedPredicateDigest: string;
      freshnessEvidenceRef: string;
      deliveredMessageId: string;
      evidenceRef: string;
      now: number;
    },
  ): Promise<ActionSuccessorDispatchDeliveredResult>;
  markDispatchFailed(
    leaseId: string,
    input: {
      expectedGeneration: number;
      expectedRevision: number;
      expectedPredicateDigest: string;
      reason: ActionSuccessorDispatchFailureReason;
      evidenceRef: string;
      now: number;
    },
  ): Promise<ActionSuccessorDispatchFailedResult>;
  markSubjectTerminal(input: {
    subjectRef: string;
    state: ActionSubjectTerminalTruth['state'];
    evidenceRef: string;
    now: number;
  }): Promise<ActionSubjectTerminalTruth>;
  getSubjectTerminal(subjectRef: string): Promise<ActionSubjectTerminalTruth | null>;
  clearSubjectTerminal(subjectRef: string, input: { evidenceRef: string; now: number }): Promise<boolean>;
  preflight(
    leaseId: string,
    generation: number,
    terminalPredicateDigest?: string,
  ): Promise<ActionSuccessorPreflightResult | { ok: false; reason: 'lease_missing' }>;
  preflightOutput(
    leaseId: string,
    generation: number,
    catId: string,
    terminalPredicateDigest?: string,
  ): Promise<ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' }>;
}
