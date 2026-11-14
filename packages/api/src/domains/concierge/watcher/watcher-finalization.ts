import {
  parseWatcherSessionState,
  type SessionRecord,
  type TurnExecutionRecord,
  type WatcherSessionState,
} from '@cat-cafe/shared';
import { callbackAuthDispositionFromTurnExecution } from '../../cats/services/agents/invocation/CallbackAuthTurnExecutionProjection.js';
import type { InvocationRegistry } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import { saveWatcherState, type WatcherCheckpointOwners } from './watcher-checkpoint.js';
import { watcherSourceExecution } from './watcher-source-result.js';

export type FinalizationOwners = Pick<WatcherCheckpointOwners, 'sessions' | 'executions'> & {
  registry: InvocationRegistry;
};

/** The exact completed native turn is pruned before this marker; it never retires an active turn by age. */
export async function finalizeWatcherWake(
  owners: FinalizationOwners,
  session: SessionRecord,
  state: WatcherSessionState,
): Promise<WatcherSessionState> {
  const attempt = state.attempt;
  if (
    session.sessionPurpose !== 'watcher' ||
    attempt?.phase !== 'finalize_pending' ||
    attempt.prunedAt === undefined ||
    state.afterSequence < attempt.sourceSequence
  )
    throw new Error('watcher_finalization_proof_missing');
  const execution = await owners.executions.get(attempt.invocationId);
  if (
    !execution ||
    execution.executionKind !== 'watcher' ||
    execution.userId !== session.userId ||
    execution.threadId !== session.threadId ||
    execution.catId !== session.catId ||
    execution.causal?.watcherSourceInvocationId !== attempt.sourceInvocationId
  )
    throw new Error('watcher_finalization_binding_mismatch');
  const terminal = await owners.executions.transitionTerminal(attempt.invocationId, {
    status: state.skippedWindows ? 'failed' : 'succeeded',
    endedAt: Date.now(),
    terminalReason: state.skippedWindows ? 'watcher_context_budget_skipped' : 'watcher_checkpoint_committed',
    providerTeardownAt: attempt.prunedAt,
  });
  if (!terminal.record || terminal.record.status === 'running') throw new Error('watcher_execution_not_finalized');
  // The existing lifecycle projects the canonical terminal into auth; do not erase its recovery owner early.
  const auth = await owners.registry.peekRecord(attempt.invocationId);
  if (auth && auth.state !== callbackAuthDispositionFromTurnExecution(terminal.record))
    throw new Error('watcher_auth_not_finalized');
  const settled = await owners.executions.markResponseSettled(
    attempt.invocationId,
    terminal.record.responseSettlement ?? { kind: 'no_response', reason: 'tool_only', settledAt: Date.now() },
  );
  if (settled.outcome !== 'settled' && settled.outcome !== 'replayed')
    throw new Error('watcher_response_not_finalized');
  return saveWatcherState(owners.sessions, session.id, state, {
    attempt: undefined,
    wakeInvocationId: undefined,
    rawWindowTokens: undefined,
    directoryReads: undefined,
    skippedWindows: undefined,
  });
}

/** No attempt means no new native turn was admitted; a previous window needs positive teardown evidence. */
export async function finishIdleWatcherWake(
  owners: FinalizationOwners,
  session: SessionRecord,
  source: TurnExecutionRecord,
): Promise<WatcherSessionState> {
  const state = parseWatcherSessionState((await owners.sessions.get(session.id))?.watcherState);
  const execution = await watcherSourceExecution(owners.executions, session, source);
  if (!execution) throw new Error('watcher_original_execution_missing');
  if (
    state.attempt?.invocationId === execution.invocationId ||
    (execution.providerStartedAt !== undefined && execution.providerTeardownAt === undefined)
  )
    throw new Error('watcher_idle_proof_missing');
  const terminal = await owners.executions.transitionTerminal(execution.invocationId, {
    status: 'interrupted',
    endedAt: Date.now(),
    terminalReason: 'watcher_unadmitted_or_idle_recovery',
    ...(execution.providerTeardownAt !== undefined ? { providerTeardownAt: execution.providerTeardownAt } : {}),
  });
  if (!terminal.record || terminal.record.status === 'running') throw new Error('watcher_execution_not_finalized');
  const auth = await owners.registry.peekRecord(execution.invocationId);
  if (auth && auth.state !== callbackAuthDispositionFromTurnExecution(terminal.record))
    throw new Error('watcher_auth_not_finalized');
  const settled = await owners.executions.markResponseSettled(
    execution.invocationId,
    terminal.record.responseSettlement ?? { kind: 'no_response', reason: 'tool_only', settledAt: Date.now() },
  );
  if (settled.outcome !== 'settled' && settled.outcome !== 'replayed')
    throw new Error('watcher_response_not_finalized');
  return state.wakeInvocationId === execution.invocationId
    ? saveWatcherState(owners.sessions, session.id, state, { wakeInvocationId: undefined })
    : state;
}
