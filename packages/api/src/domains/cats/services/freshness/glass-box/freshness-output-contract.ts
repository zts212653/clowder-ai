import type {
  FreshnessClosureAggregate,
  FreshnessClosureProjection,
  FreshnessSupplementAggregate,
  FreshnessSupplementProjection,
  OutputCommitDecision,
  PublishedFreshnessAnnotation,
} from '@cat-cafe/shared';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { StreamFreshnessResult } from '../checkStreamOutputFreshness.js';
import type { FreshnessClosureScope } from '../FreshnessClosureStore.js';

export const SUPPLEMENT_DECLINE_MARKER = '<!-- cat-cafe:supplement-decline -->';

export function freshnessClosureFinalIdempotencyKey(closureId: string): string {
  return `freshness-closure:${closureId}:final`;
}

export interface FreshnessEvaluation {
  freshness: StreamFreshnessResult;
  /** Raw MessageStore frontier captured before this freshness scan began. */
  rawFrontierMessageId: string | null;
}

export interface FreshnessOutputCommitInput extends FreshnessClosureScope {
  invocationId: string;
  /** Visible answer-turn identity. Defaults to invocationId for non-routed callers. */
  turnInvocationId?: string;
  /** Immutable trigger identity for a newly opened lineage. */
  originTriggerMessageId?: string | null;
  /** Exact adopted lineage. Omit for independent normal work. */
  freshnessClosureId?: string;
  /** Exact ADR-042 supplement carrier. Never aliases a legacy closure identity. */
  freshnessSupplementId?: string;
  message: AppendMessageInput;
  evaluateFreshness: (priorFrontierMessageId: string | null) => Promise<FreshnessEvaluation>;
  replayUnsafeToolNames?: string[];
  /** @deprecated ADR-042 does not recheck an append frontier. */
  commitRecheckLimit?: number;
}

interface FreshnessDecisionContext {
  invocationId: string;
  turnInvocationId?: string;
}

function turnInvocationId(input: FreshnessDecisionContext): string {
  return input.turnInvocationId ?? input.invocationId;
}

export function committedDecision(
  input: FreshnessDecisionContext,
  messageId: string,
  freshnessSupplementId?: string,
): OutputCommitDecision {
  return {
    kind: 'committed_fresh',
    messageId,
    ...(freshnessSupplementId ? { freshnessSupplementId } : {}),
    turnOutcome: 'committed',
    turnInvocationId: turnInvocationId(input),
    draftCustody: { kind: 'message', messageId },
  };
}

export function publishedWithUnseenDecision(
  input: FreshnessDecisionContext,
  messageId: string,
  lineageId: string,
  offeredSupplementId: string,
  requiredFrontierMessageId: string,
): OutputCommitDecision {
  return {
    kind: 'published_with_unseen',
    messageId,
    lineageId,
    offeredSupplementId,
    requiredFrontierMessageId,
    turnOutcome: 'committed',
    turnInvocationId: turnInvocationId(input),
    draftCustody: { kind: 'message', messageId },
  };
}

export function supplementDeclinedDecision(
  input: FreshnessDecisionContext,
  supplement: FreshnessSupplementAggregate,
): OutputCommitDecision {
  return {
    kind: 'supplement_declined',
    freshnessSupplementId: supplement.id,
    lineageId: supplement.lineageId,
    turnOutcome: 'committed',
    turnInvocationId: turnInvocationId(input),
    draftCustody: { kind: 'supplement', supplementId: supplement.id },
  };
}

export function committedDegradedDecision(
  input: FreshnessDecisionContext,
  messageId: string,
  reason: string,
): OutputCommitDecision {
  return {
    kind: 'committed_degraded_unknown',
    messageId,
    reason,
    turnOutcome: 'committed',
    turnInvocationId: turnInvocationId(input),
    draftCustody: { kind: 'message', messageId },
  };
}

export function freshnessUnknownReason(
  result: StreamFreshnessResult,
): Extract<PublishedFreshnessAnnotation, { kind: 'freshness_unknown' }>['reason'] | null {
  switch (result.reason) {
    case 'cursor_missing':
    case 'scan_incomplete':
    case 'error_failopen':
    case 'queued_identity_missing':
      return result.reason;
    default:
      return null;
  }
}

export function scanFailure(): { freshness: StreamFreshnessResult; rawFrontierMessageId: null } {
  return {
    freshness: {
      stale: false,
      unseenCount: 0,
      unseenSenders: [],
      unseenMessageIds: [],
      scanComplete: false,
      reason: 'error_failopen',
    },
    rawFrontierMessageId: null,
  };
}

export function projectFreshnessClosure(
  closure: FreshnessClosureAggregate,
  status?: FreshnessClosureProjection['status'],
): FreshnessClosureProjection {
  const projectedStatus =
    status ??
    (closure.status === 'blocked'
      ? 'blocked'
      : closure.status === 'committed'
        ? 'committed'
        : closure.status === 'disposed'
          ? 'disposed'
          : 'catching_up');
  return {
    type: 'freshness_closure',
    closureId: closure.id,
    userId: closure.userId,
    threadId: closure.threadId,
    catId: closure.catId,
    status: projectedStatus,
    requiredCount: closure.requiredMessageIds.length,
    requiredFrontierMessageId: closure.requiredFrontierMessageId,
    sourceInvocationId: closure.latestDraft.invocationId,
    turnInvocationId: closure.turnInvocationId,
    originTriggerMessageId: closure.originTriggerMessageId,
    ...(closure.replayUnsafeToolNames?.length ? { replayUnsafeToolNames: closure.replayUnsafeToolNames } : {}),
    ...(closure.blockedReason ? { blockedReason: closure.blockedReason } : {}),
    ...(closure.committedMessageId ? { committedMessageId: closure.committedMessageId } : {}),
    updatedAt: closure.updatedAt,
  };
}

export function projectFreshnessSupplement(supplement: FreshnessSupplementAggregate): FreshnessSupplementProjection {
  return {
    type: 'freshness_supplement',
    supplementId: supplement.id,
    lineageId: supplement.lineageId,
    originalMessageId: supplement.originalMessageId,
    threadId: supplement.threadId,
    catId: supplement.catId,
    seq: supplement.seq,
    status: supplement.status,
    requiredCount: supplement.requiredMessageIds.length,
    ...(supplement.committedMessageId ? { committedMessageId: supplement.committedMessageId } : {}),
    ...(supplement.declineReason
      ? { terminalReason: supplement.declineReason }
      : supplement.failureReason
        ? { terminalReason: supplement.failureReason }
        : {}),
    ...(supplement.budgetExhausted ? { budgetExhaustedCount: supplement.budgetExhausted.unseenMessageIds.length } : {}),
    updatedAt: supplement.updatedAt,
  };
}
