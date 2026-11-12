import {
  parseWatcherSessionState,
  type SessionRecord,
  type WatcherSessionState,
  type WatcherUsage,
  watcherCheckpointSchema,
} from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import { asCodexAppServerRecord } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { CodexAppServerNativeRpcClient } from '../../cats/services/agents/providers/CodexAppServerNativeRpc.js';
import type { TranscriptWriter } from '../../cats/services/session/TranscriptWriter.js';
import type { ISessionChainStore } from '../../cats/services/stores/ports/SessionChainStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import {
  WATCHER_RECOVERY_DEADLINE_EXCEEDED,
  WATCHER_RECOVERY_TOOL_BUDGET_EXHAUSTED,
  type WatcherWindow,
  watcherBudgetFailure,
  watcherBudgetRecovery,
} from './context/watcher-budget-progress.js';
import type { WatcherInvocationOwners, WatcherRunState } from './watcher-invocation-contract.js';

export interface WatcherCheckpointOwners {
  sessions: ISessionChainStore;
  executions: ITurnExecutionStore;
  transcript: Pick<TranscriptWriter, 'appendDurableEvent'>;
}
export async function saveWatcherState(
  sessions: ISessionChainStore,
  id: string,
  current: WatcherSessionState,
  changes: Partial<WatcherSessionState>,
): Promise<WatcherSessionState> {
  const next = parseWatcherSessionState({ ...current, ...changes, revision: current.revision + 1 });
  const saved = await sessions.compareAndSetWatcherState(id, current.revision, next);
  if (!saved) throw new Error('watcher_session_changed');
  return saved;
}

/** Preserve the original bounded failure cause even when native interruption has no error payload. */
export async function failWatcherAttempt(
  owners: WatcherInvocationOwners,
  run: WatcherRunState,
  invocationId: string,
  error: unknown,
  abort: AbortSignal,
): Promise<unknown> {
  const diagnosticReason = (value: unknown) => (value instanceof Error ? value.message : String(value)).slice(0, 500);
  let cause = error;
  let origin = 'provider';
  let boundaryCause: unknown;
  try {
    run.boundary?.assertHealthy();
  } catch (boundaryError) {
    boundaryCause = boundaryError;
    cause = boundaryError;
    origin = 'request_boundary';
  }
  if (error instanceof Error && error.message === 'watcher_native_still_active') {
    // A late control/deadline signal is no proof that this prior native turn stopped.
    cause = error;
    origin = 'native_proof';
  } else if (abort.aborted) {
    cause = abort.reason;
    origin = 'local_abort';
    try {
      // Neither time nor tickets can be restored by shrinking again after this wake's proven budget recovery.
      if (
        cause instanceof Error &&
        run.state.wakeInvocationId === invocationId &&
        run.state.rawWindowTokens !== undefined
      ) {
        if (cause.message === 'watcher_deadline_exceeded') cause = new Error(WATCHER_RECOVERY_DEADLINE_EXCEEDED);
        else if (
          cause.message === 'watcher_repeated_tool_budget_denial' &&
          (await owners.registry.watcherToolCallCount(invocationId)) >= 6
        )
          cause = new Error(WATCHER_RECOVERY_TOOL_BUDGET_EXHAUSTED);
      }
    } catch {
      // An unavailable counter cannot prove exhaustion or replace the original local cause.
    }
    if (
      abort.reason instanceof Error &&
      ['watcher_deadline_exceeded', 'watcher_repeated_tool_budget_denial'].includes(abort.reason.message) &&
      !watcherBudgetFailure(cause) &&
      watcherBudgetFailure(boundaryCause)
    ) {
      // A real first budget refusal is not a transport symptom of cancellation.
      cause = boundaryCause;
      origin = 'request_boundary';
    }
  }
  const { session } = run;
  const failure = diagnosticReason(cause);
  await owners.transcript
    .appendDurableEvent(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        seq: session.seq,
        cliSessionId: session.cliSessionId,
      },
      {
        type: 'watcher_attempt_failure',
        reason: failure,
        origin,
        ...(boundaryCause !== undefined ? { boundaryReason: diagnosticReason(boundaryCause) } : {}),
        ...(abort.aborted ? { abortReason: diagnosticReason(abort.reason) } : {}),
      },
      invocationId,
    )
    .catch(() => undefined);
  try {
    const state = parseWatcherSessionState((await owners.sessions.get(session.id))?.watcherState);
    if (state.attempt?.invocationId === invocationId && ['running', 'failed'].includes(state.attempt.phase))
      await saveWatcherState(owners.sessions, session.id, state, {
        attempt: {
          ...state.attempt,
          phase: 'failed',
          // A failed probe has not consumed the pending recovery decision. Diagnostics remain above.
          failure:
            watcherBudgetFailure(state.attempt.failure) && !watcherBudgetFailure(failure)
              ? state.attempt.failure
              : failure,
        },
      });
  } catch {
    // Failure-state persistence is best effort; the caller must still receive the original failure.
  }
  return cause;
}

