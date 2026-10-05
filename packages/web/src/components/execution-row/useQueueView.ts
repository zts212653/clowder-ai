'use client';

/**
 * F322 original-B: what the queue looks like right now, composed from the stores that already own it.
 *
 * No state of its own: it reads the chat store's queue and the thread's liveness (both existing authorities)
 * and derives the visible entries, the wait reason and the orphan flag with the same pure functions the old
 * QueuePanel used. The old panel and the one-row surface both call this, so they cannot disagree.
 */
import type { FreshnessCarrierCapability } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import { collectExactLiveInvocationIds, collectSettlingInvocationIds } from '../queue-receipt-projection';
import { deriveQueueWaitInfo, queueIsOrphaned, selectVisibleQueueEntries } from './queue-view';
import { queueKnownFor, scopedQueue, scopedQueuePaused, scopedQueuePauseReason } from './thread-queue';

export function useQueueView(threadId: string) {
  // This thread's queue, not whichever thread is current (see thread-queue.ts).
  const rawQueue = useChatStore((s) => scopedQueue(s, threadId));
  const queue = useMemo(() => rawQueue ?? [], [rawQueue]);
  const queuePaused = useChatStore((s) => scopedQueuePaused(s, threadId)) ?? false;
  const queuePauseReason = useChatStore((s) => scopedQueuePauseReason(s, threadId));
  const queueKnown = useChatStore((s) => queueKnownFor(s, threadId));
  const { activeInvocations, catInvocations } = useThreadLiveness(threadId);

  const settlingInvocationIds = useMemo(
    () => collectSettlingInvocationIds(activeInvocations, catInvocations),
    [activeInvocations, catInvocations],
  );
  const activeInvocationIds = useMemo(
    () => collectExactLiveInvocationIds(activeInvocations, catInvocations),
    [activeInvocations, catInvocations],
  );
  const activeCatIds = useMemo(
    () => new Set(Object.values(activeInvocations).map((invocation) => invocation.catId)),
    [activeInvocations],
  );
  const visibleEntries = useMemo(
    () => selectVisibleQueueEntries(queue, { activeInvocationIds, activeCatIds, settlingInvocationIds }),
    [activeCatIds, activeInvocationIds, settlingInvocationIds, queue],
  );
  // Elapsed reflects the last store update (acceptable for v1 — no per-second tick).
  const waitInfo = useMemo(
    () => deriveQueueWaitInfo(visibleEntries, activeInvocations),
    [activeInvocations, visibleEntries],
  );
  const canRecoverOrphanedQueue = queueIsOrphaned(visibleEntries, queuePaused, {
    activeInvocationIds,
    activeCatIds,
    settlingInvocationIds,
  });
  const activeInvocationIdByCatId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(activeInvocations ?? {}).map(([invocationId, invocation]) => [invocation.catId, invocationId]),
      ),
    [activeInvocations],
  );
  const activeCarrierCapabilityByCatId = useMemo(
    () =>
      Object.fromEntries(
        Object.values(activeInvocations).map((invocation) => [
          invocation.catId,
          catInvocations[invocation.catId]?.freshnessCarrierCapability,
        ]),
      ) as Readonly<Record<string, FreshnessCarrierCapability | undefined>>,
    [activeInvocations, catInvocations],
  );

  return {
    queue,
    /** False when the store holds nothing for this thread's queue: show nothing, send nothing. */
    queueKnown,
    queuePaused,
    queuePauseReason,
    activeInvocations,
    visibleEntries,
    waitInfo,
    canRecoverOrphanedQueue,
    activeInvocationIdByCatId,
    activeCarrierCapabilityByCatId,
  };
}

export type QueueView = ReturnType<typeof useQueueView>;
