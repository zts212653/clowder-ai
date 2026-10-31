/**
 * Integration test: agent_message burst coalescing — zustand store behavior
 *
 * WHY this test exists:
 * The unit tests in useSocket-message-coalescer.test.ts prove the coalescer's
 * mechanical contract (push→flush→handler-calls). They do NOT prove that
 * the coalescer prevents React's "Maximum update depth exceeded" error.
 *
 * This test proves the MECHANISM that makes the React error impossible:
 *
 *   WITHOUT coalescer: 200 events × 4 chatStore.setState = 800 synchronous
 *   store notifications during the burst. zustand's listeners.forEach() runs
 *   synchronously on every set(). If a React component subscribes via
 *   useSyncExternalStore, each notification triggers a synchronous re-render.
 *   800 synchronous nested re-renders exceed React's 50-update limit → crash.
 *
 *   WITH coalescer (chunked flush): 0 store notifications during push phase.
 *   Each microtask flush processes at most CHUNK_SIZE events (~6 × 4 = 24
 *   notifications per microtask). React resets its nested update counter
 *   between microtasks → each chunk stays safely under the 50-update limit.
 *
 * This test proves invariant A (0 synchronous notifications during push) and
 * invariant B (notifications are spread across multiple microtasks, each
 * staying under the 50-update limit) directly using the real zustand store
 * subscription mechanism — the same one useSyncExternalStore builds on.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createAgentMessageCoalescer } from '../useSocket-message-coalescer';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal store that simulates chatStore's multi-setState-per-event pattern.
// Each agent_message event in production triggers ~4 chatStore.set() calls:
//   setLastSeq (chatStore.ts:1939) — the React blame frame
//   addMessage / updateCatStatus / setCatInvocation
// ─────────────────────────────────────────────────────────────────────────────

interface TestStore {
  lastSeq: number;
  messageCount: number;
  catStatus: string;
  invocationCount: number;
}

function createTestStore() {
  return createStore<TestStore>(() => ({
    lastSeq: 0,
    messageCount: 0,
    catStatus: 'idle',
    invocationCount: 0,
  }));
}

/** Simulate what handleAgentMessage → processThreadSeq does per event. */
function simulateHandleAgentMessage(store: ReturnType<typeof createTestStore>, seq: number): void {
  // 4 separate set() calls, mirroring the chatStore update pattern.
  // Each set() triggers zustand's listeners.forEach() synchronously.
  store.setState(() => ({ lastSeq: seq }));
  store.setState((s) => ({ messageCount: s.messageCount + 1 }));
  store.setState(() => ({ catStatus: 'streaming' }));
  store.setState((s) => ({ invocationCount: s.invocationCount + 1 }));
}

/** Drain all pending microtasks (chunked flush needs multiple ticks). */
async function drainMicrotasks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant A — document the bug (without coalescer)
// ─────────────────────────────────────────────────────────────────────────────

describe('WITHOUT coalescer (documents the bug)', () => {
  it('200 synchronous events → 800 synchronous store notifications during burst', () => {
    const store = createTestStore();

    const synchronousNotifications: number[] = [];
    let burstActive = false;

    const unsub = store.subscribe(() => {
      if (burstActive) {
        synchronousNotifications.push(store.getState().lastSeq);
      }
    });

    // Simulate the synchronous burst (what useSocket does today without the fix)
    burstActive = true;
    for (let seq = 1; seq <= 200; seq++) {
      simulateHandleAgentMessage(store, seq);
    }
    burstActive = false;

    // 200 events × 4 set() calls = 800 synchronous notifications during burst.
    // In React + useSyncExternalStore, each notification is a potential
    // synchronous re-render trigger. At 800, React's 50-nested-update limit
    // is exceeded → "Maximum update depth exceeded".
    expect(synchronousNotifications).toHaveLength(800);

    unsub();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant B — prove the fix (with chunked coalescer)
// ─────────────────────────────────────────────────────────────────────────────

describe('WITH coalescer (proves the fix)', () => {
  it('invariant A: 200 synchronous events → 0 synchronous notifications during push phase', async () => {
    const store = createTestStore();

    const synchronousNotifications: number[] = [];
    let burstActive = false;

    const unsub = store.subscribe(() => {
      if (burstActive) {
        synchronousNotifications.push(store.getState().lastSeq);
      }
    });

    const coalescer = createAgentMessageCoalescer((msg) => {
      const { seq } = msg as { seq: number };
      simulateHandleAgentMessage(store, seq);
    });

    // Fire the burst
    burstActive = true;
    for (let seq = 1; seq <= 200; seq++) {
      coalescer.push({ seq });
    }
    burstActive = false;

    // KEY ASSERTION: zero synchronous notifications during the push phase.
    // All 200 events are buffered; none has fired yet.
    // React's subscriber is never called synchronously → no nested update cascade.
    expect(synchronousNotifications).toHaveLength(0);

    // Drain all microtask chunks — all 200 events flush across multiple microtasks
    await drainMicrotasks();

    // After drain: store is fully up-to-date
    expect(store.getState().lastSeq).toBe(200);
    expect(store.getState().messageCount).toBe(200);
    expect(store.getState().invocationCount).toBe(200);

    unsub();
  });

  it('invariant B: each microtask chunk stays under 50 store notifications (React safety)', async () => {
    const store = createTestStore();

    // Track notifications per microtask tick
    const notificationsPerTick: number[] = [];
    let currentTickCount = 0;

    const unsub = store.subscribe(() => {
      currentTickCount++;
    });

    const coalescer = createAgentMessageCoalescer((msg) => {
      const { seq } = msg as { seq: number };
      simulateHandleAgentMessage(store, seq);
    });

    // Push 200 events
    for (let seq = 1; seq <= 200; seq++) {
      coalescer.push({ seq });
    }

    // Drain microtasks one at a time, recording notifications per tick
    for (let tick = 0; tick < 50; tick++) {
      currentTickCount = 0;
      await Promise.resolve();
      if (currentTickCount > 0) {
        notificationsPerTick.push(currentTickCount);
      }
      if (store.getState().lastSeq === 200) break;
    }

    // Every tick must stay under React's 50-nested-update limit.
    // With CHUNK_SIZE=6, each tick processes 6 events × 4 set() = 24 notifications.
    for (const count of notificationsPerTick) {
      expect(count).toBeLessThanOrEqual(50);
    }

    // All events were processed
    expect(store.getState().lastSeq).toBe(200);
    expect(store.getState().messageCount).toBe(200);

    unsub();
  });

  it('normal streaming pace (events across macrotasks) is unaffected', async () => {
    // Verify: when events arrive slowly (typical use), each event still gets
    // processed promptly in its own microtask. No artificial batching delay.
    const store = createTestStore();
    let processedCount = 0;

    const coalescer = createAgentMessageCoalescer((msg) => {
      const { seq } = msg as { seq: number };
      store.setState(() => ({ lastSeq: seq }));
      processedCount++;
    });

    // Event 1 arrives
    coalescer.push({ seq: 1 });
    await Promise.resolve(); // flush event 1
    expect(processedCount).toBe(1);
    expect(store.getState().lastSeq).toBe(1);

    // Event 2 arrives after a tick
    coalescer.push({ seq: 2 });
    await Promise.resolve(); // flush event 2
    expect(processedCount).toBe(2);
    expect(store.getState().lastSeq).toBe(2);

    // Normal pace: each event processed promptly, no extra latency
  });
});
