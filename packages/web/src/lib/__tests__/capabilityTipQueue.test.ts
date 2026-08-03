/**
 * F268 AC-A2 — Client queue contract tests.
 *
 * Verifies:
 * - Non-blocking: enqueue returns immediately regardless of network state
 * - Bounded: queue evicts oldest events on overflow (FIFO)
 * - Idempotent: each batch has a unique batchId
 * - Retry: failed sends are retried with backoff
 * - Dead letter: batches exceeding max attempts are dropped
 * - Telemetry failure never blocks tips (AC-A2 hard requirement)
 */

import type { TipEventBatch } from '@cat-cafe/shared';
import { TIP_BATCH_MAX_SIZE, TIP_QUEUE_FLUSH_COUNT, TIP_QUEUE_MAX_EVENTS } from '@cat-cafe/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TipEventQueue, type TipEventSender } from '../capabilityTipQueue';
import { makeEvent, makeFailingSender, makeSuccessSender, store } from './capabilityTipQueueTestHelpers';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('F268 TipEventQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('non-blocking enqueue', () => {
    it('enqueue returns immediately without sender configured', () => {
      const queue = new TipEventQueue();
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }
      // Should complete in < 1ms (no async waiting)
      expect(Date.now() - start).toBeLessThan(50);
      expect(queue.pending).toBe(100);
      queue.dispose();
    });

    it('enqueue does not throw when sender fails', async () => {
      const queue = new TipEventQueue();
      const sender = makeFailingSender();
      queue.setSender(sender);

      // Enqueue enough to trigger flush
      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }

      // Let microtasks resolve
      await vi.advanceTimersByTimeAsync(0);

      // Queue should have attempted send but not thrown
      expect(sender.calls.length).toBe(1);
      queue.dispose();
    });
  });

  describe('bounded queue (FIFO eviction)', () => {
    it('evicts oldest events when exceeding max', () => {
      const queue = new TipEventQueue();

      // Fill beyond max
      for (let i = 0; i < TIP_QUEUE_MAX_EVENTS + 50; i++) {
        queue.enqueue(makeEvent(`tip-${i}`, i));
      }

      expect(queue.pending).toBe(TIP_QUEUE_MAX_EVENTS);

      // Verify localStorage has bounded data
      const raw = store.get('cat-cafe:tip-event-queue');
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw ?? '{}');
      expect(parsed.events.length).toBe(TIP_QUEUE_MAX_EVENTS);
      // Oldest events should be evicted (first 50 gone)
      expect(parsed.events[0].timestamp).toBe(50);
      queue.dispose();
    });
  });

  describe('batch assembly', () => {
    it('flushes when reaching flush count threshold', async () => {
      const queue = new TipEventQueue();
      const sender = makeSuccessSender();
      queue.setSender(sender);

      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }

      await vi.advanceTimersByTimeAsync(0);

      expect(sender.calls.length).toBe(1);
      expect(sender.calls[0]?.events.length).toBe(TIP_QUEUE_FLUSH_COUNT);
      expect(sender.calls[0]?.schemaVersion).toBe(1);
      expect(sender.calls[0]?.attempt).toBe(1);
      // batchId should be a valid UUID v4
      expect(sender.calls[0]?.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      queue.dispose();
    });

    it('batch size is capped at TIP_BATCH_MAX_SIZE', async () => {
      const queue = new TipEventQueue();
      const sender = makeSuccessSender();

      // Enqueue more than max batch size
      for (let i = 0; i < TIP_BATCH_MAX_SIZE + 30; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }

      queue.setSender(sender);
      queue.flush();
      await vi.advanceTimersByTimeAsync(0);

      expect(sender.calls.map((batch) => batch.events.length)).toEqual([TIP_BATCH_MAX_SIZE, 30]);
      expect(queue.pending).toBe(0);
      queue.dispose();
    });

    it('immediately drains a threshold-ready backlog after the current batch succeeds', async () => {
      const queue = new TipEventQueue();
      const sender = makeSuccessSender();
      queue.setSender(sender);

      for (let i = 0; i < 100; i++) {
        queue.enqueue(makeEvent(`burst-${i}`));
      }

      await vi.advanceTimersByTimeAsync(0);

      expect(sender.calls.map((batch) => batch.events.length)).toEqual([
        TIP_QUEUE_FLUSH_COUNT,
        TIP_BATCH_MAX_SIZE,
        100 - TIP_QUEUE_FLUSH_COUNT - TIP_BATCH_MAX_SIZE,
      ]);
      expect(queue.pending).toBe(0);
      expect(queue.hasInflight).toBe(false);
      queue.dispose();
    });

    it('each batch gets a unique batchId', async () => {
      const queue = new TipEventQueue();
      const sender = makeSuccessSender();
      queue.setSender(sender);

      // First batch
      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-a-${i}`));
      }
      await vi.advanceTimersByTimeAsync(0);

      // Second batch (after flush interval)
      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-b-${i}`));
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(sender.calls.length).toBe(2);
      expect(sender.calls[0]?.batchId).not.toBe(sender.calls[1]?.batchId);
      queue.dispose();
    });
  });

  describe('timer-based flush', () => {
    it('flushes after interval even below count threshold', async () => {
      const queue = new TipEventQueue();
      const sender = makeSuccessSender();
      queue.setSender(sender);

      // Enqueue fewer than flush count
      queue.enqueue(makeEvent('tip-1'));
      queue.enqueue(makeEvent('tip-2'));

      expect(sender.calls.length).toBe(0);

      // Advance past flush interval
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

      expect(sender.calls.length).toBe(1);
      expect(sender.calls[0]?.events.length).toBe(2);
      queue.dispose();
    });
  });

  describe('retry with backoff', () => {
    it('retries failed batch with increasing delays', async () => {
      const queue = new TipEventQueue();
      const sender = makeFailingSender(2); // Fail twice, then succeed
      queue.setSender(sender);

      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }
      await vi.advanceTimersByTimeAsync(0);

      // First attempt failed
      expect(sender.calls.length).toBe(1);
      expect(sender.calls[0]?.attempt).toBe(1);

      // Advance past first backoff (5s)
      await vi.advanceTimersByTimeAsync(5100);
      expect(sender.calls.length).toBe(2);
      expect(sender.calls[1]?.attempt).toBe(2);

      // Advance past second backoff (15s)
      await vi.advanceTimersByTimeAsync(15100);
      expect(sender.calls.length).toBe(3);
      expect(sender.calls[2]?.attempt).toBe(3);

      // Third attempt succeeds (failsRemaining was 2)
      expect(queue.hasInflight).toBe(false);
      queue.dispose();
    });

    it('dead-letters batch after max attempts, using all backoff entries', async () => {
      const queue = new TipEventQueue();
      const sender = makeFailingSender(); // Always fail
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      queue.setSender(sender);

      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }

      // Run through all retry cycles — every backoff entry should be used
      await vi.advanceTimersByTimeAsync(0); // attempt 1 (initial)
      await vi.advanceTimersByTimeAsync(5100); // attempt 2 (backoff[0] = 5s)
      await vi.advanceTimersByTimeAsync(15100); // attempt 3 (backoff[1] = 15s)
      await vi.advanceTimersByTimeAsync(45100); // attempt 4 (backoff[2] = 45s)
      await vi.advanceTimersByTimeAsync(120100); // attempt 5 (backoff[3] = 2min)
      await vi.advanceTimersByTimeAsync(300100); // attempt 6 (backoff[4] = 5min)

      // P2-3: all 5 backoff entries used = 6 total sends before dead-letter
      expect(sender.calls.length).toBe(6);
      expect(queue.hasInflight).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead-lettered'));

      warnSpy.mockRestore();
      queue.dispose();
    });
  });

  describe('401 retry behavior (Sol P1-3)', () => {
    it('401 from sender triggers retry instead of clearing queue', async () => {
      const queue = new TipEventQueue();
      const calls: TipEventBatch[] = [];
      let callCount = 0;
      const sender: TipEventSender = async (batch) => {
        calls.push(batch);
        callCount++;
        if (callCount <= 2) {
          // Simulate 401 — sender throws
          throw new Error('Tip telemetry auth not ready: 401');
        }
        // Third call succeeds
        return { accepted: batch.events.length, rejected: 0 };
      };
      queue.setSender(sender);

      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }
      await vi.advanceTimersByTimeAsync(0); // attempt 1 — 401 throws
      expect(calls.length).toBe(1);
      expect(queue.hasInflight).toBe(true); // NOT cleared!

      // After backoff, retries
      await vi.advanceTimersByTimeAsync(5100); // attempt 2 — 401 throws again
      expect(calls.length).toBe(2);
      expect(queue.hasInflight).toBe(true);

      // Third attempt succeeds
      await vi.advanceTimersByTimeAsync(15100);
      expect(calls.length).toBe(3);
      expect(queue.hasInflight).toBe(false); // Now cleared
      queue.dispose();
    });
  });
});
