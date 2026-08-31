import type { LifecycleAppendAction, LifecycleAppendExpectedRun } from '@cat-cafe/shared';
import type { QueueEntry } from './InvocationQueue.js';
import { isSystemPinnedQueueEntry } from './InvocationQueue.js';
import type { InvocationTrackerLike } from './live-invocation-projection.js';

export type LifecycleAppendProjection =
  | { readonly available: true; readonly action: LifecycleAppendAction }
  | {
      readonly available: false;
      readonly reason:
        | 'entry_ineligible'
        | 'target_missing'
        | 'active_run_missing'
        | 'client_unsupported'
        | 'owner_mismatch';
    };

export function projectLifecycleAppendAction(input: {
  readonly threadId: string;
  readonly userId: string;
  readonly queueRevision: string;
  readonly entry: QueueEntry;
  readonly invocationTracker: InvocationTrackerLike;
}): LifecycleAppendProjection {
  const { entry, invocationTracker } = input;
  if (
    entry.status !== 'queued' ||
    entry.kind === 'private_input' ||
    entry.exactSteerBatch ||
    entry.queueCustodyAdmissionId ||
    isSystemPinnedQueueEntry(entry)
  ) {
    return { available: false, reason: 'entry_ineligible' };
  }
  if (entry.targetCats.length === 0) return { available: false, reason: 'target_missing' };

  const activeRunByTarget = new Map(
    invocationTracker
      .getActiveSlots(input.threadId)
      .flatMap((slot) => (slot.activeRun ? [[slot.catId, slot.activeRun] as const] : [])),
  );
  const expectedRuns: LifecycleAppendExpectedRun[] = [];
  for (const targetId of entry.targetCats) {
    if (invocationTracker.getUserId(input.threadId, targetId) !== input.userId) {
      return { available: false, reason: 'owner_mismatch' };
    }
    const activeRun = activeRunByTarget.get(targetId);
    if (!activeRun || activeRun.threadId !== input.threadId || activeRun.targetId !== targetId) {
      return { available: false, reason: 'active_run_missing' };
    }
    const dispatcher = invocationTracker.getAgentClientActiveRunDispatcher?.(input.threadId, targetId);
    if (!dispatcher || dispatcher.invocationId !== activeRun.invocationId || dispatcher.capabilities.append !== true) {
      return { available: false, reason: 'client_unsupported' };
    }
    expectedRuns.push({
      targetId,
      invocationId: activeRun.invocationId,
      responseMessageId: activeRun.responseMessageId,
    });
  }
  return {
    available: true,
    action: {
      kind: 'append',
      expectedQueueRevision: input.queueRevision,
      expectedRuns,
    },
  };
}
