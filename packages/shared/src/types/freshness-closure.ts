export type FreshnessClosureStatus = 'pending' | 'running' | 'blocked' | 'committed' | 'disposed';

/**
 * ADR-042: exact-boundary annotation stored on every completed answer that
 * enters the glass-box publish path. `priorFrontierMessageId` is written by
 * the same atomic operation that appends the message.
 */
export type PublishedFreshnessAnnotation =
  | { kind: 'scan_pending'; priorFrontierMessageId: string | null }
  | { kind: 'fresh'; priorFrontierMessageId: string | null }
  | {
      kind: 'published_with_unseen';
      priorFrontierMessageId: string | null;
      generatedWithUnseen: string[];
      lineageId: string;
      /** Durable fallback when the facts were published but no supplement responsibility could be stored. */
      supplementFailureReason?: 'infrastructure';
    }
  | {
      kind: 'freshness_unknown';
      priorFrontierMessageId: string | null;
      reason: 'cursor_missing' | 'scan_incomplete' | 'error_failopen' | 'queued_identity_missing';
    };

export type FreshnessSupplementStatus = 'pending' | 'running' | 'committed' | 'declined' | 'failed';

export type FreshnessSupplementFailureReason =
  | 'provider_failure'
  | 'user_cancel'
  | 'quota'
  | 'queue_full'
  | 'scheduler_unavailable'
  | 'read_only_policy_unavailable'
  | 'tool_policy_violation'
  | 'infrastructure';

