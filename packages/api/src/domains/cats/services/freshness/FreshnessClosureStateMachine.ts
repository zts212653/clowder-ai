import { createHash } from 'node:crypto';
import type {
  ClosureDraftBody,
  FreshnessClosureAggregate,
  FreshnessClosureAttempt,
  FreshnessClosureBlockedReason,
} from '@cat-cafe/shared';

const DEFAULT_AUTOMATIC_ATTEMPT_LIMIT = 5;
interface ClosureScope {
  userId: string;
  threadId: string;
  catId: string;
}

interface DraftAndFrontierInput extends ClosureScope {
  invocationId: string;
  turnInvocationId?: string;
  originTriggerMessageId?: string | null;
  draftContent: string;
  requiredMessageIds: string[];
  requiredFrontierMessageId: string;
  observedRawFrontierMessageId: string | null;
  replayUnsafeToolNames?: string[];
  now: number;
}

const MAX_REPLAY_UNSAFE_TOOL_NAMES = 16;

function mergeReplayUnsafeToolNames(current: readonly string[] = [], incoming: readonly string[] = []): string[] {
  return [...new Set([...current, ...incoming].map((name) => name.trim()).filter(Boolean))]
    .sort()
    .slice(0, MAX_REPLAY_UNSAFE_TOOL_NAMES);
}
function hashDraft(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeDraft(content: string, invocationId: string): ClosureDraftBody {
  return {
    content,
    hash: hashDraft(content),
    length: content.length,
    invocationId,
  };
}

function assertScope(closure: FreshnessClosureAggregate, input: ClosureScope): void {
  if (closure.userId !== input.userId || closure.threadId !== input.threadId || closure.catId !== input.catId) {
    throw new Error('freshness closure scope mismatch');
  }
}

export function assertFreshnessClosureNotTerminal(closure: FreshnessClosureAggregate): void {
  if (closure.status === 'committed' || closure.status === 'disposed') {
    throw new Error('freshness closure is terminal');
  }
}

function mergeOrderedIds(current: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...current, ...incoming])].sort();
}

function assertClaimedInvocation(closure: FreshnessClosureAggregate, invocationId: string): void {
  if (closure.status !== 'running' || closure.activeAttempt?.invocationId !== invocationId) {
    throw new Error('only the claimed invocation may finish a freshness closure attempt');
  }
}

export function buildFreshnessClosureAttempt(
  closure: FreshnessClosureAggregate,
  input: {
    invocationId: string;
    draftContent: string;
    observedRawFrontierMessageId: string | null;
    outcome: FreshnessClosureAttempt['outcome'];
    evidenceRefs: string[];
    now: number;
  },
): FreshnessClosureAttempt {
  return {
    invocationId: input.invocationId,
    inputFrontierMessageId: closure.activeAttempt?.inputFrontierMessageId,
    observedRawFrontierMessageId: input.observedRawFrontierMessageId,
    draftHash: hashDraft(input.draftContent),
    draftLength: input.draftContent.length,
    outcome: input.outcome,
    evidenceRefs: [...input.evidenceRefs],
    createdAt: input.now,
  };
}

