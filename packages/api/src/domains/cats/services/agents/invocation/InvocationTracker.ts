/**
 * Invocation Tracker
 * 追踪每个 thread 的活跃调用，支持取消 + userId 鉴权
 *
 * 每个 thread 同一时刻最多一个活跃调用。
 * 新调用自动 abort 旧调用（防止并发冲突）。
 */

interface ActiveInvocation {
  controller: AbortController;
  userId: string;
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
  private active = new Map<string, ActiveInvocation>();
  private deleting = new Set<string>();

  /**
   * Start a new invocation for a thread. Returns the AbortController.
   * If thread is being deleted, returns a pre-aborted controller so the
   * agent stops immediately via signal.aborted.
   */
  start(threadId: string, userId: string = 'unknown', catIds: string[] = []): AbortController {
    if (this.deleting.has(threadId)) {
      const controller = new AbortController();
      controller.abort();
      return controller;
    }
    // Abort any existing invocation for this thread (preempted by new invocation)
    this.active.get(threadId)?.controller.abort('preempted');
    const controller = new AbortController();
    this.active.set(threadId, { controller, userId, catIds });
    return controller;
  }

  /**
   * Atomically check-and-guard for thread deletion.
   * Synchronous: checks active + marks deleting in one tick (no async gap).
   * Caller MUST call release() in a finally block after the delete completes.
   */
  guardDelete(threadId: string): DeleteGuard {
    if (this.active.has(threadId) || this.deleting.has(threadId)) {
      return { acquired: false, release: () => {} };
    }
    this.deleting.add(threadId);
    return {
      acquired: true,
      release: () => this.deleting.delete(threadId),
    };
  }

  /**
   * Cancel an active invocation. Returns cancel result with catIds for broadcast.
   * If requestUserId is provided, only cancels if it matches the invocation owner.
   * Optional abortReason is forwarded to AbortController.abort(reason).
   */
  cancel(threadId: string, requestUserId?: string, abortReason?: string): CancelResult {
    const inv = this.active.get(threadId);
    if (!inv) return { cancelled: false, catIds: [] };
    if (requestUserId && inv.userId !== requestUserId) return { cancelled: false, catIds: [] };
    const { catIds } = inv;
    inv.controller.abort(abortReason);
    this.active.delete(threadId);
    return { cancelled: true, catIds };
  }

  /** Get the userId who started the invocation. */
  getUserId(threadId: string): string | null {
    return this.active.get(threadId)?.userId ?? null;
  }

  /** Get target cat IDs of the active invocation for a thread. */
  getCatIds(threadId: string): string[] {
    return this.active.get(threadId)?.catIds ?? [];
  }

  /** Mark an invocation as complete (cleanup). Only removes if controller matches. */
  complete(threadId: string, controller?: AbortController): void {
    const inv = this.active.get(threadId);
    if (!inv) return;
    if (controller && inv.controller !== controller) return;
    this.active.delete(threadId);
  }

  /** Whether a thread has an active invocation. */
  has(threadId: string): boolean {
    return this.active.has(threadId);
  }

  /** Whether a thread is currently being deleted (delete guard active). */
  isDeleting(threadId: string): boolean {
    return this.deleting.has(threadId);
  }
}
