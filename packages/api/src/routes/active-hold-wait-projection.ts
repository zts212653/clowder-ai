import type { ActiveHoldWaitProjection } from '@cat-cafe/shared';
import type { PendingHoldWait } from '../domains/ball-custody/hold-wait-projection.js';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';

/**
 * Held balls → the `waits` list beside active executions.
 *
 * Same boundaries as the managed-command rows: thread access decides who may SEE a hold (threadById only holds
 * threads this viewer can read); the trigger principal decides who may CANCEL it. The real task id resolves at
 * `DELETE /api/callbacks/hold-ball/:taskId`, so a foreign row carries a stable, unresolvable occupancy id instead.
 */
export function projectHoldWaits(
  holds: readonly PendingHoldWait[],
  userId: string,
  threadById: ReadonlyMap<string, Thread>,
  includeProjectPath: boolean,
): ActiveHoldWaitProjection[] {
  const waits: ActiveHoldWaitProjection[] = [];
  for (const hold of holds) {
    const thread = threadById.get(hold.threadId);
    if (!thread) continue;
    const ownedByViewer = hold.userId === userId;
    waits.push({
      waitId: ownedByViewer ? hold.taskId : `occupied:${thread.id}:${hold.catId}:${hold.since}`,
      threadId: thread.id,
      threadTitle: thread.title,
      ...(includeProjectPath ? { projectPath: thread.projectPath } : {}),
      catId: hold.catId,
      since: hold.since,
      wakeAt: hold.wakeAt,
      cancelability: ownedByViewer
        ? { state: 'cancelable', target: { kind: 'hold_ball', taskId: hold.taskId } }
        : { state: 'not_cancelable', reason: 'foreign_principal' },
    });
  }
  return waits.sort(
    (left, right) =>
      left.wakeAt - right.wakeAt ||
      left.threadId.localeCompare(right.threadId) ||
      left.catId.localeCompare(right.catId),
  );
}
