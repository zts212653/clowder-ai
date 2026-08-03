import type { FreshnessSupplementAggregate, FreshnessSupplementFailureReason } from '@cat-cafe/shared';

export const MAX_AUTOMATIC_SUPPLEMENTS_PER_LINEAGE = 2 as const;
const MAX_REPLAY_UNSAFE_TOOL_NAMES = 16;
const MAX_MESSAGE_IDS = 200;

export interface FreshnessSupplementOfferInput {
  lineageId: string;
  originalMessageId: string;
  userId: string;
  threadId: string;
  catId: string;
  requiredMessageIds: string[];
  requiredFrontierMessageId: string;
  replayUnsafeToolNames?: string[];
  now: number;
}

function mergeIds(current: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...current, ...incoming].filter(Boolean))].sort().slice(-MAX_MESSAGE_IDS);
}

function mergeUnsafe(current: readonly string[], incoming: readonly string[] = []): string[] {
  return [...new Set([...current, ...incoming].map((name) => name.trim()).filter(Boolean))]
    .sort()
    .slice(0, MAX_REPLAY_UNSAFE_TOOL_NAMES);
}

function assertIdentity(input: FreshnessSupplementOfferInput): void {
  if (!input.lineageId || !input.originalMessageId || !input.requiredFrontierMessageId) {
    throw new Error('freshness supplement requires lineage, original message, and frontier identity');
  }
  if (input.lineageId !== input.originalMessageId) {
    throw new Error('freshness supplement lineage must equal the published original message id');
  }
  if (input.requiredMessageIds.length === 0) {
    throw new Error('freshness supplement requires at least one relevant message');
  }
}

function assertPending(supplement: FreshnessSupplementAggregate): void {
  if (supplement.status !== 'pending') throw new Error('only a pending freshness supplement may transition');
}

function assertRunningInvocation(supplement: FreshnessSupplementAggregate, invocationId: string): void {
  if (supplement.status !== 'running' || supplement.runningInvocationId !== invocationId) {
    throw new Error('only the claimed invocation may finish a freshness supplement');
  }
}

export function freshnessSupplementId(lineageId: string, seq: 1 | 2): string {
  return `f254-supplement:${lineageId}:${seq}`;
}

export function createFreshnessSupplement(
  input: FreshnessSupplementOfferInput & { seq: 1 | 2 },
): FreshnessSupplementAggregate {
  assertIdentity(input);
  return {
    id: freshnessSupplementId(input.lineageId, input.seq),
    lineageId: input.lineageId,
    seq: input.seq,
    userId: input.userId,
    threadId: input.threadId,
    catId: input.catId,
    originalMessageId: input.originalMessageId,
    requiredMessageIds: mergeIds([], input.requiredMessageIds),
    requiredFrontierMessageId: input.requiredFrontierMessageId,
    status: 'pending',
    replayUnsafeToolNames: mergeUnsafe([], input.replayUnsafeToolNames),
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function advanceFreshnessSupplement(
  supplement: FreshnessSupplementAggregate,
  input: FreshnessSupplementOfferInput,
): FreshnessSupplementAggregate {
  assertPending(supplement);
  assertIdentity(input);
  if (
    supplement.lineageId !== input.lineageId ||
    supplement.userId !== input.userId ||
    supplement.threadId !== input.threadId ||
    supplement.catId !== input.catId
  ) {
    throw new Error('freshness supplement scope mismatch');
  }
  return {
    ...supplement,
    requiredMessageIds: mergeIds(supplement.requiredMessageIds, input.requiredMessageIds),
    requiredFrontierMessageId:
      input.requiredFrontierMessageId > supplement.requiredFrontierMessageId
        ? input.requiredFrontierMessageId
        : supplement.requiredFrontierMessageId,
    replayUnsafeToolNames: mergeUnsafe(supplement.replayUnsafeToolNames, input.replayUnsafeToolNames),
    revision: supplement.revision + 1,
    updatedAt: Math.max(supplement.updatedAt, input.now),
  };
}

export function claimFreshnessSupplement(
  supplement: FreshnessSupplementAggregate,
  input: { invocationId: string; now: number },
): FreshnessSupplementAggregate {
  assertPending(supplement);
  if (!input.invocationId) throw new Error('freshness supplement claim requires invocation identity');
  return {
    ...supplement,
    status: 'running',
    runningInvocationId: input.invocationId,
    revision: supplement.revision + 1,
    updatedAt: input.now,
  };
}

export function commitFreshnessSupplement(
  supplement: FreshnessSupplementAggregate,
  input: { invocationId: string; messageId: string; now: number },
): FreshnessSupplementAggregate {
  assertRunningInvocation(supplement, input.invocationId);
  if (!input.messageId) throw new Error('freshness supplement commit requires message identity');
  return {
    ...supplement,
    status: 'committed',
    runningInvocationId: undefined,
    committedMessageId: input.messageId,
    revision: supplement.revision + 1,
    updatedAt: input.now,
  };
}

export function declineFreshnessSupplement(
  supplement: FreshnessSupplementAggregate,
  input: { invocationId: string; now: number },
): FreshnessSupplementAggregate {
  assertRunningInvocation(supplement, input.invocationId);
  return {
    ...supplement,
    status: 'declined',
    runningInvocationId: undefined,
    declineReason: 'checked_no_supplement_needed',
    revision: supplement.revision + 1,
    updatedAt: input.now,
  };
}

export function failFreshnessSupplement(
  supplement: FreshnessSupplementAggregate,
  input: { invocationId?: string; reason: FreshnessSupplementFailureReason; now: number },
): FreshnessSupplementAggregate {
  if (supplement.status === 'running') {
    if (!input.invocationId) throw new Error('running freshness supplement failure requires invocation identity');
    assertRunningInvocation(supplement, input.invocationId);
  } else {
    assertPending(supplement);
  }
  return {
    ...supplement,
    status: 'failed',
    runningInvocationId: undefined,
    failureReason: input.reason,
    revision: supplement.revision + 1,
    updatedAt: input.now,
  };
}

export function markFreshnessSupplementBudgetExhausted(
  supplement: FreshnessSupplementAggregate,
  input: { unseenMessageIds: string[]; observedAt: number },
): FreshnessSupplementAggregate {
  if (supplement.seq !== MAX_AUTOMATIC_SUPPLEMENTS_PER_LINEAGE) {
    throw new Error('only the final supplement sequence may exhaust the lineage budget');
  }
  return {
    ...supplement,
    budgetExhausted: {
      unseenMessageIds: mergeIds(supplement.budgetExhausted?.unseenMessageIds ?? [], input.unseenMessageIds),
      observedAt: Math.max(supplement.budgetExhausted?.observedAt ?? 0, input.observedAt),
    },
    revision: supplement.revision + 1,
    updatedAt: Math.max(supplement.updatedAt, input.observedAt),
  };
}
