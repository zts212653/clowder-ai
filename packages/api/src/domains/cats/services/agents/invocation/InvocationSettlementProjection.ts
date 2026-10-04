import type { QueueInvocationSettlement, TurnExecutionRecord } from '@cat-cafe/shared';
import { getCliExecutionExit, isCliExecutionRunning } from '../../../../../utils/CliExecutionObservation.js';
import { getCodexChildLifecycle } from '../providers/CodexAppServerLifecycleRegistry.js';

/** Read-only lineage projection. It neither grants completion nor changes source receipts. */
export function projectInvocationSettlement(
  scope: { threadId: string; userId: string; catId: string; executionId: string; turnInvocationId: string },
  children: readonly TurnExecutionRecord[],
): QueueInvocationSettlement | undefined {
  const owned = children.filter(
    (child) =>
      child.parentInvocationId === scope.executionId &&
      child.threadId === scope.threadId &&
      child.userId === scope.userId &&
      child.catId === scope.catId,
  );
  const active = owned.find((child) => child.invocationId === scope.turnInvocationId);
  if (
    !active ||
    active.status !== 'running' ||
    (active.executionKind !== 'routing_guard' && active.executionKind !== 'freshness_supplement')
  )
    return undefined;
  const nativeOwner = { ...scope, invocationId: scope.turnInvocationId };
  if (getCliExecutionExit(nativeOwner)) return undefined;
  const protocol = getCodexChildLifecycle(scope.threadId, scope.catId, scope.executionId, scope.turnInvocationId);
  const protocolActive =
    protocol !== undefined && !['completed', 'interrupted', 'failed', 'closing', 'closed'].includes(protocol.stage);
  if (!protocolActive && !isCliExecutionRunning(nativeOwner)) return undefined;
  const completedTurnInvocationIds = owned
    .filter(
      (child) =>
        child.status === 'succeeded' &&
        child.endedAt !== undefined &&
        child.endedAt <= active.startedAt &&
        child.invocationId !== active.invocationId,
    )
    .map((child) => child.invocationId);
  return completedTurnInvocationIds.length
    ? { activeTurnInvocationId: active.invocationId, completedTurnInvocationIds }
    : undefined;
}
