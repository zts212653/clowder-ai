import type {
  ActionCompletionVerdict,
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
  outcome: 'recorded' | 'subject_terminal' | 'stale_generation' | 'dispatch_not_pending';
  lease: ActionSuccessorLease;
};

export type ActionSuccessorDispatchDeliveredResult = {
  outcome: 'delivered' | 'stale_generation' | 'dispatch_not_pending';
  lease: ActionSuccessorLease;
};

export type ActionSuccessorCommitOutcomeResult =
  | { outcome: 'recorded'; lease: ActionSuccessorLease }
  | {
      outcome: 'subject_terminal' | 'stale_generation' | 'lease_not_active' | 'holder_outcome_exists' | 'lease_missing';
      lease: ActionSuccessorLease | null;
    };

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
    input: { expectedGeneration: number; now: number },
  ): Promise<ActionSuccessorDispatchAttemptResult>;
  markDispatchDelivered(
    leaseId: string,
    input: { expectedGeneration: number; deliveredMessageId: string; evidenceRef: string; now: number },
  ): Promise<ActionSuccessorDispatchDeliveredResult>;
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