export function createFreshnessClosure(input: DraftAndFrontierInput & { id: string }): FreshnessClosureAggregate {
  if (!input.id || !input.requiredFrontierMessageId || input.requiredMessageIds.length === 0) {
    throw new Error('freshness closure requires identity and a non-empty frontier');
  }
  const draft = makeDraft(input.draftContent, input.invocationId);
  const replayUnsafeToolNames = mergeReplayUnsafeToolNames([], input.replayUnsafeToolNames);
  const replayBlocked = replayUnsafeToolNames.length > 0;
  return {
    id: input.id,
    userId: input.userId,
    threadId: input.threadId,
    catId: input.catId,
    originTriggerMessageId: input.originTriggerMessageId ?? null,
    turnInvocationId: input.turnInvocationId ?? input.invocationId,
    status: replayBlocked ? 'blocked' : 'pending',
    requiredFrontierMessageId: input.requiredFrontierMessageId,
    requiredMessageIds: mergeOrderedIds([], input.requiredMessageIds),
    observedRawFrontierMessageId: input.observedRawFrontierMessageId,
    baseDraft: draft,
    latestDraft: draft,
    attempts: [],
    automaticSuccessorAttemptCount: 0,
    retryEpoch: 0,
    ...(replayBlocked ? { replayUnsafeToolNames, blockedReason: 'side_effect_requires_explicit_retry' as const } : {}),
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function advanceFreshnessClosure(
  closure: FreshnessClosureAggregate,
  input: DraftAndFrontierInput,
): FreshnessClosureAggregate {
  assertFreshnessClosureNotTerminal(closure);
  assertScope(closure, input);
  if (input.requiredFrontierMessageId < closure.requiredFrontierMessageId) {
    throw new Error('freshness closure frontier cannot regress');
  }
  const replayUnsafeToolNames = mergeReplayUnsafeToolNames(closure.replayUnsafeToolNames, input.replayUnsafeToolNames);
  const replayBlocked = Boolean(input.replayUnsafeToolNames?.length);
  return {
    ...closure,
    ...(replayBlocked
      ? {
          status: 'blocked' as const,
          activeAttempt: undefined,
          blockedReason: 'side_effect_requires_explicit_retry' as const,
          replayUnsafeToolNames,
        }
      : {}),
    requiredFrontierMessageId: input.requiredFrontierMessageId,
    requiredMessageIds: mergeOrderedIds(closure.requiredMessageIds, input.requiredMessageIds),
    observedRawFrontierMessageId: input.observedRawFrontierMessageId,
    latestDraft: makeDraft(input.draftContent, input.invocationId),
    turnInvocationId: input.turnInvocationId ?? input.invocationId,
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function claimFreshnessClosureAttempt(
  closure: FreshnessClosureAggregate,
  input: {
    invocationId: string;
    inputFrontierMessageId: string;
    observedRawFrontierMessageId: string | null;
    now: number;
    automatic?: boolean;
    automaticAttemptLimit?: number;
  },
): FreshnessClosureAggregate {
  assertFreshnessClosureNotTerminal(closure);
  if (closure.status !== 'pending') {
    throw new Error('only a pending freshness closure may be claimed');
  }
  const automatic = input.automatic ?? true;
  const limit = input.automaticAttemptLimit ?? DEFAULT_AUTOMATIC_ATTEMPT_LIMIT;
  if (automatic && closure.automaticSuccessorAttemptCount >= limit) {
    return {
      ...closure,
      status: 'blocked',
      blockedReason: 'attempt_budget_exhausted',
      revision: closure.revision + 1,
      updatedAt: input.now,
    };
  }
  return {
    ...closure,
    status: 'running',
    activeAttempt: {
      invocationId: input.invocationId,
      inputFrontierMessageId: input.inputFrontierMessageId,
      observedRawFrontierMessageId: input.observedRawFrontierMessageId,
      commitRecheckCount: 0,
      startedAt: input.now,
    },
    automaticSuccessorAttemptCount: closure.automaticSuccessorAttemptCount + (automatic ? 1 : 0),
    blockedReason: undefined,
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function refreshFreshnessClosureFrontier(
  closure: FreshnessClosureAggregate,
  input: {
    requiredMessageIds: string[];
    requiredFrontierMessageId: string;
    observedRawFrontierMessageId: string;
    now: number;
  },
): FreshnessClosureAggregate {
  assertFreshnessClosureNotTerminal(closure);
  if (closure.status !== 'pending') throw new Error('only a pending freshness closure may refresh its frontier');
  const requiredFrontierMessageId =
    input.requiredFrontierMessageId > closure.requiredFrontierMessageId
      ? input.requiredFrontierMessageId
      : closure.requiredFrontierMessageId;
  const observedRawFrontierMessageId =
    closure.observedRawFrontierMessageId && closure.observedRawFrontierMessageId > input.observedRawFrontierMessageId
      ? closure.observedRawFrontierMessageId
      : input.observedRawFrontierMessageId;
  return {
    ...closure,
    requiredMessageIds: mergeOrderedIds(closure.requiredMessageIds, input.requiredMessageIds),
    requiredFrontierMessageId,
    observedRawFrontierMessageId,
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function blockFreshnessClosurePreflight(
  closure: FreshnessClosureAggregate,
  input: { evidenceRefs: string[]; now: number },
): FreshnessClosureAggregate {
  assertFreshnessClosureNotTerminal(closure);
  if (closure.status !== 'pending') throw new Error('only a pending freshness closure may be blocked at preflight');
  if (input.evidenceRefs.length === 0) throw new Error('blocked closure requires evidence');
  return {
    ...closure,
    status: 'blocked',
    activeAttempt: undefined,
    blockedReason: 'freshness_preflight_incomplete',
    blockedEvidenceRefs: [...new Set(input.evidenceRefs)].slice(-16),
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function supersedeFreshnessClosureAttempt(
  closure: FreshnessClosureAggregate,
  input: {
    invocationId: string;
    draftContent: string;
    requiredMessageIds: string[];
    requiredFrontierMessageId: string;
    observedRawFrontierMessageId: string | null;
    evidenceRefs: string[];
    replayUnsafeToolNames?: string[];
    turnInvocationId?: string;
    now: number;
  },
): FreshnessClosureAggregate {
  assertClaimedInvocation(closure, input.invocationId);
  if (input.requiredFrontierMessageId < closure.requiredFrontierMessageId) {
    throw new Error('freshness closure frontier cannot regress');
  }
  const replayUnsafeToolNames = mergeReplayUnsafeToolNames(closure.replayUnsafeToolNames, input.replayUnsafeToolNames);
  const replayBlocked = Boolean(input.replayUnsafeToolNames?.length);
  return {
    ...closure,
    status: replayBlocked ? 'blocked' : 'pending',
    requiredFrontierMessageId: input.requiredFrontierMessageId,
    requiredMessageIds: mergeOrderedIds(closure.requiredMessageIds, input.requiredMessageIds),
    observedRawFrontierMessageId: input.observedRawFrontierMessageId,
    activeAttempt: undefined,
    latestDraft: makeDraft(input.draftContent, input.invocationId),
    turnInvocationId: input.turnInvocationId ?? input.invocationId,
    attempts: [
      ...closure.attempts,
      buildFreshnessClosureAttempt(closure, {
        invocationId: input.invocationId,
        draftContent: input.draftContent,
        observedRawFrontierMessageId: input.observedRawFrontierMessageId,
        outcome: 'superseded',
        evidenceRefs: input.evidenceRefs,
        now: input.now,
      }),
    ],
    ...(replayBlocked ? { replayUnsafeToolNames, blockedReason: 'side_effect_requires_explicit_retry' as const } : {}),
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function commitFreshnessClosureAttempt(
  closure: FreshnessClosureAggregate,
  input: {
    invocationId: string;
    messageId: string;
    observedRawFrontierMessageId: string | null;
    draftContent?: string;
    evidenceRefs?: string[];
    now: number;
  },
): FreshnessClosureAggregate {
  assertClaimedInvocation(closure, input.invocationId);
  const draftContent = input.draftContent ?? closure.latestDraft.content;
  return {
    ...closure,
    status: 'committed',
    activeAttempt: undefined,
    committedInvocationId: input.invocationId,
    committedMessageId: input.messageId,
    attempts: [
      ...closure.attempts,
      buildFreshnessClosureAttempt(closure, {
        invocationId: input.invocationId,
        draftContent,
        observedRawFrontierMessageId: input.observedRawFrontierMessageId,
        outcome: 'committed',
        evidenceRefs: input.evidenceRefs ?? [],
        now: input.now,
      }),
    ],
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function blockFreshnessClosureAttempt(
  closure: FreshnessClosureAggregate,
  input: {
    invocationId: string;
    reason: FreshnessClosureBlockedReason;
    evidenceRefs: string[];
    draftContent?: string;
    now: number;
  },
): FreshnessClosureAggregate {
  assertClaimedInvocation(closure, input.invocationId);
  if (input.evidenceRefs.length === 0) throw new Error('blocked closure requires evidence');
  const outcome = input.reason === 'user_cancel' ? 'canceled' : 'failed';
  const draftContent = input.draftContent ?? closure.latestDraft.content;
  return {
    ...closure,
    status: 'blocked',
    activeAttempt: undefined,
    ...(input.draftContent !== undefined ? { latestDraft: makeDraft(input.draftContent, input.invocationId) } : {}),
    blockedReason: input.reason,
    blockedEvidenceRefs: [...new Set(input.evidenceRefs)].slice(-16),
    attempts: [
      ...closure.attempts,
      buildFreshnessClosureAttempt(closure, {
        invocationId: input.invocationId,
        draftContent,
        observedRawFrontierMessageId: closure.observedRawFrontierMessageId,
        outcome,
        evidenceRefs: input.evidenceRefs,
        now: input.now,
      }),
    ],
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function disposeFreshnessClosure(
  closure: FreshnessClosureAggregate,
  input: {
    kind: 'deferred' | 'superseded' | 'dismissed';
    actorId: string;
    evidenceRef: string;
    now: number;
  },
): FreshnessClosureAggregate {
  assertFreshnessClosureNotTerminal(closure);
  if (!input.actorId || !input.evidenceRef) throw new Error('disposition requires actor and evidence');
  return {
    ...closure,
    status: 'disposed',
    activeAttempt: undefined,
    disposition: {
      kind: input.kind,
      actorId: input.actorId,
      evidenceRef: input.evidenceRef,
    },
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}
