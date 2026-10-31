import type {
  CreateTurnExecutionInput,
  CreateTurnExecutionResult,
  InterruptRunningTurnExecutionsInput,
  TransitionTurnExecutionResult,
  TurnExecutionCausalRefs,
  TurnExecutionKind,
  TurnExecutionMessageProjection,
  TurnExecutionRecord,
  TurnExecutionTerminalInput,
  TurnExecutionTerminalStatus,
  TurnOutputFence,
  TurnOutputFenceVerdict,
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
  TurnOutputFence,
  TurnOutputFenceVerdict,
} from '@cat-cafe/shared';

export function projectTurnExecutionMessage(record: TurnExecutionRecord): TurnExecutionMessageProjection {
  return {
    invocationId: record.invocationId,
    parentInvocationId: record.parentInvocationId,
    executionKind: record.executionKind,
  };
}

export interface TurnExecutionSourceQuery {
  userId: string;
  threadId: string;
  catId: string;
  messageId: string;
}

/** Existing execution causality is an internal fact, never a delivery/read receipt or grant. */
export function matchesTurnExecutionSource(record: TurnExecutionRecord, query: TurnExecutionSourceQuery): boolean {
  return (
    record.userId === query.userId &&
    record.threadId === query.threadId &&
    record.catId === query.catId &&
    record.executionKind === 'ordinary' &&
    typeof record.parentInvocationId === 'string' &&
    record.parentInvocationId.length > 0 &&
    record.parentInvocationId !== record.invocationId &&
    (record.causal?.triggerMessageId === query.messageId ||
      record.causal?.coveredMessageIds?.includes(query.messageId) === true)
  );
}

export type TurnExecutionSourceReadPort = Pick<ITurnExecutionStore, 'get'> &
  Partial<Pick<ITurnExecutionStore, 'listBySource'>>;

