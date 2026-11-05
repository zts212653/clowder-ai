import type { SessionRecord, TurnExecutionRecord } from '@cat-cafe/shared';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';

export const watcherSourceParent = (catId: string, sourceId: string) => `watcher-source:${catId}:${sourceId}`;

/** Source ownership survives the cut between execution admission and the Session attempt CAS. */
export async function watcherSourceExecution(
  executions: ITurnExecutionStore,
  session: SessionRecord,
  source: TurnExecutionRecord,
): Promise<TurnExecutionRecord | undefined> {
  const records = (await executions.listByParent(watcherSourceParent(session.catId, source.invocationId))).filter(
    (record) =>
      record.executionKind === 'watcher' &&
      record.userId === session.userId &&
      record.threadId === session.threadId &&
      record.catId === session.catId &&
      record.causal?.watcherSourceInvocationId === source.invocationId,
  );
  if (records.length > 1) throw new Error('watcher_source_execution_ambiguous');
  return records[0];
}

export async function watcherSourceFinished(
  executions: ITurnExecutionStore,
  catId: string,
  sourceId: string,
): Promise<boolean> {
  const outcomes = await executions.listByParent(watcherSourceParent(catId, sourceId));
  return outcomes.some(
    (record) => record.executionKind === 'watcher' && record.catId === catId && record.status !== 'running',
  );
}

/** Failure is a source-specific observation result, not an acknowledgement of its unread original text. */
export async function recordWatcherSourceFailure(
  executions: ITurnExecutionStore,
  catId: TurnExecutionRecord['catId'],
  source: TurnExecutionRecord,
  error: unknown,
): Promise<void> {
  const parentInvocationId = watcherSourceParent(catId, source.invocationId);
  const existing = (await executions.listByParent(parentInvocationId)).find(
    (record) => record.executionKind === 'watcher' && record.catId === catId,
  );
  const id = existing?.invocationId ?? `watcher-failed:${catId}:${source.invocationId}`;
  if (!existing)
    await executions.createRunning({
      invocationId: id,
      parentInvocationId,
      userId: source.userId,
      threadId: source.threadId,
      catId,
      executionKind: 'watcher',
      startedAt: Date.now(),
      causal: { watcherSourceInvocationId: source.invocationId },
    });
  await executions.transitionTerminal(id, {
    status: 'failed',
    endedAt: Date.now(),
    terminalReason: `watcher_source_failure:${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
  });
  await executions.markResponseSettled(id, { kind: 'no_response', reason: 'tool_only', settledAt: Date.now() });
}
