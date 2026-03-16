/**
 * Invocation Tracker (SlotTracker)
 * 追踪每个 thread 中每只猫的活跃调用 — per-thread-per-cat 多槽
 *
 * F108: ExecutionSlot(threadId, catId) 为并发执行的基本单元。
 * - 同一 catId 在同一 thread 仍保持单锁语义（新调用 abort 旧调用）
 * - 不同 catId 在同一 thread 可以并发执行
 */

interface ActiveInvocation {
  controller: AbortController;
  userId: string;
  catId: string;
  /** Cat(s) being invoked — used for cancel feedback broadcast */
  catIds: string[];
}

export interface CancelResult {
  cancelled: boolean;
  catIds: string[];
}

export interface DeleteGuard {
  /** Whether the guard was acquired (no active invocation at acquire time) */
  acquired: boolean;
  /** Release the guard after delete completes (success or failure) */
  release: () => void;
}

export class InvocationTracker {
  /** Key: `${threadId}:${catId}` (slotKey) */
  private active = new Map<string, ActiveInvocation>();
  private deleting = new Set<string>();

  private slotKey(threadId: string, catId: string): string {
    return `${threadId}:${catId}`;
  }

  /**
   * Start a new invocation for a slot (threadId + catId).
   * Only aborts existing invocation for the SAME slot — other cats' slots untouched.
   * If thread is being deleted, returns a pre-aborted controller.
   */
  start(threadId: string, catId: string, userId: string = 'unknown', catIds: string[] = []): AbortController {
    if (this.deleting.has(threadId)) {
      const controller = new AbortController();
      controller.abort();
      return controller;
    }
    const key = this.slotKey(threadId, catId);
    // Abort existing invocation for this SAME slot only
    this.active.get(key)?.controller.abort('preempted');
    const controller = new AbortController();
    this.active.set(key, { controller, userId, catId, catIds });
    return controller;
  }

  /**
   * F122 Phase A.1: Non-preemptive thread-level start.
   * Atomically checks if ANY slot in the thread is active (or deleting),
   * then registers the new slot — all in one synchronous operation.
   *
   * Returns AbortController on success, null if thread is busy or deleting.
   * Unlike start(), this NEVER aborts existing invocations.
   */
  tryStartThread(
    threadId: string,
    catId: string,
    userId: string = 'unknown',
    catIds: string[] = [],
  ): AbortController | null {
    if (this.deleting.has(threadId)) return null;
    if (this.has(threadId)) return null;
    const controller = new AbortController();
    const key = this.slotKey(threadId, catId);
    this.active.set(key, { controller, userId, catId, catIds });
    return controller;
  }

  /**
   * Atomically check-and-guard for thread deletion.
   * Synchronous: checks ALL slots + marks deleting in one tick.
   * Caller MUST call release() in a finally block after delete completes.
   */
  guardDelete(threadId: string): DeleteGuard {
    if (this.deleting.has(threadId)) {
      return { acquired: false, release: () => {} };
    }
    // Check if ANY slot is active for this thread
    if (this.has(threadId)) {
      return { acquired: false, release: () => {} };
    }
    this.deleting.add(threadId);
    return {
      acquired: true,
      release: () => this.deleting.delete(threadId),
    };
  }

  /**
   * Cancel an active invocation for a specific slot.
   * If requestUserId is provided, only cancels if it matches the invocation owner.
   * Optional abortReason is forwarded to AbortController.abort(reason).
   */
  cancel(threadId: string, catId: string, requestUserId?: string, abortReason?: string): CancelResult {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return { cancelled: false, catIds: [] };
    if (requestUserId && inv.userId !== requestUserId) return { cancelled: false, catIds: [] };
    const { catIds } = inv;
    inv.controller.abort(abortReason);
    this.active.delete(key);
    return { cancelled: true, catIds };
  }

  /** Cancel ALL active slots for a thread (e.g., thread deletion). */
  cancelAll(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix)) {
        inv.controller.abort();
        this.active.delete(key);
      }
    }
  }

  /** Get the userId who started the invocation for a specific slot. */
  getUserId(threadId: string, catId: string): string | null {
    const key = this.slotKey(threadId, catId);
    return this.active.get(key)?.userId ?? null;
  }

  /** Get target cat IDs of the active invocation for a specific slot. */
  getCatIds(threadId: string, catId: string): string[] {
    const key = this.slotKey(threadId, catId);
    return this.active.get(key)?.catIds ?? [];
  }

  /** Mark an invocation as complete (cleanup). Only removes if controller matches. */
  complete(threadId: string, catId: string, controller?: AbortController): void {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return;
    if (controller && inv.controller !== controller) return;
    this.active.delete(key);
  }

  /**
   * Whether a thread/slot has an active invocation.
   * - has(threadId, catId) — specific slot check
   * - has(threadId) — any slot active in thread?
   */
  has(threadId: string, catId?: string): boolean {
    if (catId) {
      return this.active.has(this.slotKey(threadId, catId));
    }
    // Thread-level: check if ANY slot is active
    const prefix = `${threadId}:`;
    for (const key of this.active.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Get all active catIds for a thread. */
  getActiveSlots(threadId: string): string[] {
    const prefix = `${threadId}:`;
    const result: string[] = [];
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix)) {
        result.push(inv.catId);
      }
    }
    return result;
  }

  /** Whether a thread is currently being deleted (delete guard active). */
  isDeleting(threadId: string): boolean {
    return this.deleting.has(threadId);
  }
}