export async function nativeWatcherTurn(client: CodexAppServerNativeRpcClient, nativeThreadId: string, turnId: string) {
  const read = asCodexAppServerRecord(
    await client.request('thread/read', { threadId: nativeThreadId, includeTurns: true }),
  );
  const thread = asCodexAppServerRecord(read?.thread);
  if (thread?.id !== nativeThreadId || !Array.isArray(thread.turns))
    throw new Error('watcher_native_history_unavailable');
  return thread.turns.map(asCodexAppServerRecord).find((turn) => turn?.id === turnId) ?? null;
}

export function nativeWatcherCheckpoint(turn: Record<string, unknown>) {
  if (turn.status !== 'completed' || !Array.isArray(turn.items)) throw new Error('watcher_checkpoint_not_completed');
  const candidates = turn.items
    .map(asCodexAppServerRecord)
    .filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string');
  const final = candidates.filter((item) => item?.phase === 'final').at(-1) ?? candidates.at(-1);
  if (typeof final?.text !== 'string') throw new Error('watcher_checkpoint_missing');
  return watcherCheckpointSchema.parse(JSON.parse(final.text));
}

/** A committed checkpoint owns its native prune. Missing after a crash means the same prune already happened. */
export async function finishWatcherPrune(
  owners: WatcherCheckpointOwners,
  session: SessionRecord,
  state: WatcherSessionState,
  client: CodexAppServerNativeRpcClient,
): Promise<WatcherSessionState> {
  if (state.attempt?.phase !== 'prune_pending' || !state.attempt.nativeTurnId || !session.cliSessionId)
    throw new Error('watcher_prune_binding_missing');
  const turn = await nativeWatcherTurn(client, session.cliSessionId, state.attempt.nativeTurnId);
  if (turn) {
    if (turn.status !== 'completed') throw new Error('watcher_native_still_active');
    await client.request('thread/revert', { threadId: session.cliSessionId, beforeTurnId: state.attempt.nativeTurnId });
  }
  return saveWatcherState(owners.sessions, session.id, state, {
    // A complete source still owns execution/auth settlement after its native history is gone.
    // Partial windows retain the wake principal but admit their next native window.
    ...(state.afterSequence >= state.attempt.sourceSequence
      ? {
          wakeInvocationId: state.attempt.invocationId,
          attempt: { ...state.attempt, phase: 'finalize_pending', prunedAt: Date.now() },
        }
      : { attempt: undefined }),
  });
}

/** Usage and the original provider checkpoint are durable before the only cursor advance. */
export async function commitWatcherCheckpoint(
  owners: WatcherCheckpointOwners,
  session: SessionRecord,
  state: WatcherSessionState,
  client: CodexAppServerNativeRpcClient,
  usage: WatcherUsage,
): Promise<WatcherSessionState> {
  const attempt = state.attempt;
  if (!attempt?.nativeTurnId || !attempt.window || !session.cliSessionId)
    throw new Error('watcher_checkpoint_binding_missing');
  const turn = await nativeWatcherTurn(client, session.cliSessionId, attempt.nativeTurnId);
  if (!turn) throw new Error('watcher_uncommitted_native_turn_missing');
  const checkpoint = nativeWatcherCheckpoint(turn);
  if (
    checkpoint.consumedThrough !== `${attempt.window.frontier}:${attempt.window.offset}` ||
    estimateTokens(checkpoint.notes) > 2000
  )
    throw new Error('watcher_checkpoint_window_or_notes_invalid');
  const existingUsage = (await owners.executions.get(attempt.invocationId))?.watcherUsage;
  if (!existingUsage && !(await owners.executions.recordWatcherUsage(attempt.invocationId, usage)))
    throw new Error('watcher_usage_not_durable');
  await owners.transcript.appendDurableEvent(
    {
      sessionId: session.id,
      threadId: session.threadId,
      catId: session.catId,
      cliSessionId: session.cliSessionId,
      seq: session.seq,
    },
    { type: 'watcher_checkpoint', checkpoint, nativeTurnId: attempt.nativeTurnId },
    attempt.invocationId,
  );
  const committed = await saveWatcherState(owners.sessions, session.id, state, {
    notes: checkpoint.notes,
    consumedThrough:
      attempt.window.complete !== false && attempt.window.resumeCursor
        ? attempt.window.resumeCursor.messageId
        : attempt.window.frontier || state.consumedThrough,
    messageOffset:
      attempt.window.complete !== false && attempt.window.resumeCursor
        ? attempt.window.resumeCursor.offset
        : attempt.window.offset,
    backfillAfter: attempt.window.complete === false ? attempt.window.resumeCursor : undefined,
    afterSequence: attempt.window.complete === false ? state.afterSequence : attempt.sourceSequence,
    attempt: { ...attempt, phase: 'prune_pending', checkpoint },
  });
  return finishWatcherPrune(owners, session, committed, client);
}

