import type { CatId } from '@cat-cafe/shared';
import type { QueuedMessageCustody } from '../../stores/ports/MessageStore.js';
import { markReminderAttemptMissed, markReminderAttemptSeen } from '../../stores/ports/queued-message-receipt.js';

export function uniqueCatIds(values: readonly string[]): CatId[] {
  return [...new Set(values.filter(Boolean))] as CatId[];
}

function activeProjection(custody: QueuedMessageCustody): Omit<QueuedMessageCustody, 'revision' | 'updatedAt'> {
  const { revision: _revision, updatedAt: _updatedAt, ...projection } = custody;
  return projection;
}

export function sameActiveProjection(left: QueuedMessageCustody, right: QueuedMessageCustody): boolean {
  return JSON.stringify(activeProjection(left)) === JSON.stringify(activeProjection(right));
}

function reminderBelongsToLiveTarget(
  current: QueuedMessageCustody,
  targetCatIds: ReadonlySet<string>,
  targetCatId: string,
  invocationId: string,
): boolean {
  if (!targetCatIds.has(targetCatId)) return false;
  const liveInvocationId =
    current.awakenedInvocationIdByCatId?.[targetCatId] ?? current.seenInvocationIdByCatId[targetCatId];
  return liveInvocationId === invocationId;
}

export function resolveRestartReminderAttempts(
  current: QueuedMessageCustody,
  now: number,
  liveTargetCatIds: ReadonlySet<string> = new Set(),
): QueuedMessageCustody {
  let projection = current;
  for (const attempt of current.reminderAttempts ?? []) {
    if (attempt.state !== 'requested' && attempt.state !== 'delivered') continue;
    if (reminderBelongsToLiveTarget(current, liveTargetCatIds, attempt.targetCatId, attempt.invocationId)) {
      continue;
    }
    projection =
      current.seenInvocationIdByCatId[attempt.targetCatId] === attempt.invocationId
        ? markReminderAttemptSeen(projection, attempt.targetCatId, attempt.invocationId, now)
        : markReminderAttemptMissed(projection, attempt.invocationId, now);
  }
  return projection;
}
