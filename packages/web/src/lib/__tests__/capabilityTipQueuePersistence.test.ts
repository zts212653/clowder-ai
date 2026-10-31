/** F268 queue persistence, retention, hydration, and health-counter tests. */

import { TIP_QUEUE_FLUSH_COUNT, TIP_QUEUE_MAX_EVENTS } from '@cat-cafe/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TipEventQueue, type TipQueueHealthCounters } from '../capabilityTipQueue';
import { makeEvent, makeFailingSender, makeSuccessSender, store } from './capabilityTipQueueTestHelpers';

describe('F268 TipEventQueue persistence and health', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('persistence across page reload', () => {
    it('queue survives new instance (simulating reload)', () => {
      const queue1 = new TipEventQueue();
      queue1.enqueue(makeEvent('tip-persisted-1'));
      queue1.enqueue(makeEvent('tip-persisted-2'));
      queue1.dispose();

      const queue2 = new TipEventQueue();
      expect(queue2.pending).toBe(2);
      queue2.dispose();
    });

    it('does not blindly import the legacy event log without identity/window provenance', () => {
      store.set('cat-cafe:tip-events', JSON.stringify([makeEvent('legacy-unproven')]));

      const queue = new TipEventQueue();

      expect(queue.pending).toBe(0);
      expect(store.get('cat-cafe:tip-event-queue')).toBeUndefined();
      queue.dispose();
    });
  });

  describe('7d max-age pruning (Sol R2 P1-1)', () => {
    it('prunes stale events (>7d) on queue load and persists clean', () => {
      const queue1 = new TipEventQueue();
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      queue1.enqueue(makeEvent('stale-tip', eightDaysAgo));
      queue1.enqueue(makeEvent('fresh-tip', oneHourAgo));
      expect(queue1.pending).toBe(2);
      queue1.dispose();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const queue2 = new TipEventQueue();
      expect(queue2.pending).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Pruned'));
      warnSpy.mockClear();
      queue2.dispose();

      const queue3 = new TipEventQueue();
      expect(queue3.pending).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
      queue3.dispose();
    });

    it('drops inflight batch if ANY event is stale (batchId→payload immutable)', () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      store.set(
        'cat-cafe:tip-event-inflight',
        JSON.stringify({
          batch: {
            batchId: '550e8400-e29b-41d4-a716-446655440000',
            attempt: 2,
            events: [makeEvent('old-event', eightDaysAgo), makeEvent('fresh-event', oneHourAgo)],
            assembledAt: oneHourAgo,
            schemaVersion: 1,
          },
          attemptCount: 2,
          nextRetryAt: Date.now() + 5_000,
        }),
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const queue = new TipEventQueue();
      expect(queue.hasInflight).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('any-stale rule'));
      queue.dispose();
    });

    it('prunes corrupted/invalid entries from queue on hydration', () => {
      const validEvent = makeEvent('valid-tip', Date.now() - 60000);
      const corruptedEntry = { event: 'INVALID', tipId: 123, timestamp: 'not a number' };
      store.set(
        'cat-cafe:tip-event-queue',
        JSON.stringify({ events: [corruptedEntry, validEvent, { noFields: true }] }),
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const queue = new TipEventQueue();
      expect(queue.pending).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid'));
      queue.dispose();
    });

    it('prunes corrupted inflight batch envelope on hydration', () => {
      store.set(
        'cat-cafe:tip-event-inflight',
        JSON.stringify({
          batch: { batchId: 'not-uuid', attempt: 'wrong', events: [] },
          attemptCount: 1,
          nextRetryAt: 0,
        }),
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const queue = new TipEventQueue();
      expect(queue.hasInflight).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('corrupted'));
      queue.dispose();
    });

    it('prunes queued events that age out while the page stays open', async () => {
      const base = new Date('2026-07-01T00:00:00.000Z');
      vi.setSystemTime(base);
      const queue = new TipEventQueue();
      queue.enqueue(makeEvent('ages-in-memory', base.getTime()));
      queue.dispose();

      vi.setSystemTime(new Date(base.getTime() + 8 * 24 * 60 * 60 * 1000));
      const sender = makeSuccessSender();
      queue.setSender(sender);
      queue.flush();
      await vi.advanceTimersByTimeAsync(0);

      expect(sender.calls).toHaveLength(0);
      expect(queue.pending).toBe(0);
      expect(queue.healthCounters.stale_pruned).toBe(1);
      queue.dispose();
    });

    it('drops an inflight batch that ages out before its retry fires', async () => {
      const base = new Date('2026-07-01T00:00:00.000Z');
      vi.setSystemTime(base);
      const queue = new TipEventQueue();
      const failing = makeFailingSender(1);
      queue.setSender(failing);
      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`inflight-${i}`, base.getTime()));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(queue.hasInflight).toBe(true);
      queue.dispose();

      vi.setSystemTime(new Date(base.getTime() + 8 * 24 * 60 * 60 * 1000));
      const success = makeSuccessSender();
      queue.setSender(success);
      await vi.advanceTimersByTimeAsync(0);

      expect(success.calls).toHaveLength(0);
      expect(queue.hasInflight).toBe(false);
      expect(queue.healthCounters.stale_pruned).toBe(TIP_QUEUE_FLUSH_COUNT);
      queue.dispose();
    });
  });

  describe('client health counters (Sol R2 P1-2)', () => {
    it('tracks overflow count when queue exceeds max', () => {
      const queue = new TipEventQueue();
      for (let i = 0; i < TIP_QUEUE_MAX_EVENTS; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }
      expect(queue.healthCounters.overflow).toBe(0);

      for (let i = 0; i < 5; i++) {
        queue.enqueue(makeEvent(`overflow-${i}`));
      }
      expect(queue.healthCounters.overflow).toBe(5);
      queue.dispose();
    });

    it('tracks stale_pruned count on load', () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const queue1 = new TipEventQueue();
      queue1.enqueue(makeEvent('stale-1', eightDaysAgo));
      queue1.enqueue(makeEvent('stale-2', eightDaysAgo));
      queue1.enqueue(makeEvent('fresh-1', Date.now()));
      queue1.dispose();

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const queue2 = new TipEventQueue();
      expect(queue2.healthCounters.stale_pruned).toBe(2);
      queue2.dispose();
    });

    it('tracks upload_failed count on send errors', async () => {
      const queue = new TipEventQueue();
      const sender = makeFailingSender(2);
      queue.setSender(sender);

      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(queue.healthCounters.upload_failed).toBe(1);

      await vi.advanceTimersByTimeAsync(5100);
      expect(queue.healthCounters.upload_failed).toBe(2);

      await vi.advanceTimersByTimeAsync(15100);
      expect(queue.healthCounters.upload_failed).toBe(2);
      queue.dispose();
    });

    it('tracks dead_letter count when max retries exhausted', async () => {
      const queue = new TipEventQueue();
      const sender = makeFailingSender();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      queue.setSender(sender);

      for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
        queue.enqueue(makeEvent(`tip-${i}`));
      }

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5100);
      await vi.advanceTimersByTimeAsync(15100);
      await vi.advanceTimersByTimeAsync(45100);
      await vi.advanceTimersByTimeAsync(120100);
      await vi.advanceTimersByTimeAsync(300100);

      expect(queue.healthCounters.dead_letter).toBe(1);
      queue.dispose();
    });

    it('healthCounters returns a snapshot (not mutable reference)', () => {
      const queue = new TipEventQueue();
      const snapshot = queue.healthCounters;
      (snapshot as TipQueueHealthCounters).overflow = 999;
      expect(queue.healthCounters.overflow).toBe(0);
      queue.dispose();
    });
  });
});