/** Durable ADR-042 supplement responsibility. TTL is always zero/persistent. */
export interface FreshnessSupplementAggregate {
  id: string;
  lineageId: string;
  seq: 1 | 2;
  userId: string;
  threadId: string;
  catId: string;
  originalMessageId: string;
  requiredMessageIds: string[];
  requiredFrontierMessageId: string;
  status: FreshnessSupplementStatus;
  runningInvocationId?: string;
  committedMessageId?: string;
  declineReason?: 'checked_no_supplement_needed';
  failureReason?: FreshnessSupplementFailureReason;
  replayUnsafeToolNames: string[];
  budgetExhausted?: {
    unseenMessageIds: string[];
    observedAt: number;
  };
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** Browser-safe, rebuildable status attached to the published original. */
export interface FreshnessSupplementProjection {
  type: 'freshness_supplement';
  supplementId: string;
  lineageId: string;
  originalMessageId: string;
  threadId: string;
  catId: string;
  seq: 1 | 2;
  status: FreshnessSupplementStatus;
  requiredCount: number;
  committedMessageId?: string;
  terminalReason?: 'checked_no_supplement_needed' | FreshnessSupplementFailureReason;
  budgetExhaustedCount?: number;
  updatedAt: number;
}

export type FreshnessClosureBlockedReason =
  | 'user_cancel'
  | 'provider_failure'
  | 'quota'
  | 'attempt_budget_exhausted'
  | 'commit_recheck_exhausted'
  | 'side_effect_requires_explicit_retry'
  | 'startup_recovery_requires_explicit_retry'
  | 'freshness_preflight_incomplete'
  | 'infrastructure';

export interface ClosureDraftBody {
  content: string;
  hash: string;
  length: number;
  invocationId: string;
}

export interface FreshnessClosureAttempt {
  invocationId: string;
  inputFrontierMessageId?: string;
  observedRawFrontierMessageId: string | null;
  draftHash: string;
  draftLength: number;
  outcome: 'superseded' | 'committed' | 'failed' | 'canceled';
  evidenceRefs: string[];
  createdAt: number;
}

export interface LegacyClosureMigrationOutcomeCounts {
  already_formal_exact: number;
  already_recovered_exact: number;
  no_text: number;
}

export type FreshnessClosureDisposition =
  | {
      kind: 'deferred' | 'superseded' | 'dismissed';
      actorId: string;
      evidenceRef: string;
    }
  | {
      /** Explicit, audit-pinned terminalization of pre-ADR-042 withheld output custody. */
      kind: 'legacy_migrated';
      actorId: string;
      evidenceRef: string;
      manifestSha256: string;
      accountingSha256: string;
      invocationIds: string[];
      messageIds: string[];
      evidenceRefs: string[];
      outcomeCounts: LegacyClosureMigrationOutcomeCounts;
    };

export interface FreshnessClosureAggregate {
  id: string;
  userId: string;
  threadId: string;
  catId: string;
  /** Immutable user/A2A message that created this lineage. Null only for legacy data. */
  originTriggerMessageId: string | null;
  /** Visible turn that owns latestDraft; distinct from parent/chain invocation identity. */
  turnInvocationId: string;
  status: FreshnessClosureStatus;
  requiredFrontierMessageId: string;
  requiredMessageIds: string[];
  observedRawFrontierMessageId: string | null;
  activeAttempt?: {
    invocationId: string;
    inputFrontierMessageId: string;
    observedRawFrontierMessageId: string | null;
    commitRecheckCount: number;
    startedAt: number;
  };
  baseDraft: ClosureDraftBody;
  latestDraft: ClosureDraftBody;
  attempts: FreshnessClosureAttempt[];
  automaticSuccessorAttemptCount: number;
  retryEpoch: number;
  /** Completed/attempted tools that make blind replay unsafe. Bounded + deduped by the state machine. */
  replayUnsafeToolNames?: string[];
  blockedReason?: FreshnessClosureBlockedReason;
  /** Evidence for a block that happened before a successor invocation was claimed. */
  blockedEvidenceRefs?: string[];
  committedInvocationId?: string;
  committedMessageId?: string;
  disposition?: FreshnessClosureDisposition;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** Rebuildable user-facing projection of one durable catch closure. */
export interface FreshnessClosureProjection {
  type: 'freshness_closure';
  closureId: string;
  userId: string;
  threadId: string;
  catId: string;
  status: 'catching_up' | 'blocked' | 'committed' | 'disposed';
  requiredCount: number;
  requiredFrontierMessageId: string;
  sourceInvocationId: string;
  turnInvocationId: string;
  originTriggerMessageId: string | null;
  replayUnsafeToolNames?: string[];
  blockedReason?: FreshnessClosureBlockedReason;
  committedMessageId?: string;
  updatedAt: number;
}

export type FreshnessTurnOutcome = 'committed' | 'superseded' | 'blocked' | 'retained';

export type DraftCustody =
  | { kind: 'message'; messageId: string }
  | { kind: 'closure'; closureId: string }
  | { kind: 'supplement'; supplementId: string }
  | { kind: 'retained'; invocationId: string };

export type OutputCommitDecision =
  | {
      kind: 'committed_fresh';
      messageId: string;
      closureId?: string;
      freshnessSupplementId?: string;
      turnOutcome: 'committed';
      turnInvocationId: string;
      draftCustody: Extract<DraftCustody, { kind: 'message' }>;
    }
  | {
      kind: 'published_with_unseen';
      messageId: string;
      lineageId: string;
      offeredSupplementId: string;
      requiredFrontierMessageId: string;
      turnOutcome: 'committed';
      turnInvocationId: string;
      draftCustody: Extract<DraftCustody, { kind: 'message' }>;
    }
  | {
      kind: 'supplement_declined';
      freshnessSupplementId: string;
      lineageId: string;
      turnOutcome: 'committed';
      turnInvocationId: string;
      draftCustody: Extract<DraftCustody, { kind: 'supplement' }>;
    }
  | {
      kind: 'superseded_positive_stale';
      closureId: string;
      requiredFrontierMessageId: string;
      turnOutcome: 'superseded';
      turnInvocationId: string;
      draftCustody: Extract<DraftCustody, { kind: 'closure' }>;
    }
  | {
      kind: 'blocked_known_closure';
      closureId: string;
      reason: string;
      turnOutcome: 'blocked' | 'retained';
      turnInvocationId: string;
      draftCustody: Extract<DraftCustody, { kind: 'closure' }> | Extract<DraftCustody, { kind: 'retained' }>;
    }
  | {
      kind: 'committed_degraded_unknown';
      messageId: string;
      reason: string;
      turnOutcome: 'committed';
      turnInvocationId: string;
      draftCustody: Extract<DraftCustody, { kind: 'message' }>;
    };
