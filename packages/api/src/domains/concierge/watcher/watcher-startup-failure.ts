import { parseWatcherSessionState, type SessionRecord, type TurnExecutionRecord } from '@cat-cafe/shared';
import { callbackAuthDispositionFromTurnExecution } from '../../cats/services/agents/invocation/CallbackAuthTurnExecutionProjection.js';
import { saveWatcherState } from './watcher-checkpoint.js';
import type { FinalizationOwners } from './watcher-finalization.js';

/** No thread binding means beforeTurn could never admit a native turn. A started provider still needs its exit fact. */
export async function settleWatcherStartupFailure(
  owners: FinalizationOwners,
  session: SessionRecord,
  source: TurnExecutionRecord,
): Promise<boolean> {
  if (session.cliSessionId || session.nativeSessionBinding) return false;
  const state = parseWatcherSessionState(session.watcherState);
  const attempt = state.attempt;
  if (!attempt || attempt.phase !== 'failed' || attempt.nativeTurnId) return false;
  const execution = await owners.executions.get(attempt.invocationId);
  if (
    !execution ||
    execution.executionKind !== 'watcher' ||
    execution.userId !== session.userId ||
    execution.threadId !== session.threadId ||
    execution.catId !== session.catId ||
    execution.causal?.watcherSourceInvocationId !== source.invocationId ||
    attempt.sourceInvocationId !== source.invocationId ||
    Object.keys(execution.watcherModelAttempts ?? {}).length > 0 ||
    (execution.providerStartedAt !== undefined &&
      (execution.providerTeardownAt === undefined || execution.providerTeardownAt < execution.providerStartedAt))
  )
    return false;
  const terminal = await owners.executions.transitionTerminal(execution.invocationId, {
    status: execution.status === 'running' ? 'failed' : execution.status,
    endedAt: execution.endedAt ?? Date.now(),
    terminalReason: execution.terminalReason ?? 'watcher_provider_startup_failed',
    ...(execution.providerTeardownAt !== undefined ? { providerTeardownAt: execution.providerTeardownAt } : {}),
  });
  if (!terminal.record || terminal.record.status === 'running')
    throw new Error('watcher_startup_failure_not_finalized');
  const auth = await owners.registry.peekRecord(execution.invocationId);
  if (auth && auth.state !== callbackAuthDispositionFromTurnExecution(terminal.record))
    throw new Error('watcher_startup_auth_not_finalized');
  const settled = await owners.executions.markResponseSettled(
    execution.invocationId,
    terminal.record.responseSettlement ?? { kind: 'no_response', reason: 'tool_only', settledAt: Date.now() },
  );
  if (settled.outcome !== 'settled' && settled.outcome !== 'replayed')
    throw new Error('watcher_startup_response_not_finalized');
  await saveWatcherState(owners.sessions, session.id, state, { attempt: undefined, wakeInvocationId: undefined });
  return true;
}
