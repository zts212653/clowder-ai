/** F268 offline pause and reconnect-drain state-machine tests. */

import { TIP_QUEUE_FLUSH_COUNT } from '@cat-cafe/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TipEventQueue, type TipEventSender } from '../capabilityTipQueue';
import { makeEvent, makeSuccessSender, store } from './capabilityTipQueueTestHelpers';

describe('F268 TipEventQueue connectivity transitions', () => {
  let online = true;

  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
    online = true;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps queued events durable while offline and flushes immediately on reconnect', async () => {
    online = false;
    const queue = new TipEventQueue();
    const sender = makeSuccessSender();
    queue.setSender(sender);

    for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
      queue.enqueue(makeEvent(`offline-${i}`));
    }
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(sender.calls).toHaveLength(0);
    expect(queue.pending).toBe(TIP_QUEUE_FLUSH_COUNT);
    expect(queue.hasInflight).toBe(false);

    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(sender.calls).toHaveLength(1);
    expect(queue.pending).toBe(0);
    queue.dispose();
  });

  it('pauses a failed in-flight batch offline without consuming the retry budget', async () => {
    const calls: number[] = [];
    const sender: TipEventSender = async (batch) => {
      calls.push(batch.attempt);
      if (calls.length === 1) {
        online = false;
        throw new Error('browser went offline');
      }
      return { accepted: batch.events.length, rejected: 0 };
    };
    const queue = new TipEventQueue();
    queue.setSender(sender);
    for (let i = 0; i < TIP_QUEUE_FLUSH_COUNT; i++) {
      queue.enqueue(makeEvent(`inflight-offline-${i}`));
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([1]);
    expect(queue.hasInflight).toBe(true);
    expect(queue.healthCounters.dead_letter).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls).toEqual([1]);
    expect(queue.hasInflight).toBe(true);
    expect(queue.healthCounters.dead_letter).toBe(0);

    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([1, 1]);
    expect(queue.hasInflight).toBe(false);
    queue.dispose();
  });

  it('drains a below-threshold remainder after reconnect instead of re-arming the interval', async () => {
    online = false;
    const queue = new TipEventQueue();
    const sender = makeSuccessSender();
    queue.setSender(sender);
    for (let i = 0; i < 65; i++) {
      queue.enqueue(makeEvent(`reconnect-drain-${i}`));
    }

    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(sender.calls.map((batch) => batch.events.length)).toEqual([50, 15]);
    expect(queue.pending).toBe(0);
    queue.dispose();
  });
});
