import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { QueueActiveInvocationSlot } from './queue-active-invocation-hydration';
import { reconcileQueueActiveInvocationProjection } from './queue-active-invocation-reconciliation';

/** Per-thread epoch used to invalidate stale live queue-processing hydrates. */
const liveQueueHydrateEpoch = new Map<string, number>();

export function bumpLiveQueueHydrateEpoch(threadId: string): number {
  const next = (liveQueueHydrateEpoch.get(threadId) ?? 0) + 1;
  liveQueueHydrateEpoch.set(threadId, next);
  return next;
}

export function getLiveQueueHydrateEpoch(threadId: string): number {
  return liveQueueHydrateEpoch.get(threadId) ?? 0;
}

/**
 * Query /queue for one thread and reconcile local state against server truth.
 * Shared by reconnect reconciliation and the stale-watchdog probe.
 * `shouldAbort` lets the caller bail out when a newer reconciliation supersedes it.
 *
 * Exported for tests (F173 PR-C Task 10 — fixture asserts mirror invariant).
 */
interface QueueReconciliationSnapshot {
  queue?: import('../stores/chat-types').QueueEntry[];
  activeInvocations?: QueueActiveInvocationSlot[];
}

async function fetchQueueReconciliationSnapshot(threadId: string): Promise<QueueReconciliationSnapshot | null> {
  try {
    const response = await apiFetch(`/api/threads/${threadId}/queue`);
    if (!response.ok) return null;
    return (await response.json()) as QueueReconciliationSnapshot;
  } catch {
    return null;
  }
}

export async function reconcileThreadWithServer(
  threadId: string,
  shouldAbort: () => boolean,
  source: string,
  socketFallback?: {
    queue: import('../stores/chat-types').QueueEntry[];
  },
): Promise<void> {
  // Reconnect/watchdog GETs must also yield to newer committed socket truth,
  // not just to another probe of their own kind.
  const queueEpoch = getLiveQueueHydrateEpoch(threadId);
  const data = await fetchQueueReconciliationSnapshot(threadId);
  if (shouldAbort() || getLiveQueueHydrateEpoch(threadId) !== queueEpoch) return;
  const queue = Array.isArray(data?.queue) ? data.queue : socketFallback?.queue;
  const store = useChatStore.getState();
  if (queue) {
    store.setQueue(threadId, queue);
  }
  if (!data) return;

  try {
    reconcileQueueActiveInvocationProjection({
      threadId,
      slots: data.activeInvocations,
      source,
    });
  } catch {
    // Queue replacement is already settled above. Liveness reconciliation is
    // recoverable from the next event/watchdog and must not reject its caller.
  }
}
