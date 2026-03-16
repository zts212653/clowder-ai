/**
 * SessionMutex — per-cliSessionId serialization lock
 *
 * F118: Prevents concurrent `resume` of the same CLI session.
 * Default strategy: queue / fail-fast (no preemption of healthy requests).
 *
 * Scope: process-level (same lifetime as InvocationTracker).
 * Does NOT modify InvocationTracker — that guards threadId:catId slots,
 * this guards cliSessionId uniqueness.
 */

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

export class SessionMutex {
  /** Currently held locks: sessionId → release resolver */
  private held = new Map<string, { release: () => void }>();
  /** Waiters queued behind a held lock */
  private waiters = new Map<string, Waiter[]>();

  /**
   * Acquire exclusive access for a cliSessionId.
   * - No contention → resolves immediately with a release function.
   * - Contention → queues until the current holder releases.
   * - If `signal` is aborted while waiting → rejects with an error.
   *
   * The returned release function is idempotent (safe to call multiple times).
   */
  async acquire(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    // Fast path: check abort before anything
    if (signal?.aborted) {
      throw new Error(`SessionMutex acquire aborted for session ${sessionId}`);
    }

    // No contention — acquire immediately
    if (!this.held.has(sessionId)) {
      return this.lock(sessionId);
    }

    // Contention — queue and wait
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        // Remove this waiter from the queue
        const queue = this.waiters.get(sessionId);
        if (queue) {
          const idx = queue.indexOf(waiter);
          if (idx !== -1) queue.splice(idx, 1);
          if (queue.length === 0) this.waiters.delete(sessionId);
        }
        reject(new Error(`SessionMutex acquire aborted for session ${sessionId}`));
      };

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };

      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve(this.lock(sessionId));
        },
        reject,
        cleanup,
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      let queue = this.waiters.get(sessionId);
      if (!queue) {
        queue = [];
        this.waiters.set(sessionId, queue);
      }
      queue.push(waiter);
    });
  }

  /** Create a lock entry and return an idempotent release function. */
  private lock(sessionId: string): () => void {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.held.delete(sessionId);
      this.drainNext(sessionId);
    };
    this.held.set(sessionId, { release });
    return release;
  }

  /** Wake the next waiter in queue, if any. */
  private drainNext(sessionId: string): void {
    const queue = this.waiters.get(sessionId);
    if (!queue || queue.length === 0) {
      this.waiters.delete(sessionId);
      return;
    }
    const next = queue.shift()!;
    if (queue.length === 0) this.waiters.delete(sessionId);
    next.resolve();
  }
}
