import type { InvocationTrajectorySummary, SessionRecord } from '@cat-cafe/shared';
import type { ITurnExecutionStore } from '../stores/ports/TurnExecutionStore.js';

/** A provider done event is not proof that scoped transcript finalization succeeded. */
export async function resolveScopedSessionTrajectory(
  summary: InvocationTrajectorySummary,
  session: Pick<SessionRecord, 'scopedInvocation' | 'userId' | 'catId' | 'threadId'>,
  executions?: Pick<ITurnExecutionStore, 'get'>,
): Promise<InvocationTrajectorySummary> {
  if (!session.scopedInvocation) return summary;
  const record = await executions?.get(summary.invocationId);
  if (
    !record ||
    session.scopedInvocation.invocationId !== summary.invocationId ||
    record.userId !== session.userId ||
    record.threadId !== session.threadId ||
    record.catId !== session.catId
  ) {
    return { ...summary, status: 'error', terminalReason: 'collective_execution_identity_unproved' };
  }
  const status =
    record.status === 'succeeded'
      ? 'done'
      : record.status === 'failed'
        ? 'error'
        : record.status === 'canceled' || record.status === 'interrupted'
          ? 'cancelled'
          : 'running';
  const { endedAt: _providerEnded, terminalReason: _providerReason, ...providerFacts } = summary;
  return {
    ...providerFacts,
    status,
    startedAt: record.startedAt,
    durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
  };
}
