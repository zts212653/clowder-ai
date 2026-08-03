import type {
  CreateTurnExecutionInput,
  CreateTurnExecutionResult,
  InterruptRunningTurnExecutionsInput,
  TransitionTurnExecutionResult,
  TurnExecutionCausalRefs,
  TurnExecutionKind,
  TurnExecutionMessageProjection,
  TurnExecutionRecord,
  TurnExecutionStatus,
  TurnExecutionTerminalInput,
  TurnExecutionTerminalStatus,
} from '@cat-cafe/shared';

export type {
  CreateTurnExecutionInput,
  CreateTurnExecutionResult,
  InterruptRunningTurnExecutionsInput,
  TransitionTurnExecutionResult,
  TurnExecutionCausalRefs,
  TurnExecutionKind,
  TurnExecutionMessageProjection,
  TurnExecutionRecord,
  TurnExecutionStatus,
  TurnExecutionTerminalInput,
  TurnExecutionTerminalStatus,
} from '@cat-cafe/shared';

export function projectTurnExecutionMessage(record: TurnExecutionRecord): TurnExecutionMessageProjection {
  return {
    invocationId: record.invocationId,
    parentInvocationId: record.parentInvocationId,
    executionKind: record.executionKind,
  };
}

export interface ITurnExecutionStore {
  createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult | Promise<CreateTurnExecutionResult>;
  get(invocationId: string): TurnExecutionRecord | null | Promise<TurnExecutionRecord | null>;
  listByParent(parentInvocationId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  transitionTerminal(
    invocationId: string,
    input: TurnExecutionTerminalInput,
  ): TransitionTurnExecutionResult | Promise<TransitionTurnExecutionResult>;
  interruptRunningBefore(
    cutoffStartedAt: number,
    input: InterruptRunningTurnExecutionsInput,
  ): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
}

const EXECUTION_KINDS = new Set<TurnExecutionKind>(['ordinary', 'routing_guard', 'freshness_supplement']);
const TERMINAL_STATUSES = new Set<TurnExecutionTerminalStatus>(['succeeded', 'failed', 'canceled', 'interrupted']);

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
}

export function assertCreateTurnExecutionInput(input: CreateTurnExecutionInput): void {
  assertNonEmpty(input.invocationId, 'invocationId');
  assertNonEmpty(input.parentInvocationId, 'parentInvocationId');
  assertNonEmpty(input.threadId, 'threadId');
  assertNonEmpty(input.userId, 'userId');
  assertNonEmpty(input.catId as string, 'catId');
  if (!EXECUTION_KINDS.has(input.executionKind)) {
    throw new Error(`invalid executionKind: ${String(input.executionKind)}`);
  }
  assertTimestamp(input.startedAt, 'startedAt');
  if (input.causal?.triggerMessageId !== undefined) assertNonEmpty(input.causal.triggerMessageId, 'triggerMessageId');
  if (input.causal?.freshnessSupplementId !== undefined) {
    assertNonEmpty(input.causal.freshnessSupplementId, 'freshnessSupplementId');
  }
  if (input.causal?.routingGuardReason !== undefined && input.causal.routingGuardReason !== 'missing_routing_exit') {
    throw new Error(`invalid routingGuardReason: ${String(input.causal.routingGuardReason)}`);
  }
  if (input.causal?.coveredMessageIds !== undefined) {
    if (!Array.isArray(input.causal.coveredMessageIds) || input.causal.coveredMessageIds.length === 0) {
      throw new Error('coveredMessageIds must be a non-empty array when present');
    }
    const covered = new Set<string>();
    for (const messageId of input.causal.coveredMessageIds) {
      assertNonEmpty(messageId, 'coveredMessageId');
      if (covered.has(messageId)) throw new Error('coveredMessageIds must not contain duplicates');
      covered.add(messageId);
    }
  }
}

export function assertTurnExecutionTerminalInput(
  record: Pick<TurnExecutionRecord, 'startedAt'>,
  input: TurnExecutionTerminalInput,
): void {
  if (!TERMINAL_STATUSES.has(input.status)) throw new Error(`invalid terminal status: ${String(input.status)}`);
  assertTimestamp(input.endedAt, 'endedAt');
  if (input.endedAt < record.startedAt) throw new Error('endedAt cannot precede startedAt');
  if (input.status !== 'succeeded') assertNonEmpty(input.terminalReason ?? '', 'terminalReason');
  if (input.terminalReason !== undefined) assertNonEmpty(input.terminalReason, 'terminalReason');
}

export function cloneTurnExecutionRecord(record: TurnExecutionRecord): TurnExecutionRecord {
  return {
    invocationId: record.invocationId,
    parentInvocationId: record.parentInvocationId,
    threadId: record.threadId,
    userId: record.userId,
    catId: record.catId,
    executionKind: record.executionKind,
    startedAt: record.startedAt,
    ...(record.causal
      ? {
          causal: {
            ...record.causal,
            ...(record.causal.coveredMessageIds ? { coveredMessageIds: [...record.causal.coveredMessageIds] } : {}),
          },
        }
      : {}),
    status: record.status,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.terminalReason !== undefined ? { terminalReason: record.terminalReason } : {}),
  };
}

function canonicalCausalRefs(causal: TurnExecutionCausalRefs | undefined): TurnExecutionCausalRefs {
  return {
    ...(causal?.triggerMessageId !== undefined ? { triggerMessageId: causal.triggerMessageId } : {}),
    ...(causal?.freshnessSupplementId !== undefined ? { freshnessSupplementId: causal.freshnessSupplementId } : {}),
    ...(causal?.routingGuardReason !== undefined ? { routingGuardReason: causal.routingGuardReason } : {}),
    ...(causal?.coveredMessageIds !== undefined ? { coveredMessageIds: [...causal.coveredMessageIds].sort() } : {}),
  };
}

/** Stable identity serialization shared by memory and Redis idempotency checks. */
export function serializeTurnExecutionIdentity(input: CreateTurnExecutionInput): string {
  return JSON.stringify({
    invocationId: input.invocationId,
    parentInvocationId: input.parentInvocationId,
    threadId: input.threadId,
    userId: input.userId,
    catId: input.catId,
    executionKind: input.executionKind,
    startedAt: input.startedAt,
    causal: canonicalCausalRefs(input.causal),
  });
}

export function sameTurnExecutionIdentity(record: TurnExecutionRecord, input: CreateTurnExecutionInput): boolean {
  return serializeTurnExecutionIdentity(record) === serializeTurnExecutionIdentity(input);
}
