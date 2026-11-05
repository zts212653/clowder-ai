import { parseWatcherSessionState, type SessionRecord, type TurnExecutionRecord } from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../../cats/services/session/session-scope.js';
import { type FinalizationOwners, finalizeWatcherWake, finishIdleWatcherWake } from './watcher-finalization.js';
import { settleWatcherStartupFailure } from './watcher-startup-failure.js';

export type WatcherRecoveryOwners = FinalizationOwners & {
  recoverNative(session: SessionRecord, source: TurnExecutionRecord): Promise<void> | void;
};

/** Original execution indexes cover admission; the Session owner retains discovery until its final marker clears. */
export async function reconcileWatcherRecovery(
  owners: WatcherRecoveryOwners,
  userId: string,
  report: (error: unknown, threadId?: string) => void,
  activeThreads: ReadonlySet<string> = new Set(),
): Promise<void> {
  const records = [
    ...(await owners.executions.listRunningByUser(userId)),
    ...(await owners.executions.listResponsePending()),
  ];
  const sessions = await owners.sessions.listPendingWatcherSessions(userId);
  const pending = new Map<string, SessionRecord>();
  for (const session of sessions) {
    const state = parseWatcherSessionState(session.watcherState);
    const id = state.attempt?.invocationId ?? state.wakeInvocationId;
    if (!id) continue;
    pending.set(id, session);
    const record = await owners.executions.get(id);
    if (record) records.push(record);
    else report(new Error('watcher_recovery_execution_missing'), session.threadId);
  }
  const seen = new Set<string>();
  for (const execution of records) {
    if (
      execution.userId !== userId ||
      execution.executionKind !== 'watcher' ||
      activeThreads.has(execution.threadId) ||
      seen.has(execution.invocationId)
    )
      continue;
    seen.add(execution.invocationId);
    try {
      const session =
        pending.get(execution.invocationId) ??
        (await owners.sessions.getByChainKey(watcherSessionChainKey(userId, execution.catId, execution.threadId)));
      if (!session) throw new Error('watcher_recovery_session_missing');
      if (
        session.sessionPurpose !== 'watcher' ||
        session.userId !== userId ||
        session.threadId !== execution.threadId ||
        session.catId !== execution.catId
      )
        throw new Error('watcher_recovery_session_mismatch');
      const state = parseWatcherSessionState(session.watcherState);
      if (state.attempt?.phase === 'finalize_pending' && state.attempt.invocationId === execution.invocationId) {
        await finalizeWatcherWake(owners, session, state);
        continue;
      }
      const sourceId = execution.causal?.watcherSourceInvocationId;
      const source = sourceId ? await owners.executions.get(sourceId) : null;
      if (
        !source ||
        source.userId !== userId ||
        source.threadId !== execution.threadId ||
        source.executionKind !== 'ordinary' ||
        !source.responseSettlement ||
        !source.settledSequence
      )
        throw new Error('watcher_recovery_source_missing');
      if (state.attempt && state.attempt.invocationId !== execution.invocationId) {
        if (execution.providerStartedAt !== undefined) throw new Error('watcher_recovery_attempt_changed');
        await finishIdleWatcherWake(owners, session, source);
        continue;
      }
      if (!(await settleWatcherStartupFailure(owners, session, source))) await owners.recoverNative(session, source);
    } catch (error) {
      report(error, execution.threadId);
    }
  }
}
