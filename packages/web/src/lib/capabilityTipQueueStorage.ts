/**
 * F268 queue persistence boundary.
 *
 * Owns schema validation, seven-day pruning, and localStorage serialization so
 * the queue state machine can focus on batching, retries, and transitions.
 */

import {
  type CapabilityTipUsageEvent,
  CapabilityTipUsageEventSchema,
  TIP_MAX_AGE_MS,
  type TipEventBatch,
  TipEventBatchSchema,
} from '@cat-cafe/shared';

export interface TipQueueHealthCounters {
  /** Events lost due to FIFO eviction (queue overflow). */
  overflow: number;
  /** Events pruned because their timestamp is more than seven days old. */
  stale_pruned: number;
  /** Batch send attempts that failed (network/5xx/401). */
  upload_failed: number;
  /** Batches that exceeded max retry attempts and were dropped. */
  dead_letter: number;
}

export interface InflightBatch {
  batch: TipEventBatch;
  attemptCount: number;
  nextRetryAt: number;
}

interface PersistedQueue {
  events: CapabilityTipUsageEvent[];
}

const QUEUE_STORAGE_KEY = 'cat-cafe:tip-event-queue';
const INFLIGHT_STORAGE_KEY = 'cat-cafe:tip-event-inflight';

export function emptyTipQueueHealthCounters(): TipQueueHealthCounters {
  return { overflow: 0, stale_pruned: 0, upload_failed: 0, dead_letter: 0 };
}

/** Validate and prune the persisted queue in one hydration step. */
export function loadTipEventQueue(counters: TipQueueHealthCounters): CapabilityTipUsageEvent[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: PersistedQueue = JSON.parse(raw);
    if (!Array.isArray(parsed.events)) return [];

    const cutoff = Date.now() - TIP_MAX_AGE_MS;
    let invalidCount = 0;
    let staleCount = 0;
    const clean: CapabilityTipUsageEvent[] = [];

    for (const entry of parsed.events) {
      const result = CapabilityTipUsageEventSchema.safeParse(entry);
      if (!result.success) {
        invalidCount++;
        continue;
      }
      if (result.data.timestamp < cutoff) {
        staleCount++;
        continue;
      }
      clean.push(result.data);
    }

    const totalPruned = invalidCount + staleCount;
    if (totalPruned > 0) {
      counters.stale_pruned += staleCount;
      console.warn(
        `[F268] Pruned ${totalPruned} tip events on queue load (${staleCount} stale, ${invalidCount} invalid)`,
      );
      saveTipEventQueue(clean);
    }
    return clean;
  } catch {
    return [];
  }
}

export function saveTipEventQueue(events: CapabilityTipUsageEvent[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const data: PersistedQueue = { events };
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage full or blocked — telemetry must degrade silently.
  }
}

/**
 * Validate the immutable in-flight envelope and drop the whole batch if any
 * event is stale; partially pruning it would change the receipt digest.
 */
export function loadTipEventInflight(counters: TipQueueHealthCounters): InflightBatch | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = localStorage.getItem(INFLIGHT_STORAGE_KEY);
    if (!raw) return null;
    const inflight = JSON.parse(raw) as InflightBatch;

    const batchResult = TipEventBatchSchema.safeParse(inflight.batch);
    if (!batchResult.success) {
      console.warn('[F268] Pruned corrupted inflight batch (invalid envelope)');
      localStorage.removeItem(INFLIGHT_STORAGE_KEY);
      return null;
    }

    const cutoff = Date.now() - TIP_MAX_AGE_MS;
    const hasAnyStale = inflight.batch.events.some((event) => event.timestamp < cutoff);
    if (hasAnyStale) {
      counters.stale_pruned += inflight.batch.events.length;
      console.warn(`[F268] Pruned stale inflight batch (${inflight.batch.events.length} events, any-stale rule)`);
      localStorage.removeItem(INFLIGHT_STORAGE_KEY);
      return null;
    }
    return inflight;
  } catch {
    return null;
  }
}

export function saveTipEventInflight(inflight: InflightBatch | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (inflight) {
      localStorage.setItem(INFLIGHT_STORAGE_KEY, JSON.stringify(inflight));
    } else {
      localStorage.removeItem(INFLIGHT_STORAGE_KEY);
    }
  } catch {
    // localStorage full or blocked — telemetry must degrade silently.
  }
}
