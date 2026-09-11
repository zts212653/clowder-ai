import type { LifecycleQueueEntry } from '@cat-cafe/shared';

const PRIORITY_RANK: Readonly<Record<LifecycleQueueEntry['priority'], number>> = { urgent: 0, normal: 1 };

export interface LifecycleQueueOrderKey {
  readonly id: string;
  readonly priority: LifecycleQueueEntry['priority'];
  readonly enqueuedAt: number;
  readonly position?: number;
}

/** The only lifecycle Queue comparator: position → priority → FIFO → stable id. */
export function compareLifecycleQueueEntries(a: LifecycleQueueOrderKey, b: LifecycleQueueOrderKey): number {
  const aPositioned = a.position !== undefined;
  const bPositioned = b.position !== undefined;
  if (aPositioned !== bPositioned) return aPositioned ? -1 : 1;
  if (a.position !== undefined && b.position !== undefined && a.position !== b.position) {
    return a.position - b.position;
  }
  const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
