import type { CatId } from './ids.js';

export type TurnExecutionKind = 'ordinary' | 'routing_guard';
export type TurnExecutionStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type TurnExecutionTerminalStatus = Exclude<TurnExecutionStatus, 'running'>;

export interface TurnExecutionCausalRefs {
  triggerMessageId?: string;
  routingGuardReason?: 'missing_routing_exit';
  /** Exact persisted message bodies present in this child's prompt. */
  coveredMessageIds?: string[];
}

/**
 * F117 KD-21: whether anyone but the child's own route commit may publish its streamed output.
 * Every child records its fence at creation: `open` when its dispatch carries no action fence, `gated`
 * when it does. Settlement (stop, restart, zombie reclaim, a thrown execution) keeps a gated draft
 * unpublished until the fence has `allowed` it, and never publishes a `rejected` output. A gated
 * fence only moves forward (gated → allowed → rejected); an open fence stays open.
 *
 * A record without the field was written before the fence existed. Settlement resolves its fence
 * from the parent invocation's action lease carrier, and withholds the draft when it cannot.
 */
export type TurnOutputFence = 'open' | 'gated' | 'allowed' | 'rejected';
export type TurnOutputFenceVerdict = Exclude<TurnOutputFence, 'open' | 'gated'>;

export interface CreateTurnExecutionInput {
  invocationId: string;
  parentInvocationId: string;
  threadId: string;
  userId: string;
  catId: CatId;
  executionKind: TurnExecutionKind;
  /** A long-lived carrier ending does not complete the sources it read. */
  queueCompletionPolicy?: 'explicit_source';
  startedAt: number;
  causal?: TurnExecutionCausalRefs;
  /**
   * Late-bound state outside the immutable identity. A child is created `open` or `gated`; the
   * store records an omitted fence as `open`.
   */
  outputFence?: TurnOutputFence;
}

export interface TurnExecutionRecord extends CreateTurnExecutionInput {
  status: TurnExecutionStatus;
  endedAt?: number;
  terminalReason?: string;
}

/** Immutable child identity safe to persist beside a visible message body. */
export interface TurnExecutionMessageProjection {
  invocationId: string;
  parentInvocationId: string;
  executionKind: TurnExecutionKind;
}

export interface TurnExecutionTerminalInput {
  status: TurnExecutionTerminalStatus;
  endedAt: number;
  terminalReason?: string;
}

export type CreateTurnExecutionOutcome = 'created' | 'replayed' | 'conflict';

export interface CreateTurnExecutionResult {
  outcome: CreateTurnExecutionOutcome;
  record: TurnExecutionRecord;
}

export type TransitionTurnExecutionOutcome = 'transitioned' | 'already_terminal' | 'not_found';

export interface TransitionTurnExecutionResult {
  outcome: TransitionTurnExecutionOutcome;
  record: TurnExecutionRecord | null;
}

export interface InterruptRunningTurnExecutionsInput {
  endedAt: number;
  terminalReason: string;
  /** Exact children with a presently live external process owner. */
  excludedInvocationIds?: string[];
}