export interface ITurnExecutionStore {
  createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult | Promise<CreateTurnExecutionResult>;
  bindCoveredMessageIds(
    invocationId: string,
    messageIds: readonly string[],
  ): BindCoveredMessageIdsResult | Promise<BindCoveredMessageIdsResult>;
  get(invocationId: string): TurnExecutionRecord | null | Promise<TurnExecutionRecord | null>;
  /** Scoped historical lookup over existing records, including retired-Queue executions. Ambiguity belongs to the caller. */
  listBySource(query: TurnExecutionSourceQuery): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  listByParent(parentInvocationId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  /**
   * F297 (PR #3748 R3 P1-2): user-scoped running-child enumerator — **owner truth**.
   *
   * `listByParent` 只能从一个已知 running parent 往下问，所以 parent 已终态或不在
   * record store 里的 standalone canonical child 对 liveness classifier 完全不可见。
   * Sidebar 需要"这个用户此刻有哪些 child 在跑"，这是 child ledger 自己才答得出的问题。
   */
  listRunningByUser(userId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  markProviderStarted(invocationId: string, at: number): boolean | Promise<boolean>;
  recordProviderTeardown(invocationId: string, at: number): void | Promise<void>;
  transitionTerminal(
    invocationId: string,
    input: TurnExecutionTerminalInput,
  ): TransitionTurnExecutionResult | Promise<TransitionTurnExecutionResult>;
  interruptRunningBefore(
    cutoffStartedAt: number,
    input: InterruptRunningTurnExecutionsInput,
  ): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  /**
   * F117 KD-21: ended child turns whose response R is not yet confirmed terminal. Every terminal
   * transition enters this ledger atomically with the transition, so neither a failed R commit nor
   * a crash between the two writes can hide the turn from the next settlement pass.
   */
  listResponsePending(): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  /** Leaves the ledger once the turn's response R is confirmed terminal (or the turn has none). */
  clearResponsePending(invocationId: string): void | Promise<void>;
  /**
   * F117 KD-21: records the action fence's verdict on a gated child's output, so every later
   * settlement reads it instead of a process-local decision. The fence only moves forward
   * (gated → allowed → rejected); an open child, or one recorded before the fence existed, is left
   * as it is. Returns the record after the write, or null when the child is unknown.
   */
  settleOutputFence(
    invocationId: string,
    verdict: TurnOutputFenceVerdict,
  ): TurnExecutionRecord | null | Promise<TurnExecutionRecord | null>;
}

export type BindCoveredMessageIdsResult =
  | { outcome: 'bound' | 'replayed' | 'conflict'; record: TurnExecutionRecord }
  | { outcome: 'not_found'; record: null };

export function assertCoveredMessageIds(messageIds: readonly string[]): void {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error('coveredMessageIds must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const messageId of messageIds) {
    assertNonEmpty(messageId, 'coveredMessageId');
    if (seen.has(messageId)) throw new Error('coveredMessageIds must not contain duplicates');
    seen.add(messageId);
  }
}

const EXECUTION_KINDS = new Set<TurnExecutionKind>(['ordinary', 'routing_guard']);
const OUTPUT_FENCES = new Set<string>(['open', 'gated', 'allowed', 'rejected']);
const GATED_FENCE_RANK: Record<Exclude<TurnOutputFence, 'open'>, number> = { gated: 0, allowed: 1, rejected: 2 };

export function isTurnOutputFence(value: unknown): value is TurnOutputFence {
  return typeof value === 'string' && OUTPUT_FENCES.has(value);
}

/**
 * The fence after a verdict: a gated fence only moves forward. An open fence, and a record written
 * before the fence existed, stay as they are.
 */
export function advanceTurnOutputFence(
  current: TurnOutputFence | undefined,
  verdict: TurnOutputFenceVerdict,
): TurnOutputFence | undefined {
  if (current === undefined || current === 'open') return current;
  return GATED_FENCE_RANK[verdict] > GATED_FENCE_RANK[current] ? verdict : current;
}

/** A child is created open or gated; the verdicts arrive later through settleOutputFence. */
export function assertCreatableOutputFence(input: CreateTurnExecutionInput): void {
  if (input.outputFence !== undefined && input.outputFence !== 'open' && input.outputFence !== 'gated') {
    throw new Error(`a turn execution can only be created open or gated, not ${String(input.outputFence)}`);
  }
}

/** The fence a store records for a new child: every child has one, and an omitted fence is open. */
export function createdOutputFence(input: CreateTurnExecutionInput): 'open' | 'gated' {
  return input.outputFence === 'gated' ? 'gated' : 'open';
}

const TERMINAL_STATUSES = new Set<TurnExecutionTerminalStatus>(['succeeded', 'failed', 'canceled', 'interrupted']);

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
}

export function assertCreateTurnExecutionInput(input: CreateTurnExecutionInput): void {
  if (!EXECUTION_KINDS.has(input.executionKind)) {
    throw new Error(`invalid executionKind: ${String(input.executionKind)}`);
  }
  assertTurnExecutionIdentityFields(input);
}

/** Identity invariants shared with the bounded, read-only retired-record decoder. */
export function assertTurnExecutionIdentityFields(input: Omit<CreateTurnExecutionInput, 'executionKind'>): void {
  assertNonEmpty(input.invocationId, 'invocationId');
  assertNonEmpty(input.parentInvocationId, 'parentInvocationId');
  assertNonEmpty(input.threadId, 'threadId');
  assertNonEmpty(input.userId, 'userId');
  assertNonEmpty(input.catId as string, 'catId');
  assertTimestamp(input.startedAt, 'startedAt');
  if (input.outputFence !== undefined && !isTurnOutputFence(input.outputFence)) {
    throw new Error(`invalid outputFence: ${String(input.outputFence)}`);
  }
  if (input.queueCompletionPolicy !== undefined && input.queueCompletionPolicy !== 'explicit_source') {
    throw new Error('invalid queueCompletionPolicy');
  }
  if (input.causal?.triggerMessageId !== undefined) assertNonEmpty(input.causal.triggerMessageId, 'triggerMessageId');
  if (input.causal?.routingGuardReason !== undefined && input.causal.routingGuardReason !== 'missing_routing_exit') {
    throw new Error(`invalid routingGuardReason: ${String(input.causal.routingGuardReason)}`);
  }
  if (input.causal?.coveredMessageIds !== undefined) assertCoveredMessageIds(input.causal.coveredMessageIds);
  if (input.causal?.routingPreflight) {
    if (input.causal.routingPreflight.stage !== 'execution_preflight')
      throw new Error('invalid routing preflight stage');
    assertTimestamp(input.causal.routingPreflight.observedAt, 'routingPreflight.observedAt');
    if (input.causal.routingPreflight.snapshotRef !== undefined)
      assertNonEmpty(input.causal.routingPreflight.snapshotRef, 'routingPreflight.snapshotRef');
    const admission = input.causal.routingPreflight.admission;
    if (admission) {
      if (admission.stage !== 'queue_admitted') throw new Error('invalid routing admission stage');
      assertTimestamp(admission.observedAt, 'routingAdmission.observedAt');
      if (admission.snapshotRef !== undefined) assertNonEmpty(admission.snapshotRef, 'routingAdmission.snapshotRef');
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
  if (input.providerTeardownAt !== undefined) {
    assertTimestamp(input.providerTeardownAt, 'providerTeardownAt');
    if (input.providerTeardownAt < record.startedAt)
      throw new Error('providerTeardownAt must be inside the exact execution lifetime');
  }
}

export function cloneTurnExecutionRecord(record: TurnExecutionRecord): TurnExecutionRecord {
  return {
    ...(record.providerLifecycleTracked ? { providerLifecycleTracked: true } : {}),
    ...(record.providerStartedAt !== undefined ? { providerStartedAt: record.providerStartedAt } : {}),
    ...(record.providerTeardownAt !== undefined ? { providerTeardownAt: record.providerTeardownAt } : {}),
    invocationId: record.invocationId,
    parentInvocationId: record.parentInvocationId,
    threadId: record.threadId,
    userId: record.userId,
    catId: record.catId,
    executionKind: record.executionKind,
    ...(record.queueCompletionPolicy ? { queueCompletionPolicy: record.queueCompletionPolicy } : {}),
    startedAt: record.startedAt,
    ...(record.causal
      ? {
          causal: {
            ...record.causal,
            ...(record.causal.routingPreflight
              ? { routingPreflight: copyRoutingPreflight(record.causal.routingPreflight) }
              : {}),
            ...(record.causal.coveredMessageIds ? { coveredMessageIds: [...record.causal.coveredMessageIds] } : {}),
          },
        }
      : {}),
    status: record.status,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.terminalReason !== undefined ? { terminalReason: record.terminalReason } : {}),
    ...(record.outputFence !== undefined ? { outputFence: record.outputFence } : {}),
  };
}

function copyRoutingPreflight(provenance: NonNullable<TurnExecutionCausalRefs['routingPreflight']>) {
  return {
    stage: provenance.stage,
    observedAt: provenance.observedAt,
    ...(provenance.snapshotRef ? { snapshotRef: provenance.snapshotRef } : {}),
    ...(provenance.admission
      ? {
          admission: {
            stage: provenance.admission.stage,
            observedAt: provenance.admission.observedAt,
            ...(provenance.admission.snapshotRef ? { snapshotRef: provenance.admission.snapshotRef } : {}),
          },
        }
      : {}),
  };
}

function canonicalCausalRefs(causal: TurnExecutionCausalRefs | undefined): TurnExecutionCausalRefs {
  return {
    ...(causal?.routingPreflight
      ? {
          routingPreflight: copyRoutingPreflight(causal.routingPreflight),
        }
      : {}),
    ...(causal?.triggerMessageId !== undefined ? { triggerMessageId: causal.triggerMessageId } : {}),
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
    ...(input.queueCompletionPolicy ? { queueCompletionPolicy: input.queueCompletionPolicy } : {}),
    startedAt: input.startedAt,
    causal: canonicalCausalRefs(input.causal),
  });
}

export function sameTurnExecutionIdentity(record: TurnExecutionRecord, input: CreateTurnExecutionInput): boolean {
  return serializeTurnExecutionIdentity(record) === serializeTurnExecutionIdentity(input);
}
