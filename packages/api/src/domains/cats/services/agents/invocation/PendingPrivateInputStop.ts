import type { QueueEntry } from './InvocationQueue.js';

/** Freeze only recipients that have not started, including a pending sibling of a live claim. */
export function capturePendingPrivateTargets(entries: readonly QueueEntry[], catIds?: readonly string[]) {
  const pending = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind !== 'private_input' || (entry.status !== 'queued' && entry.status !== 'claimed')) continue;
    for (const target of entry.targets) {
      if ((catIds && !catIds.includes(target)) || entry.claimedTargetIds?.includes(target)) continue;
      const ids = pending.get(target) ?? [];
      ids.push(entry.id);
      pending.set(target, ids);
    }
  }
  return pending;
}

/** One execution's user-Stop snapshot. No durable state or independent admission policy. */
export class PendingPrivateInputStop {
  private readonly captured = new Set<string>();
  private readonly pending: Promise<void>[] = [];
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly snapshot: (catId: string) => readonly string[],
    private readonly retire: (catId: string, entryIds: readonly string[]) => Promise<void>,
  ) {}

  observe(catId: string, signal: AbortSignal): void {
    const capture = () => {
      if (signal.reason !== 'user_cancel' && signal.reason !== 'cancel_all') return;
      if (this.captured.has(catId)) return;
      this.captured.add(catId);
      // Start on this member's Stop, even while a sibling keeps the parent alive.
      this.pending.push(this.retire(catId, this.snapshot(catId)));
    };
    signal.addEventListener('abort', capture, { once: true });
    this.detach.push(() => signal.removeEventListener('abort', capture));
    if (signal.aborted) capture();
  }

  async settle(): Promise<void> {
    for (const detach of this.detach) detach();
    this.detach.length = 0;
    await Promise.all(this.pending);
  }
}
