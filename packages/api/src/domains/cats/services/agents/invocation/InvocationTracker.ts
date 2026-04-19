/**
 * Invocation Tracker (SlotTracker)
 * 追踪每个 thread 中每只猫的活跃调用 — per-thread-per-cat 多槽
 *
 * F108: ExecutionSlot(threadId, catId) 为并发执行的基本单元。
 * - 同一 catId 在同一 thread 仍保持单锁语义（新调用 abort 旧调用）
 * - 不同 catId 在同一 thread 可以并发执行
 *
 * F118 D3: TTL guard — slots exceeding maxSlotTtlMs are auto-cleaned on read.
 */

import { resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';

interface ActiveInvocation {
  controller: AbortController;
  userId: string;
  catId: string;
  /** Cat(s) being invoked — used for cancel feedback broadcast */
  catIds: string[];
  /** Server-side wall-clock start time (ms since epoch) */
  startedAt: number;
  /** For startAll slots: reference to primaryCat's controller (batch identity for completeAll) */
  batchController?: AbortController;
}

export interface ActiveSlotInfo {
  catId: string;
  startedAt: number;
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
  /** F118 D3: max age before a slot is considered stale (default 2.5× CLI timeout = 75min) */
  private maxSlotTtlMs: number;

  constructor(opts?: { maxSlotTtlMs?: number }) {
    this.maxSlotTtlMs = opts?.maxSlotTtlMs ?? 2.5 * resolveCliTimeoutMs(undefined);
  }

  private slotKey(threadId: string, catId: string): string {
    return `${threadId}:${catId}`;
  }

  /** F118 D3: Check if an invocation has exceeded the TTL. Auto-deletes if expired. */
  private isExpired(key: string, inv: ActiveInvocation): boolean {
    if (Date.now() - inv.startedAt > this.maxSlotTtlMs) {
      this.active.delete(key);
      return true;
    }
    return false;
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
    this.active.set(key, { controller, userId, catId, catIds, startedAt: Date.now() });
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
    this.active.set(key, { controller, userId, catId, catIds, startedAt: Date.now() });
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

  /**
   * Cancel ALL active slots for a thread.
   * F156: When requestUserId is provided, only cancels invocations owned by that user.
   * Without requestUserId, cancels all (system/admin action, e.g. thread deletion).
   * Returns the catIds that were actually cancelled (for orchestrator scoping).
   */
  cancelAll(threadId: string, requestUserId?: string): string[] {
    const prefix = `${threadId}:`;
    const cancelledCatIds: string[] = [];
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix)) {
        if (requestUserId && inv.userId !== requestUserId) continue;
        cancelledCatIds.push(inv.catId);
        inv.controller.abort();
        this.active.delete(key);
      }
    }
    return cancelledCatIds;
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
   * Mark a SINGLE slot from a batch invocation as complete.
   * Unlike complete(), this also matches batchController so a startAll()/tryStartThreadAll()
   * caller can retire finished cats one-by-one without waiting for the whole batch.
   */
  completeSlot(threadId: string, catId: string, controller?: AbortController): void {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return;
    if (controller && inv.controller !== controller && inv.batchController !== controller) return;
    this.active.delete(key);
  }

  /**
   * Whether a thread/slot has an active invocation.
   * - has(threadId, catId) — specific slot check
   * - has(threadId) — any slot active in thread?
   */
  has(threadId: string, catId?: string): boolean {
    if (catId) {
      const key = this.slotKey(threadId, catId);
      const inv = this.active.get(key);
      if (!inv) return false;
      return !this.isExpired(key, inv);
    }
    // Thread-level: check if ANY non-expired slot is active
    const prefix = `${threadId}:`;
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix) && !this.isExpired(key, inv)) return true;
    }
    return false;
  }

  /**
   * Start tracking ALL target cats for a unified multi-cat dispatch.
   * Each cat gets its own independent AbortController (per-cat cancel safe).
   * Returns the primaryCat's (catIds[0]) controller for execution signal.
   * All slots share a `batchController` ref so completeAll can match the batch.
   */
  startAll(threadId: string, catIds: string[], userId: string = 'unknown'): AbortController {
    if (this.deleting.has(threadId)) {
      const controller = new AbortController();
      controller.abort();
      return controller;
    }
    const now = Date.now();
    let primaryController: AbortController | undefined;
    for (const catId of catIds) {
      const key = this.slotKey(threadId, catId);
      this.active.get(key)?.controller.abort('preempted');
      const controller = new AbortController();
      primaryController ??= controller;
      this.active.set(key, { controller, userId, catId, catIds, startedAt: now, batchController: primaryController });
    }
    return primaryController ?? new AbortController();
  }

  /**
   * Non-preemptive thread-level start for ALL target cats.
   * Atomically checks if ANY slot is active, then registers all cats with independent controllers.
   */
  tryStartThreadAll(threadId: string, catIds: string[], userId: string = 'unknown'): AbortController | null {
    if (this.deleting.has(threadId)) return null;
    if (this.has(threadId)) return null;
    const now = Date.now();
    let primaryController: AbortController | undefined;
    for (const catId of catIds) {
      const key = this.slotKey(threadId, catId);
      const controller = new AbortController();
      primaryController ??= controller;
      this.active.set(key, { controller, userId, catId, catIds, startedAt: now, batchController: primaryController });
    }
    return primaryController ?? new AbortController();
  }

  /**
   * Complete ALL slots for the given cats.
   * Matches via controller OR batchController — safe for startAll batches
   * where each cat has an independent controller but shares batchController.
   */
  completeAll(threadId: string, catIds: string[], controller?: AbortController): void {
    for (const catId of catIds) {
      const key = this.slotKey(threadId, catId);
      const inv = this.active.get(key);
      if (!inv) continue;
      if (controller) {
        if (inv.controller !== controller && inv.batchController !== controller) continue;
      }
      this.active.delete(key);
    }
  }

  /** Get all active slot info for a thread (catId + startedAt for F5 recovery). */
  getActiveSlots(threadId: string): ActiveSlotInfo[] {
    const prefix = `${threadId}:`;
    const result: ActiveSlotInfo[] = [];
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix) && !this.isExpired(key, inv)) {
        result.push({ catId: inv.catId, startedAt: inv.startedAt });
      }
    }
    return result;
  }

  /** Whether a thread is currently being deleted (delete guard active). */
  isDeleting(threadId: string): boolean {
    return this.deleting.has(threadId);
  }
}
