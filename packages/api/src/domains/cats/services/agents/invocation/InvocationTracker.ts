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
  /** For startAll slots: reference to the INDEPENDENT batch gate controller (whole-invocation
   *  abort — F-parallel-cancel). NOT a per-cat controller. */
  batchController?: AbortController;
  /**
   * F-parallel-cancel tombstone: 'active' = running; 'canceled' = single-cat cancelled but the
   * slot is RETAINED so getController() still returns the aborted controller. This is critical for
   * "pre-invoke cancel": a cat cancelled before the route layer grabbed its own signal must still
   * see an aborted signal (not fall back to the batch gate). Tombstones are inactive for has()/
   * busy gates and are purged at the next start-family or complete-family call for the slot.
   */
  state: 'active' | 'canceled';
  /** Abort reason recorded at cancel time (e.g. 'user_cancel' / 'preempted'). */
  cancelReason?: string;
}

/** F-parallel-cancel: observable slot lifecycle state for callers that need to distinguish
 *  "no slot" from "cancelled tombstone". */
export type SlotState = 'active' | 'canceled' | 'absent';

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
    this.active.set(key, { controller, userId, catId, catIds, startedAt: Date.now(), state: 'active' });
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
    this.active.set(key, { controller, userId, catId, catIds, startedAt: Date.now(), state: 'active' });
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
    // F-parallel-cancel: tombstone — do NOT delete the slot. Keep it as a 'canceled' tombstone so
    // getController() still returns the aborted controller for a cat cancelled BEFORE the route
    // layer grabbed its own signal (pre-invoke cancel must not be lost / fall back to the batch
    // gate). Purged at the next start-family or complete-family call for this slot.
    inv.state = 'canceled';
    inv.cancelReason = abortReason;
    return { cancelled: true, catIds };
  }

  /**
   * Cancel ALL active slots for a thread.
   * F156: When requestUserId is provided, only cancels invocations owned by that user.
   * Without requestUserId, cancels all (system/admin action, e.g. thread deletion).
   * Returns the catIds that were actually cancelled (for orchestrator scoping).
   */
  cancelAll(threadId: string, requestUserId?: string, abortReason?: string): string[] {
    const prefix = `${threadId}:`;
    const cancelledCatIds: string[] = [];
    // F-parallel-cancel: cancelAll is the "stop the whole invocation" path (force-reset /
    // cancel_all button), so it must abort the INDEPENDENT batch gate too — single-cat cancel
    // does NOT (see startAll). Collect + dedup batch controllers of the slots we cancel.
    const batchControllers = new Set<AbortController>();
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix)) {
        if (requestUserId && inv.userId !== requestUserId) continue;
        cancelledCatIds.push(inv.catId);
        inv.controller.abort(abortReason);
        if (inv.batchController) batchControllers.add(inv.batchController);
        this.active.delete(key);
      }
    }
    for (const bc of batchControllers) bc.abort(abortReason);
    return cancelledCatIds;
  }

  /**
   * F-parallel-cancel (cloud #6 2026-05-30): SCOPED preempt — cancel only the invocation(s) the
   * given anchor cats belong to (their shared batch gate + every slot under it), NOT the whole
   * thread. `force` delivery uses this so preempting @codex doesn't also abort an unrelated `opus`
   * side-dispatch (whisper to an idle cat) running in the same thread. cancelAll() stays the
   * whole-thread reset (cancel_all button / thread delete). Returns cancelled catIds for broadcast.
   */
  cancelInvocation(threadId: string, anchorCats: string[], requestUserId?: string, abortReason?: string): string[] {
    const prefix = `${threadId}:`;
    const anchorSet = new Set(anchorCats);
    // 1. Resolve the batch gate(s) the anchor cats belong to.
    const targetBatches = new Set<AbortController>();
    for (const catId of anchorCats) {
      const inv = this.active.get(this.slotKey(threadId, catId));
      if (!inv) continue;
      if (requestUserId && inv.userId !== requestUserId) continue;
      if (inv.batchController) targetBatches.add(inv.batchController);
    }
    // 2. Cancel the anchors themselves + any slot sharing a target batch gate (the anchor's whole
    //    invocation, incl. multi-cat siblings). Slots under a DIFFERENT batch (or a standalone
    //    side-dispatch) are left running — that is the whole point vs cancelAll().
    const cancelledCatIds: string[] = [];
    for (const [key, inv] of this.active) {
      if (!key.startsWith(prefix)) continue;
      if (requestUserId && inv.userId !== requestUserId) continue;
      const isAnchor = anchorSet.has(inv.catId);
      const sharesBatch = inv.batchController !== undefined && targetBatches.has(inv.batchController);
      if (!isAnchor && !sharesBatch) continue;
      cancelledCatIds.push(inv.catId);
      inv.controller.abort(abortReason);
      this.active.delete(key);
    }
    for (const bc of targetBatches) bc.abort(abortReason);
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

  /**
   * Get the AbortController for a specific slot, so the execution layer can subscribe
   * to a cat's OWN cancel signal (per-cat isolation). Returns undefined if there is no
   * active (non-expired) slot.
   *
   * F-parallel-cancel: startAll/tryStartThreadAll give each cat an INDEPENDENT controller
   * but only RETURN primaryController (catIds[0]'s). Concurrent execution must resolve
   * each cat's signal through this getter — using the shared primaryController.signal made
   * "cancel one cat" abort all siblings (and "cancel a non-primary cat" abort nothing).
   */
  getController(threadId: string, catId: string): AbortController | undefined {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return undefined;
    if (this.isExpired(key, inv)) return undefined;
    // NOTE: a 'canceled' tombstone intentionally still returns its (now aborted) controller —
    // that is the whole point of the tombstone (pre-invoke cancel must surface an aborted signal).
    return inv.controller;
  }

  /**
   * F-parallel-cancel: observable slot lifecycle state — distinguishes 'absent' (no slot),
   * 'canceled' (cancelled tombstone), and 'active'. Lets callers tell "this cat was singly
   * cancelled" apart from "never tracked" without relying on raw undefined (which conflates the
   * two and re-creates the false-green route gap).
   */
  getSlotState(threadId: string, catId: string): SlotState {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return 'absent';
    if (this.isExpired(key, inv)) return 'absent';
    return inv.state;
  }

  /**
   * F-parallel-cancel: aggregate final status of a (possibly multi-cat) invocation, per the model
   * agreed with 砚砚:
   *  - whole-invocation abort (batch gate aborted: cancelAll / force / thread-delete / preempt)
   *    → 'canceled_by_user' (user_cancel/cancel_all reason) or 'canceled' (other reasons)
   *  - else if EVERY target cat is a canceled tombstone → 'canceled_by_user' (cancelled cat-by-cat)
   *  - else → 'succeeded' (at least one cat ran to completion)
   * `controller.signal.aborted` alone now means ONLY whole-invocation abort — a single-cat cancel
   * no longer aborts the batch gate, so callers must use this aggregate rather than raw `.aborted`.
   */
  resolveFinalStatus(
    threadId: string,
    targetCats: readonly string[],
    batch: { aborted: boolean; reason?: string },
  ): 'succeeded' | 'canceled' | 'canceled_by_user' {
    if (batch.aborted) {
      return batch.reason === 'user_cancel' || batch.reason === 'cancel_all' ? 'canceled_by_user' : 'canceled';
    }
    if (targetCats.length === 0) return 'succeeded';
    const allCanceled = targetCats.every((c) => this.getSlotState(threadId, c) === 'canceled');
    return allCanceled ? 'canceled_by_user' : 'succeeded';
  }

  /** Mark an invocation as complete (cleanup). Only removes if controller matches. */
  complete(threadId: string, catId: string, controller?: AbortController): void {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return;
    if (controller && inv.controller !== controller) return;
    // F-parallel-cancel (cloud P1): keep a CANCELED tombstone so aggregate resolveFinalStatus()
    // still sees this cat was cancelled. Route consumers call complete/completeSlot on the
    // abort-induced terminal (error/done) message BEFORE the aggregate finalStatus check; deleting
    // here would make getSlotState() return 'absent' → 'succeeded' even though the user cancelled.
    // Canceled tombstones are purged on the next start*/tryStart* for the slot (re-occupation).
    if (inv.state === 'canceled') return;
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
    // F-parallel-cancel (cloud P1): keep a CANCELED tombstone (see complete()) — completeSlot is
    // exactly the call route consumers fire on the abort-induced terminal message BEFORE the
    // aggregate finalStatus check, so deleting a canceled slot here would lose the cancellation
    // and resolveFinalStatus() would wrongly return 'succeeded'.
    if (inv.state === 'canceled') return;
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
      // F-parallel-cancel: a canceled tombstone is INACTIVE (slot retained only so getController
      // can still hand back the aborted controller for a pre-invoke cancel).
      if (inv.state === 'canceled') return false;
      return !this.isExpired(key, inv);
    }
    // Thread-level: check if ANY non-expired, non-canceled slot is active
    const prefix = `${threadId}:`;
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix) && inv.state !== 'canceled' && !this.isExpired(key, inv)) return true;
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
    // F-parallel-cancel: batchController is the "whole-invocation gate" — INDEPENDENT from any
    // per-cat controller. Canceling one cat aborts only that cat's own controller, NOT this batch
    // controller, so upper consumers that gate on the returned controller (messages.ts pre-check /
    // QueueProcessor break + record-canceled) don't mistake a single-cat cancel for a
    // whole-invocation cancel. cancelAll aborts the batch controller. Per-cat execution signals are
    // resolved via getController(threadId, catId) (route layer signalForCat), not this return value.
    const batchController = new AbortController();
    for (const catId of catIds) {
      const key = this.slotKey(threadId, catId);
      this.active.get(key)?.controller.abort('preempted');
      const controller = new AbortController();
      this.active.set(key, { controller, userId, catId, catIds, startedAt: now, batchController, state: 'active' });
    }
    return batchController;
  }

  /**
   * Track an additional slot that is executed by an already-running route.
   * Used by routeSerial A2A worklist targets so thread-level queue gates stay
   * busy after the original cat completes and before the A2A target runs.
   */
  trackExternalSlot(
    threadId: string,
    catId: string,
    controller: AbortController,
    userId: string = 'unknown',
    catIds: string[] = [catId],
  ): boolean {
    if (this.deleting.has(threadId)) return false;
    const key = this.slotKey(threadId, catId);
    const existing = this.active.get(key);
    if (existing && !this.isExpired(key, existing)) {
      // Idempotent if this slot already tracks the same batch. The passed `controller` is the
      // batch gate (route-serial's options.invocationController), stored as batchController below.
      return existing.batchController === controller || existing.controller === controller;
    }
    // F-parallel-cancel (cloud #5 2026-05-30): the passed `controller` is route-serial's BATCH GATE
    // (options.invocationController = startAll() return value). Storing it as slot.controller would
    // make cancel(threadId, catB) abort the batch gate → the whole serial worklist stops when the
    // user only cancelled the pending A2A target. Give the A2A slot its OWN controller so a
    // single-cat cancel (getController → signalForCat → this controller) stops only catB; keep the
    // batch gate as batchController so cancelAll (whole-invocation stop) still cascades.
    this.active.set(key, {
      controller: new AbortController(),
      userId,
      catId,
      catIds,
      startedAt: Date.now(),
      batchController: controller,
      state: 'active',
    });
    return true;
  }

  /**
   * Non-preemptive thread-level start for ALL target cats.
   * Atomically checks if ANY slot is active, then registers all cats with independent controllers.
   */
  tryStartThreadAll(threadId: string, catIds: string[], userId: string = 'unknown'): AbortController | null {
    if (this.deleting.has(threadId)) return null;
    if (this.has(threadId)) return null;
    const now = Date.now();
    // F-parallel-cancel: independent batch gate (see startAll) — single-cat cancel must not trip
    // the whole-invocation gate; per-cat signals come from getController(threadId, catId).
    const batchController = new AbortController();
    for (const catId of catIds) {
      const key = this.slotKey(threadId, catId);
      const controller = new AbortController();
      this.active.set(key, { controller, userId, catId, catIds, startedAt: now, batchController, state: 'active' });
    }
    return batchController;
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
      // F-parallel-cancel (cloud P1): keep CANCELED tombstones (see complete()) — consistent with
      // complete/completeSlot so aggregate resolveFinalStatus() never loses cancellation state.
      // Purged on next start*/tryStart* re-occupation (+ TTL as backstop).
      if (inv.state === 'canceled') continue;
      this.active.delete(key);
    }
  }

  /** Get all active slot info for a thread (catId + startedAt for F5 recovery). */
  getActiveSlots(threadId: string): ActiveSlotInfo[] {
    const prefix = `${threadId}:`;
    const result: ActiveSlotInfo[] = [];
    for (const [key, inv] of this.active) {
      // F-parallel-cancel: a canceled tombstone is not an active slot.
      if (key.startsWith(prefix) && inv.state !== 'canceled' && !this.isExpired(key, inv)) {
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
