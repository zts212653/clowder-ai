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

export interface SessionLockOwner {
  key: string;
  /** Per-cat child registry id, retained for diagnostics. */
  invocationId: string;
  /** Parent execution identity shared with InvocationTracker terminal actions. */
  executionId: string;
  threadId: string;
  catId: string;
  userId: string;
  acquiredAt: number;
}

export interface SessionLockScope {
  threadId: string;
  userId: string;
  catId?: string;
}

export interface ForceReleaseResult {
  releasedHolders: number;
  rejectedWaiters: number;
  /** Cats whose holder or waiter was force-released, for terminal UI/slot cleanup. */
  catIds?: string[];
}

export interface ForceReleaseOptions {
  /**
   * Exact runners that were just aborted. Their holders must remain until
   * invokeSingleCat reaches finally; only matching queued waiters are rejected.
   *
   * This is execution-scoped deliberately: a newer execution for the same cat
   * may be queued behind an orphaned holder from an older invocation. Cat-level
   * preservation would reject the live waiter while preserving the orphan.
   */
  preserveHolderExecutionIds?: readonly string[];
}

interface Waiter {
  owner?: SessionLockOwner;
  resolve: () => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

interface HeldLock {
  owner?: SessionLockOwner;
  token: symbol;
}

export class SessionMutex {
  /** Currently held locks: sessionId → release resolver */
  private held = new Map<string, HeldLock>();
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
  async acquire(sessionIdOrOwner: string | SessionLockOwner, signal?: AbortSignal): Promise<() => void> {
    const owner = typeof sessionIdOrOwner === 'string' ? undefined : sessionIdOrOwner;
    const sessionId = typeof sessionIdOrOwner === 'string' ? sessionIdOrOwner : sessionIdOrOwner.key;
    // Fast path: check abort before anything
    if (signal?.aborted) {
      throw new Error(`SessionMutex acquire aborted for session ${sessionId}`);
    }

    // No contention — acquire immediately
    if (!this.held.has(sessionId)) {
      return this.lock(sessionId, owner);
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
        owner,
        resolve: () => {
          cleanup();
          resolve(this.lock(sessionId, owner));
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

  /**
   * Force-release agent-owned locks within an authenticated invocation scope.
   * String-only legacy locks have no owner metadata and are intentionally left
   * untouched.
   */
  forceReleaseByScope(scope: SessionLockScope, options: ForceReleaseOptions = {}): ForceReleaseResult {
    let releasedHolders = 0;
    let rejectedWaiters = 0;
    const catIds = new Set<string>();
    const preservedHolderExecutions = new Set(options.preserveHolderExecutionIds ?? []);

    for (const [sessionId, queue] of this.waiters) {
      const survivors: Waiter[] = [];
      for (const waiter of queue) {
        if (this.matchesScope(waiter.owner, scope)) {
          if (waiter.owner) catIds.add(waiter.owner.catId);
          waiter.cleanup();
          waiter.reject(new Error(`SessionMutex force released for session ${sessionId}`));
          rejectedWaiters++;
        } else {
          survivors.push(waiter);
        }
      }
      if (survivors.length > 0) this.waiters.set(sessionId, survivors);
      else this.waiters.delete(sessionId);
    }

    // Snapshot the holders that existed when reset began. drainNext() resolves
    // synchronously and may install a new holder for the same scope; iterating
    // the live Map would revisit that insertion and force-release fresh work.
    for (const [sessionId, held] of [...this.held]) {
      if (!this.matchesScope(held.owner, scope)) continue;
      // A preserved holder is owned by a runner that was aborted in this exact
      // terminal action. Its invokeSingleCat finally remains the authoritative
      // release. Any other matching holder is orphan recovery and is safe to
      // release; a later stale release cannot delete a replacement because lock()
      // guards ownership with a per-acquisition token.
      if (held.owner && preservedHolderExecutions.has(held.owner.executionId)) continue;
      if (held.owner) catIds.add(held.owner.catId);
      this.held.delete(sessionId);
      releasedHolders++;
      this.drainNext(sessionId);
    }

    return { releasedHolders, rejectedWaiters, catIds: [...catIds] };
  }

  /** Create a lock entry and return an idempotent release function. */
  private lock(sessionId: string, owner?: SessionLockOwner): () => void {
    let released = false;
    const token = Symbol(sessionId);
    const release = (): void => {
      if (released) return;
      released = true;
      if (this.held.get(sessionId)?.token !== token) return;
      this.held.delete(sessionId);
      this.drainNext(sessionId);
    };
    this.held.set(sessionId, { owner, token });
    return release;
  }

  private matchesScope(owner: SessionLockOwner | undefined, scope: SessionLockScope): boolean {
    return (
      owner !== undefined &&
      owner.threadId === scope.threadId &&
      owner.userId === scope.userId &&
      (scope.catId === undefined || owner.catId === scope.catId)
    );
  }

  /** Wake the next waiter in queue, if any. */
  private drainNext(sessionId: string): void {
    const queue = this.waiters.get(sessionId);
    if (!queue || queue.length === 0) {
      this.waiters.delete(sessionId);
      return;
    }
    const next = queue.shift();
    if (!next) {
      this.waiters.delete(sessionId);
      return;
    }
    if (queue.length === 0) this.waiters.delete(sessionId);
    next.resolve();
  }
}
