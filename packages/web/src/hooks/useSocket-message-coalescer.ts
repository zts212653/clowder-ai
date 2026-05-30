/**
 * createAgentMessageCoalescer — clowder-ai#789
 *
 * Coalesces synchronous bursts of agent_message socket events into a single
 * microtask flush to prevent "Maximum update depth exceeded" under high-frequency
 * streaming.
 *
 * Root cause: each socket event dispatched synchronously → multiple chatStore.setState
 * per event → useSyncExternalStore bypasses React 18 automatic batching → >50 nested
 * update depth → React throws.
 *
 * Fix: buffer events that arrive in the same macrotask, flush them all in one
 * queueMicrotask. React 18 treats the entire microtask as one batch unit.
 *
 * Design contract:
 *  - Every event is processed; nothing is dropped or merged.
 *  - Push order within a macrotask is preserved (FIFO flush).
 *  - processThreadSeq runs per-event inside the flush loop, unchanged.
 *    Zustand set() is synchronous — each event's store write is visible to
 *    the next event's getState() call inside the same flush.
 *  - Events arriving across macrotask boundaries each get their own flush.
 *    At normal streaming pace (one event per ~50ms) this is zero overhead.
 */

type AgentMessageHandler = (msg: unknown) => void;

export interface AgentMessageCoalescer {
  push: (msg: unknown) => void;
}

export function createAgentMessageCoalescer(handler: AgentMessageHandler): AgentMessageCoalescer {
  const queue: unknown[] = [];
  let flushScheduled = false;

  function flush(): void {
    // Snapshot and clear before the loop so events that arrive during
    // the flush (not possible with queueMicrotask, but defensive against
    // future RAF refactors) go into the next microtask, not this one.
    const batch = queue.splice(0);
    flushScheduled = false;

    for (const msg of batch) {
      handler(msg);
    }
  }

  return {
    push(msg: unknown): void {
      queue.push(msg);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
  };
}
