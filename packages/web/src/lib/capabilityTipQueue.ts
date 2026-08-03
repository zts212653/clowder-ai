/**
 * F268 client-side tip event batch queue.
 *
 * Tip rendering never waits on upload. The queue is bounded, persists locally,
 * sends one immutable batch at a time, and retries with bounded backoff.
 */

import {
  type CapabilityTipUsageEvent,
  TIP_BATCH_MAX_SIZE,
  TIP_MAX_AGE_MS,
  TIP_MAX_RETRY_ATTEMPTS,
  TIP_QUEUE_FLUSH_COUNT,
  TIP_QUEUE_FLUSH_INTERVAL_MS,
  TIP_QUEUE_MAX_EVENTS,
  TIP_RETRY_BACKOFF_MS,
  type TipEventBatch,
} from '@cat-cafe/shared';
import {
  emptyTipQueueHealthCounters,
  type InflightBatch,
  loadTipEventInflight,
  loadTipEventQueue,
  saveTipEventInflight,
  saveTipEventQueue,
  type TipQueueHealthCounters,
} from './capabilityTipQueueStorage';

export type { TipQueueHealthCounters } from './capabilityTipQueueStorage';

function generateBatchId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0;
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function browserIsOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

export type TipEventSender = (batch: TipEventBatch) => Promise<{ accepted: number; rejected: number }>;

export class TipEventQueue {
  private queue: CapabilityTipUsageEvent[];
  private inflight: InflightBatch | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private sender: TipEventSender | null = null;
  private flushing = false;
  private drainAfterReconnect = false;
  private readonly counters: TipQueueHealthCounters;

  private readonly handleOnline = (): void => {
    if (!browserIsOnline()) return;
    this.drainAfterReconnect = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.inflight && this.queue.length === 0) {
      this.drainAfterReconnect = false;
      return;
    }
    if (!this.sender || this.flushing) return;
    if (this.inflight) {
      this.flushing = true;
      this.sendBatch();
      return;
    }
    this.flush();
  };

  constructor() {
    this.counters = emptyTipQueueHealthCounters();
    this.queue = loadTipEventQueue(this.counters);
    this.inflight = loadTipEventInflight(this.counters);
    if (typeof window !== 'undefined') window.addEventListener('online', this.handleOnline);
  }

  get healthCounters(): Readonly<TipQueueHealthCounters> {
    return { ...this.counters };
  }

  setSender(sender: TipEventSender): void {
    this.sender = sender;
    this.continueQueuedWork();
    this.scheduleRetry();
  }

  enqueue(event: CapabilityTipUsageEvent): void {
    this.queue.push(event);

    if (this.queue.length > TIP_QUEUE_MAX_EVENTS) {
      const overflow = this.queue.length - TIP_QUEUE_MAX_EVENTS;
      this.counters.overflow += overflow;
      this.queue = this.queue.slice(overflow);
    }

    saveTipEventQueue(this.queue);
    if (this.queue.length >= TIP_QUEUE_FLUSH_COUNT) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get hasInflight(): boolean {
    return this.inflight !== null;
  }

  /** Force a flush without waiting for the response. */
  flush(): void {
    if (this.flushing || !this.sender) return;
    this.pruneStaleQueue();
    if (!browserIsOnline()) return;
    if (this.queue.length === 0 || this.inflight) return;

    this.flushing = true;
    const batchEvents = this.queue.slice(0, TIP_BATCH_MAX_SIZE);
    const batch: TipEventBatch = {
      batchId: generateBatchId(),
      attempt: 1,
      events: batchEvents,
      assembledAt: Date.now(),
      schemaVersion: 1,
    };

    this.queue = this.queue.slice(batchEvents.length);
    saveTipEventQueue(this.queue);
    this.inflight = { batch, attemptCount: 1, nextRetryAt: 0 };
    saveTipEventInflight(this.inflight);
    this.sendBatch();
  }

  private async sendBatch(): Promise<void> {
    if (!this.inflight || !this.sender) {
      this.flushing = false;
      return;
    }

    if (this.dropInflightIfStale()) {
      this.flushing = false;
      this.continueQueuedWork();
      return;
    }

    if (!browserIsOnline()) {
      this.flushing = false;
      return;
    }

    try {
      await this.sender(this.inflight.batch);
      this.inflight = null;
      saveTipEventInflight(null);
      this.flushing = false;
      this.continueQueuedWork();
    } catch {
      this.counters.upload_failed++;
      this.flushing = false;
      if (!browserIsOnline()) return;
      this.scheduleRetryForCurrentBatch();
    }
  }

  private scheduleRetryForCurrentBatch(): void {
    if (!this.inflight) return;

    const { attemptCount } = this.inflight;
    if (attemptCount > TIP_MAX_RETRY_ATTEMPTS) {
      this.counters.dead_letter++;
      console.warn(
        `[F268] Tip event batch ${this.inflight.batch.batchId} dead-lettered after ${attemptCount} attempts`,
      );
      this.inflight = null;
      saveTipEventInflight(null);
      this.continueQueuedWork();
      return;
    }

    const fallbackBackoffMs = TIP_RETRY_BACKOFF_MS.at(-1) ?? 5 * 60 * 1_000;
    const backoffMs = TIP_RETRY_BACKOFF_MS[attemptCount - 1] ?? fallbackBackoffMs;
    const nextRetryAt = Date.now() + backoffMs;
    this.inflight = {
      batch: { ...this.inflight.batch, attempt: attemptCount + 1 },
      attemptCount: attemptCount + 1,
      nextRetryAt,
    };
    saveTipEventInflight(this.inflight);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.inflight || !browserIsOnline()) return;

    const delay = Math.max(0, this.inflight.nextRetryAt - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.inflight && this.sender) {
        this.flushing = true;
        this.sendBatch();
      }
    }, delay);
  }

  private pruneStaleQueue(): void {
    const cutoff = Date.now() - TIP_MAX_AGE_MS;
    const fresh = this.queue.filter((event) => event.timestamp >= cutoff);
    const pruned = this.queue.length - fresh.length;
    if (pruned === 0) return;
    this.counters.stale_pruned += pruned;
    this.queue = fresh;
    saveTipEventQueue(this.queue);
  }

  private dropInflightIfStale(): boolean {
    if (!this.inflight) return false;
    const cutoff = Date.now() - TIP_MAX_AGE_MS;
    if (!this.inflight.batch.events.some((event) => event.timestamp < cutoff)) return false;
    this.counters.stale_pruned += this.inflight.batch.events.length;
    this.inflight = null;
    saveTipEventInflight(null);
    return true;
  }

  /** Continue immediately only when the count threshold is already satisfied. */
  private continueQueuedWork(): void {
    if (this.queue.length === 0) {
      this.drainAfterReconnect = false;
    } else if (this.drainAfterReconnect || this.queue.length >= TIP_QUEUE_FLUSH_COUNT) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, TIP_QUEUE_FLUSH_INTERVAL_MS);
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('online', this.handleOnline);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

let instance: TipEventQueue | null = null;

export function getTipEventQueue(): TipEventQueue {
  if (!instance) instance = new TipEventQueue();
  return instance;
}

export function resetTipEventQueue(): void {
  instance?.dispose();
  instance = null;
}
