import { parseWatcherSessionState, type WatcherSurfaceRetirement } from '@cat-cafe/shared';
import { callbackAuthDispositionFromTurnExecution } from '../../../cats/services/agents/invocation/CallbackAuthTurnExecutionProjection.js';
import { saveWatcherState } from '../watcher-checkpoint.js';
import { finalizeWatcherWake } from '../watcher-finalization.js';
import type { WatcherInvocationOwners } from '../watcher-invocation-contract.js';
import { SURFACE_CHANGED, saveWatcherRetirement } from './watcher-retirement-state.js';

/** Called only under the same native owner that just supplied positive idle proof. */
export async function publishWatcherRetirement(
  owners: WatcherInvocationOwners,
  sessionId: string,
  operation: WatcherSurfaceRetirement,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const session = await owners.sessions.get(sessionId);
  if (
    !session ||
    session.cliSessionId !== operation.nativeCliSessionId ||
    session.watcherRetirement?.id !== operation.id
  )
    throw new Error('watcher_retirement_binding_mismatch');
  const ready = await saveWatcherRetirement(owners, session, {
    ...session.watcherRetirement,
    phase: 'idle',
    lastFailure: undefined,
  });
  const successor = await owners.sessions.rolloverWatcherSession({
    sessionId: ready.id,
    expectedRevision: parseWatcherSessionState(ready.watcherState).revision,
    expectedCliSessionId: ready.cliSessionId,
    expectedNativeSessionBinding: ready.nativeSessionBinding,
    retirementId: operation.id,
  });
  if (!successor) throw new Error('watcher_retirement_owner_changed');
}

/** Idempotent Host settlement never owns a raw cursor advance; a genuine checkpoint does. */
export async function settleWatcherRetirementHost(
  owners: WatcherInvocationOwners,
  sessionId: string,
  operation: WatcherSurfaceRetirement,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const session = await owners.sessions.get(sessionId);
  if (!session) throw new Error('watcher_retirement_session_missing');
  let state = parseWatcherSessionState(session.watcherState);
  if (state.attempt?.phase === 'finalize_pending') state = await finalizeWatcherWake(owners, session, state);
  const latest = await owners.executions.get(operation.wakeInvocationId);
  if (!latest) throw new Error('watcher_retirement_execution_missing');
  // A real completed checkpoint retains its original outcome. No schema failure can invent one.
  const terminal = await owners.executions.transitionTerminal(operation.wakeInvocationId, {
    status: latest.status === 'running' ? 'failed' : latest.status,
    endedAt: latest.endedAt ?? Date.now(),
    terminalReason: latest.terminalReason ?? SURFACE_CHANGED,
    providerTeardownAt: latest.providerTeardownAt ?? Date.now(),
  });
  if (!terminal.record || terminal.record.status === 'running') throw new Error('watcher_retirement_not_finalized');
  const closed = await owners.registry.peekRecord(operation.wakeInvocationId);
  if (closed && closed.state !== callbackAuthDispositionFromTurnExecution(terminal.record))
    throw new Error('watcher_retirement_auth_not_finalized');
  const response = await owners.executions.markResponseSettled(
    operation.wakeInvocationId,
    terminal.record.responseSettlement ?? { kind: 'no_response', reason: 'tool_only', settledAt: Date.now() },
  );
  if (response.outcome !== 'settled' && response.outcome !== 'replayed')
    throw new Error('watcher_retirement_response_not_finalized');
  // This changes no raw cursor or notes. Genuine checkpoint/prune above owns any legitimate progress.
  if (state.attempt || state.wakeInvocationId)
    await saveWatcherState(owners.sessions, session.id, state, {
      attempt: undefined,
      wakeInvocationId: undefined,
      rawWindowTokens: undefined,
      directoryReads: undefined,
      skippedWindows: undefined,
    });
}
