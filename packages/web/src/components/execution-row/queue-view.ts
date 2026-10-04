/**
 * F322 original-B: the queue's derived facts, as pure functions.
 *
 * These lived inline in QueuePanel. The one-row execution surface needs exactly the same answers
 * (which entries are visible, what the queue is waiting for, whether it is orphaned), so they have one
 * home and both surfaces import them. Nothing here reads a store; callers pass what they hold.
 */
import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { QueueEntry } from '@/stores/chat-types';
import {
  projectQueueEntryForActions,
  queueEntryNeedsRecovery,
  queueTargetStateEntries,
} from '../queue-receipt-projection';

const PRIORITY_RANK: Record<string, number> = { urgent: 0, normal: 1 };

export function compareQueueEntries(
  a: { position?: number; priority?: string; createdAt: number },
  b: { position?: number; priority?: string; createdAt: number },
): number {
  const aHasPos = a.position !== undefined;
  const bHasPos = b.position !== undefined;
  if (aHasPos && !bHasPos) return -1;
  if (!aHasPos && bHasPos) return 1;
  if (aHasPos && bHasPos) return a.position! - b.position!;
  const pDiff = (PRIORITY_RANK[a.priority ?? 'normal'] ?? 1) - (PRIORITY_RANK[b.priority ?? 'normal'] ?? 1);
  if (pDiff !== 0) return pDiff;
  return a.createdAt - b.createdAt;
}

/** Format an elapsed duration (ms) as a compact label: `45s` / `12m` / `1h03m`. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  return `${h}h${String(totalMin % 60).padStart(2, '0')}m`;
}

export type QueueWaitInfo =
  | { kind: 'active_turn'; catId: string; elapsedLabel: string | null }
  | { kind: 'target_dispatch'; catIds: string[] };

type ActiveInvocationSlots = Record<string, { catId: string; mode?: string; startedAt?: number }>;

/**
 * Derive queue wait truth from both the queued work's explicit targets and live invocation slots.
 *
 * Explicit targets are authoritative: if none of those cats is active, the work is waiting for
 * target dispatch. An unrelated active cat must never be borrowed as the queue's blocker. Only
 * broadcast work (no explicit targets) may describe the oldest thread-level active turn.
 *
 * Pure: `now` injected for testing.
 */
export function computeQueueWaitInfo(
  activeInvocations: ActiveInvocationSlots | undefined,
  queuedTargetCatIds: Iterable<string> = [],
  now: number = Date.now(),
): QueueWaitInfo | null {
  const slots = Object.values(activeInvocations ?? {});
  const targetCatIds = [...new Set(queuedTargetCatIds)];
  const targets = new Set(targetCatIds);
  const targeted = targetCatIds.length > 0 ? slots.filter((slot) => targets.has(slot.catId)) : [];

  if (targetCatIds.length > 0 && targeted.length === 0) {
    return { kind: 'target_dispatch', catIds: targetCatIds };
  }

  const candidates = targeted.length > 0 ? targeted : slots;
  if (candidates.length === 0) return null;
  let oldest = candidates[0];
  for (const s of candidates) {
    if ((s.startedAt ?? Number.POSITIVE_INFINITY) < (oldest.startedAt ?? Number.POSITIVE_INFINITY)) oldest = s;
  }
  return {
    kind: 'active_turn',
    catId: oldest.catId,
    elapsedLabel: oldest.startedAt ? formatElapsed(Math.max(0, now - oldest.startedAt)) : null,
  };
}

export interface QueueLiveFacts {
  /** Exact live invocation ids (from both liveness sources). */
  activeInvocationIds: ReadonlySet<string>;
  /** Cats that currently hold an active invocation slot. */
  activeCatIds: ReadonlySet<string>;
  /** Invocation ids that are still settling. */
  settlingInvocationIds: ReadonlySet<string>;
}

/**
 * The entries the user is shown: everything queued, plus a `processing` entry only when it is stuck
 * (the server projected a force_reset for it AND none of its target cats holds a live slot).
 * A scheduler-trigger connector entry is hidden unless one of its targets failed and it can be recovered.
 */
export function selectVisibleQueueEntries(queue: readonly QueueEntry[], live: QueueLiveFacts): QueueEntry[] {
  return queue
    .filter((entry) => {
      if (entry.source === 'connector' && entry.content.startsWith(SCHEDULER_TRIGGER_PREFIX)) {
        const hasFailedTarget = queueTargetStateEntries(entry).some(([, state]) => state === 'failed');
        if (!hasFailedTarget || !entry.recoveryActions?.length) return false;
      }
      if (entry.status === 'queued') return true;
      const hasProjectedReset = entry.recoveryActions?.some((action) => action.kind === 'force_reset') ?? false;
      const hasActiveTarget =
        entry.targetCats.length === 0
          ? live.activeInvocationIds.size > 0
          : entry.targetCats.some((catId) => live.activeCatIds.has(catId));
      return hasProjectedReset && !hasActiveTarget;
    })
    .map((entry) => projectQueueEntryForActions(entry, live.activeInvocationIds, live.settlingInvocationIds))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort(compareQueueEntries);
}

/**
 * A2A queue visibility: explain WHY entries are queued (waiting behind the active turn) so the user can
 * tell "waiting for the current turn" apart from "stuck". Passes the visible queued entries' target cats
 * so the wait reason attributes the RIGHT cat (per-cat slot), not just the oldest active turn.
 */
export function deriveQueueWaitInfo(
  visibleEntries: readonly QueueEntry[],
  activeInvocations: ActiveInvocationSlots | undefined,
): QueueWaitInfo | null {
  const waitingEntries = visibleEntries.filter((entry) => entry.status === 'queued');
  const dispatchTargetCatIds = waitingEntries.flatMap((entry) => {
    const targetStates = queueTargetStateEntries(entry);
    return targetStates.length > 0
      ? targetStates
          .filter(([, state]) => state !== 'seen' && state !== 'awakened' && state !== 'failed')
          .map(([catId]) => catId)
      : entry.targetCats;
  });
  const hasBroadcastEntry = waitingEntries.some(
    (entry) => queueTargetStateEntries(entry).length === 0 && entry.targetCats.length === 0,
  );
  if (dispatchTargetCatIds.length === 0 && !hasBroadcastEntry) return null;
  return computeQueueWaitInfo(activeInvocations, dispatchTargetCatIds);
}

/** A queued entry whose live carrier is gone while the queue is not paused: the user may need to press 恢复. */
export function queueIsOrphaned(
  visibleEntries: readonly QueueEntry[],
  queuePaused: boolean,
  live: QueueLiveFacts,
): boolean {
  return (
    !queuePaused &&
    visibleEntries.some(
      (entry) =>
        entry.status === 'queued' &&
        queueEntryNeedsRecovery(entry, live.activeInvocationIds, live.activeCatIds, live.settlingInvocationIds),
    )
  );
}
