import type {
  LifecycleActiveRun,
  LifecycleAppendAction,
  LifecycleAppendCapability,
  LifecycleAppendExpectedRun,
} from '@cat-cafe/shared';
import type { QueueEntry } from './InvocationQueue.js';
import { isSystemPinnedQueueEntry, queueEntryTargetCats } from './InvocationQueue.js';
import type { InvocationTrackerLike } from './live-invocation-projection.js';

type LifecycleAppendTracker = Pick<
  InvocationTrackerLike,
  'getActiveSlots' | 'getUserId' | 'getAgentClientActiveRunDispatcher'
>;

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

export type LifecycleAppendCapabilityProjection =
  | { readonly available: true; readonly capability: LifecycleAppendCapability }
  | {
      readonly available: false;
      readonly reason: 'active_run_missing' | 'client_unsupported' | 'owner_mismatch';
    };

/**
 * Project the live, request-owned capability for one target. This is the only
 * source for pre-admission Append affordances; carrier type and local liveness
 * are intentionally insufficient.
 */
export function projectLifecycleAppendCapability(input: {
  readonly threadId: string;
  readonly userId: string;
  readonly targetId: string;
  readonly activeRun?: LifecycleActiveRun;
  readonly invocationTracker: LifecycleAppendTracker;
}): LifecycleAppendCapabilityProjection {
  if (input.invocationTracker.getUserId(input.threadId, input.targetId) !== input.userId) {
    return { available: false, reason: 'owner_mismatch' };
  }
  const activeRun = input.activeRun;
  if (!activeRun || activeRun.threadId !== input.threadId || activeRun.targetId !== input.targetId) {
    return { available: false, reason: 'active_run_missing' };
  }
  const dispatcher = input.invocationTracker.getAgentClientActiveRunDispatcher?.(input.threadId, input.targetId);
  if (!dispatcher || dispatcher.invocationId !== activeRun.invocationId || dispatcher.capabilities.append !== true) {
    return { available: false, reason: 'client_unsupported' };
  }
  return {
    available: true,
    capability: {
      kind: 'append',
      expectedRun: {
        targetId: input.targetId,
        invocationId: activeRun.invocationId,
        responseMessageId: activeRun.responseMessageId,
      },
    },
  };
}

export function projectLifecycleAppendAction(input: {
  readonly threadId: string;
  readonly userId: string;
  readonly queueRevision: string;
  readonly entry: QueueEntry;
  readonly invocationTracker: LifecycleAppendTracker;
}): LifecycleAppendProjection {
  const { entry, invocationTracker } = input;
  if (entry.status !== 'queued' || entry.kind === 'private_input' || isSystemPinnedQueueEntry(entry)) {
    return { available: false, reason: 'entry_ineligible' };
  }
  const targetCats = queueEntryTargetCats(entry);
  if (targetCats.length === 0) return { available: false, reason: 'target_missing' };

  const activeRunByTarget = new Map(
    invocationTracker
      .getActiveSlots(input.threadId)
      .flatMap((slot) => (slot.activeRun ? [[slot.catId, slot.activeRun] as const] : [])),
  );
  const expectedRuns: LifecycleAppendExpectedRun[] = [];
  for (const targetId of targetCats) {
    const capability = projectLifecycleAppendCapability({
      threadId: input.threadId,
      userId: input.userId,
      targetId,
      activeRun: activeRunByTarget.get(targetId),
      invocationTracker,
    });
    if (!capability.available) return capability;
    expectedRuns.push(capability.capability.expectedRun);
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