/** Resume the exact role thread before deciding whether the prior attempt committed. No unseen input is acknowledged. */
export async function recoverWatcherAttempt(
  owners: WatcherCheckpointOwners,
  session: SessionRecord,
  state: WatcherSessionState,
  client: CodexAppServerNativeRpcClient,
  allowRetry = true,
  retryWindow?: WatcherWindow,
  terminalReason = 'watcher_checkpoint_retry_exhausted',
): Promise<WatcherSessionState> {
  if (!state.attempt || !session.cliSessionId) throw new Error('watcher_recovery_binding_missing');
  if (watcherBudgetFailure(state.attempt.failure)) {
    const execution = await owners.executions.get(state.attempt.invocationId);
    if (
      execution?.executionKind !== 'watcher' ||
      execution.userId !== session.userId ||
      execution.threadId !== session.threadId ||
      execution.catId !== session.catId ||
      execution.causal?.watcherSourceInvocationId !== state.attempt.sourceInvocationId
    )
      throw new Error('watcher_budget_recovery_binding_mismatch');
  }
  if (state.attempt.phase === 'finalize_pending') return state;
  if (state.attempt.phase === 'prune_pending') return finishWatcherPrune(owners, session, state, client);
  let attempt = state.attempt;
  if (!attempt.nativeTurnId) {
    const read = asCodexAppServerRecord(
      await client.request('thread/read', { threadId: session.cliSessionId, includeTurns: true }),
    );
    const thread = asCodexAppServerRecord(read?.thread);
    if (thread?.id !== session.cliSessionId || !Array.isArray(thread.turns))
      throw new Error('watcher_native_history_unavailable');
    const turns = thread.turns
      .map(asCodexAppServerRecord)
      .filter((turn): turn is Record<string, unknown> => turn !== null);
    const matched = turns.filter((turn) =>
      JSON.stringify(turn.items).includes(`watcherAttemptId=${attempt.invocationId}`),
    );
    if (matched.length > 1 || (matched.length === 0 && turns.length > 0))
      throw new Error('watcher_unowned_native_turn');
    if (typeof matched[0]?.id === 'string') {
      state = await saveWatcherState(owners.sessions, session.id, state, {
        attempt: { ...attempt, nativeTurnId: matched[0].id },
      });
      attempt = state.attempt!;
    }
  }
  const turn = attempt.nativeTurnId
    ? await nativeWatcherTurn(client, session.cliSessionId, attempt.nativeTurnId)
    : null;
  if (turn && !['completed', 'interrupted', 'failed'].includes(String(turn.status)))
    throw new Error('watcher_native_still_active');
  let validCheckpoint = false;
  if (turn?.status === 'completed' && attempt.window) {
    try {
      const checkpoint = nativeWatcherCheckpoint(turn);
      validCheckpoint =
        checkpoint.consumedThrough === `${attempt.window.frontier}:${attempt.window.offset}` &&
        estimateTokens(checkpoint.notes) <= 2000;
    } catch {
      /* A malformed final output did not commit a checkpoint. */
    }
  }
  if (validCheckpoint)
    return commitWatcherCheckpoint(
      owners,
      session,
      state,
      client,
      (await owners.executions.get(attempt.invocationId))?.watcherUsage ?? { reportedAt: attempt.startedAt },
    );
  await owners.transcript.appendDurableEvent(
    {
      sessionId: session.id,
      threadId: session.threadId,
      catId: session.catId,
      cliSessionId: session.cliSessionId,
      seq: session.seq,
    },
    {
      type: 'watcher_attempt_recovery',
      nativeTurnId: attempt.nativeTurnId,
      sourceInvocationId: attempt.sourceInvocationId,
      reason: turn ? 'idle_uncommitted_turn_recovered_with_same_budget' : 'uncommitted_turn_absent',
    },
    attempt.invocationId,
  );
  if (turn)
    await client.request('thread/revert', { threadId: session.cliSessionId, beforeTurnId: attempt.nativeTurnId });
  if (allowRetry && watcherBudgetFailure(attempt.failure))
    return saveWatcherState(
      owners.sessions,
      session.id,
      state,
      await watcherBudgetRecovery(owners, session, state, retryWindow),
    );
  if (!allowRetry || (attempt.retries ?? 0) >= 1) {
    await owners.executions.transitionTerminal(attempt.invocationId, {
      status: 'failed',
      endedAt: Date.now(),
      terminalReason,
      providerTeardownAt: Date.now(),
    });
    await owners.executions.markResponseSettled(attempt.invocationId, {
      kind: 'no_response',
      reason: 'tool_only',
      settledAt: Date.now(),
    });
    return saveWatcherState(owners.sessions, session.id, state, { attempt: undefined, wakeInvocationId: undefined });
  }
  return saveWatcherState(owners.sessions, session.id, state, {
    attempt: { ...attempt, nativeTurnId: undefined, phase: 'running', retries: (attempt.retries ?? 0) + 1 },
  });
}
