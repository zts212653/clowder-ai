/**
 * Both chat shells render the canonical pending Queue. Delivery and processing
 * belong to History responses and never return as receipt-backed Queue rows.
 */
import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { QueueEntry } from '@/stores/chat-types';
import { compareQueueEntries, computeQueueWaitInfo } from '../QueuePanel';

export type { QueueWaitInfo } from '../QueuePanel';
export { compareQueueEntries, computeQueueWaitInfo, formatElapsed } from '../QueuePanel';

type ActiveInvocationSlots = Record<string, { catId: string; mode?: string; startedAt?: number }>;

export interface QueueLiveFacts {
  activeInvocationIds: ReadonlySet<string>;
  activeCatIds: ReadonlySet<string>;
}

/** The server already projects pending targets; no local receipt state filters them. */
export function selectVisibleQueueEntries(queue: readonly QueueEntry[]): QueueEntry[] {
  return queue
    .filter(
      (entry) =>
        entry.status === 'queued' &&
        !(entry.sourceCategory === 'scheduled' && entry.content.startsWith(SCHEDULER_TRIGGER_PREFIX)),
    )
    .sort(compareQueueEntries);
}

export function deriveQueueWaitInfo(
  visibleEntries: readonly QueueEntry[],
  activeInvocations: ActiveInvocationSlots | undefined,
) {
  const targets = visibleEntries.flatMap((entry) => entry.targetCats);
  if (targets.length === 0 && !visibleEntries.some((entry) => entry.targetCats.length === 0)) return null;
  return computeQueueWaitInfo(activeInvocations, targets);
}

export function queueIsOrphaned(visibleEntries: readonly QueueEntry[], live: QueueLiveFacts): boolean {
  return visibleEntries.some((entry) =>
    entry.targetCats.length === 0
      ? live.activeInvocationIds.size === 0
      : entry.targetCats.some((catId) => !live.activeCatIds.has(catId)),
  );
}
