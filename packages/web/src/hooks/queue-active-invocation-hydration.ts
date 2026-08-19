import type { FreshnessCarrierCapability } from '@cat-cafe/shared';
import type { AppServerLifecycleSnapshot } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { resumeInvocationReconciliationAfterHydration } from './invocation-timeout-reconciliation';

/** Canonical `/queue` liveness shape shared by initial hydration and reconnect repair. */
export interface QueueActiveInvocationSlot {
  catId: string;
  startedAt: number;
  executionId?: string;
  turnInvocationId?: string;
  appServerLifecycle?: AppServerLifecycleSnapshot;
  freshnessCarrierCapability?: FreshnessCarrierCapability;
}

function statusForHydratedAppServerLifecycle(lifecycle: AppServerLifecycleSnapshot | undefined) {
  switch (lifecycle?.stage) {
    case 'child_spawned':
    case 'initialized':
    case 'thread_ready':
      return 'spawning' as const;
    case 'failed':
      return 'error' as const;
    case 'completed':
    case 'interrupted':
      return 'done' as const;
    default:
      return 'streaming' as const;
  }
}

/**
 * Replace local active slots with one authoritative `/queue` liveness projection.
 *
 * The parent execution id remains the control/Cancel key. The child turn id is
 * written separately as exact receipt evidence. Both hydration entry points must
 * use this writer so reconnect cannot collapse the pair to a synthetic cat slot.
 */
export function hydrateQueueActiveInvocationSlots({
  threadId,
  slots,
  targetCatIds = slots.map((slot) => slot.catId),
}: {
  threadId: string;
  slots: readonly QueueActiveInvocationSlot[];
  targetCatIds?: readonly string[];
}): Record<string, { catId: string; mode: string; startedAt?: number }> {
  const store = useChatStore.getState();
  const activeStateSnapshot: Record<string, { catId: string; mode: string; startedAt?: number }> = {};

  store.replaceThreadTargetCats(threadId, [...targetCatIds]);
  store.clearThreadActiveInvocation(threadId);
  store.setThreadHasActiveInvocation(threadId, true);

  for (const slot of slots) {
    store.updateThreadCatStatus(threadId, slot.catId, statusForHydratedAppServerLifecycle(slot.appServerLifecycle));
    store.setThreadCatInvocation(threadId, slot.catId, {
      // `/queue` is authoritative replacement truth for this correlated pair.
      // Explicit undefined prevents a same-parent snapshot from certifying an old child.
      invocationId: slot.executionId,
      turnInvocationId: slot.turnInvocationId,
      freshnessCarrierCapability: slot.freshnessCarrierCapability ?? {
        provider: 'other',
        carrier: 'other',
        deliverySemantics: 'undeclared',
      },
      ...(slot.appServerLifecycle ? { appServerLifecycle: slot.appServerLifecycle } : {}),
    });

    const activeSlotId = slot.executionId ?? `hydrated-${threadId}-${slot.catId}`;
    store.addThreadActiveInvocation(threadId, activeSlotId, slot.catId, 'execute', slot.startedAt);
    activeStateSnapshot[activeSlotId] = {
      catId: slot.catId,
      mode: 'execute',
      startedAt: slot.startedAt,
    };
  }

  // A five-minute presentation timeout is a rebuildable projection, not a
  // terminal verdict. If F5 restored an unresolved notice, authoritative
  // `/queue` identity resumes its InvocationRecord reconciliation immediately.
  resumeInvocationReconciliationAfterHydration(threadId);

  return activeStateSnapshot;
}
