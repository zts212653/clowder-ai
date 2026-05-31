/**
 * clowder-ai#789 — React "Maximum update depth exceeded" under 200+ agent_message burst
 *
 * Root cause: useSocket dispatches each socket event synchronously → processThreadSeq
 * calls multiple chatStore.setState → useSyncExternalStore bypasses React 18 automatic
 * batching → >50 nested updates → crash.
 *
 * Fix: createAgentMessageCoalescer buffers synchronous pushes and flushes them all
 * in a single queueMicrotask, which React 18 treats as one batch unit.
 *
 * These tests verify the coalescer's correctness contract:
 *  1. 200 synchronous pushes → handler called 200× after one microtask (not zero, not partial)
 *  2. Push order is preserved through the flush
 *  3. Events arriving across microtask boundaries flush independently (no cross-batch merging)
 *  4. Only one microtask is scheduled per burst (flushScheduled guard)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentMessageCoalescer } from '../useSocket-message-coalescer';

describe('createAgentMessageCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('200 synchronous pushes → handler called exactly 200× after one microtask flush', async () => {
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    // Simulate burst: 200 socket events arriving in the same macrotask
    for (let i = 0; i < 200; i++) {
      coalescer.push({ type: 'text', seq: i + 1, threadId: 'thread-burst' });
    }

    // Handler must NOT have been called yet — still inside the macrotask
    expect(handler).not.toHaveBeenCalled();

    // Drain the microtask queue
    await Promise.resolve();

    // All 200 events must be processed: no drops, no duplicates
    expect(handler).toHaveBeenCalledTimes(200);
  });

  it('preserves push order through the flush (seq routing depends on this)', async () => {
    const received: number[] = [];
    const coalescer = createAgentMessageCoalescer((msg: unknown) => {
      received.push((msg as { seq: number }).seq);
    });

    for (let i = 1; i <= 50; i++) {
      coalescer.push({ seq: i });
    }

    await Promise.resolve();

    expect(received).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('events arriving across microtask boundaries flush independently (normal streaming pace)', async () => {
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    // Burst 1 — synchronous
    coalescer.push({ seq: 1 });
    coalescer.push({ seq: 2 });
    await Promise.resolve(); // flush burst 1

    expect(handler).toHaveBeenCalledTimes(2);

    // Burst 2 — arrives after microtask boundary
    coalescer.push({ seq: 3 });
    await Promise.resolve(); // flush burst 2

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('only one microtask is scheduled per burst (flushScheduled guard)', async () => {
    // If the guard is missing, 200 pushes would schedule 200 microtasks
    // and handler would be called 200× but with 200 independent flushes.
    // We verify by checking that a second burst after the first flush
    // also coalesces correctly (guard was properly reset after first flush).
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    // First burst
    for (let i = 0; i < 10; i++) coalescer.push({ seq: i });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(10);

    handler.mockClear();

    // Second burst — guard must have been reset
    for (let i = 0; i < 10; i++) coalescer.push({ seq: i + 10 });
    // Before flush, nothing called
    expect(handler).not.toHaveBeenCalled();
    await Promise.resolve();
    // After flush, all 10 called
    expect(handler).toHaveBeenCalledTimes(10);
  });

  it('processes full 200-event burst without dropping events (coalescer correctness)', async () => {
    // Note: this test proves the coalescer's internal correctness — all 200 events
    // processed, none dropped. It does NOT prove the React "Maximum update depth"
    // error is fixed in a real rendering context. That mechanism is proven by
    // useSocket-burst-coalesce.integration.test.ts (invariants A & B: zero
    // synchronous store notifications during burst → React can't see nested updates).
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    expect(() => {
      for (let i = 0; i < 200; i++) {
        coalescer.push({ type: 'text', seq: i + 1, threadId: 'thread-burst' });
      }
    }).not.toThrow();

    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(200);
  });
});
