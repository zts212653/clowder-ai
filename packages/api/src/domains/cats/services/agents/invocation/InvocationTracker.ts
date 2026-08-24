/**
 * Invocation Tracker (SlotTracker)
 * 追踪每个 thread 中每只猫的活跃调用 — per-thread-per-cat 多槽
 *
 * F108: ExecutionSlot(threadId, catId) 为并发执行的基本单元。
 * - 同一 catId 在同一 thread 仍保持单锁语义（新调用 abort 旧调用）
 * - 不同 catId 在同一 thread 可以并发执行
 *
 * F118 post-close: age only marks a lease as a reaper candidate. Read APIs are
 * observational and never abort or delete provider ownership.
 */
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('invocation-tracker');
export const DEFAULT_INVOCATION_SLOT_TTL_MS = 75 * 60_000;

interface ActiveInvocation {
  controller: AbortController;
  threadId: string;
  /** Parent execution identity for exact terminal ownership / mutex recovery. */
  executionId?: string;
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
  /**
   * #1313: Whether the provider teardown after cancel has called complete()/completeSlot().
   * A canceled tombstone with teardownComplete=false blocks guardSessionSeal() — "Stop" followed
   * by an immediate "Seal" must wait until the route layer finishes its cleanup. Once teardown
   * completes, the tombstone is kept for resolveFinalStatus() but no longer blocks seal.
   */
  teardownComplete?: boolean;
}

/** F-parallel-cancel: observable slot lifecycle state for callers that need to distinguish
 *  "no slot" from "cancelled tombstone". */
export type SlotState = 'active' | 'canceled' | 'absent';

export interface ActiveSlotInfo {
  catId: string;
  startedAt: number;
}

export interface StaleInvocationSlotInfo {
  threadId: string;
  catId: string;
  userId: string;
  executionId?: string;
  startedAt: number;
  ageMs: number;
  state: 'active' | 'canceled';
}

export interface CancelResult {
  cancelled: boolean;
  catIds: string[];
  /** Exact runner(s) aborted by this action; safe witness for holder preservation. */
  executionIds?: string[];
}

export interface CancelAllResult {
  catIds: string[];
  /** Deduplicated InvocationRecord identities aborted by this action. */
  executionIds: string[];
  /** Exact active execution owner for each canceled slot. */
  executionIdByCatId: Readonly<Record<string, string>>;
}

export interface DeleteGuard {
  /** Whether the guard was acquired (no active invocation at acquire time) */
  acquired: boolean;
  /** Release the guard after delete completes (success or failure) */
  release: () => void;
}

/** A short per-slot barrier used while a manual session seal clears its active pointer. */
export interface SessionSealGuard {
  acquired: boolean;
  release: () => void;
}

/** A short per-slot lease that keeps manual seal/delete out until execution ownership is published. */
export interface ExecutionAdmissionGuard {
  release: () => void;
}

/** Result of atomically comparing a terminal execution with the current slot owner. */
export type ExactExecutionOwnerState = 'released' | 'absent' | 'replacement';
/** Non-destructive projection used to fence async terminal side effects. */
export type ExecutionOwnerMatch = 'matching' | 'absent' | 'replacement';

export class InvocationTracker {
  /** Key: `${threadId}:${catId}` (slotKey) */
  private active = new Map<string, ActiveInvocation>();
  private deleting = new Set<string>();
  private sessionSealing = new Set<string>();
  private sessionSealWaiters = new Map<string, Set<() => void>>();
  private executionAdmissions = new Map<string, number>();
  /** F118: max age before a slot becomes a reaper candidate; `0` disables candidacy. */
  private maxSlotTtlMs: number;

  constructor(opts?: { maxSlotTtlMs?: number }) {
    this.maxSlotTtlMs = opts?.maxSlotTtlMs ?? DEFAULT_INVOCATION_SLOT_TTL_MS;
  }

  private slotKey(threadId: string, catId: string): string {
    return `${threadId}:${catId}`;
  }

  private hasExecutionAdmission(threadId: string, catId?: string): boolean {
    if (catId) return (this.executionAdmissions.get(this.slotKey(threadId, catId)) ?? 0) > 0;
    const prefix = `${threadId}:`;
    for (const [key, count] of this.executionAdmissions) {
      if (count > 0 && key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Start a new invocation for a slot (threadId + catId).
   * Only aborts existing invocation for the SAME slot — other cats' slots untouched.
   * If thread is being deleted, returns a pre-aborted controller.
   */
  start(
    threadId: string,
    catId: string,
    userId: string = 'unknown',
    catIds: string[] = [],
    executionId?: string,
  ): AbortController {
    const key = this.slotKey(threadId, catId);
    if (this.deleting.has(threadId) || this.sessionSealing.has(key)) {
      const controller = new AbortController();
      controller.abort();
      return controller;
    }
    // Abort existing invocation for this SAME slot only
    this.active.get(key)?.controller.abort('preempted');
    const controller = new AbortController();
    this.active.set(key, {
      controller,
      threadId,
      userId,
      catId,
      catIds,
      startedAt: Date.now(),
      state: 'active',
      executionId,
    });
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
    executionId?: string,
  ): AbortController | null {
    if (this.deleting.has(threadId) || this.sessionSealing.has(this.slotKey(threadId, catId))) return null;
    if (this.has(threadId)) return null;
    const controller = new AbortController();
    const key = this.slotKey(threadId, catId);
    this.active.set(key, {
      controller,
      threadId,
      userId,
      catId,
      catIds,
      startedAt: Date.now(),
      state: 'active',
      executionId,
    });
    return controller;
  }

  /**
   * Atomically check-and-guard for thread deletion.
   * Synchronous: checks ALL slots + marks deleting in one tick.
   * Unlike guardSessionSeal(), deletion intentionally treats canceled tombstones
   * as idle: deletion is terminal for the whole thread, and the deleting fence
   * prevents new work while teardown finishes.
   * Caller MUST call release() in a finally block after delete completes.
   */
  guardDelete(threadId: string): DeleteGuard {
    if (this.deleting.has(threadId)) {
      return { acquired: false, release: () => {} };
    }
    // Check if ANY slot is active or between durable retirement and tracker publication.
    if (this.has(threadId) || this.hasExecutionAdmission(threadId)) {
      return { acquired: false, release: () => {} };
    }
    this.deleting.add(threadId);
    return {
      acquired: true,
      release: () => this.deleting.delete(threadId),
    };
  }

  /**
   * Atomically check an idle slot and prevent another local invocation from
   * claiming it until the session store has removed the old active pointer.
   *
   * #1313: also blocks while a canceled tombstone's teardown is still in progress —
   * "Stop" + immediate "Seal" must wait until the route layer calls complete().
   */
  guardSessionSeal(threadId: string, catId: string): SessionSealGuard {
    const key = this.slotKey(threadId, catId);
    if (
      this.deleting.has(threadId) ||
      this.sessionSealing.has(key) ||
      this.hasExecutionAdmission(threadId, catId) ||
      this.has(threadId, catId) ||
      this.hasPendingTeardown(threadId, catId)
    ) {
      return { acquired: false, release: () => {} };
    }
    this.sessionSealing.add(key);
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        if (!this.sessionSealing.delete(key)) return;
        const waiters = this.sessionSealWaiters.get(key);
        this.sessionSealWaiters.delete(key);
        for (const resolve of waiters ?? []) resolve();
      },
    };
  }

  /**
   * Park queue admission behind an in-process session-seal CAS without polling.
   * The caller must retry startAll() after this resolves because another seal may
   * have acquired the same slot in the meantime.
   */
  async waitForSessionSealRelease(threadId: string, catIds: readonly string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const catId of new Set(catIds)) {
      const key = this.slotKey(threadId, catId);
      if (!this.sessionSealing.has(key)) continue;
      waits.push(
        new Promise<void>((resolve) => {
          let waiters = this.sessionSealWaiters.get(key);
          if (!waiters) {
            waiters = new Set();
            this.sessionSealWaiters.set(key, waiters);
          }
          waiters.add(resolve);
          if (!this.sessionSealing.has(key) && waiters.delete(resolve)) {
            if (waiters.size === 0) this.sessionSealWaiters.delete(key);
            resolve();
          }
        }),
      );
    }
    await Promise.all(waits);
  }

  /**
   * Wait out any active manual seal, then synchronously reserve every target slot
   * against a new seal/delete. The caller may perform asynchronous durable work
   * under this lease and must publish tracker ownership before releasing it.
   */
  async acquireExecutionAdmission(
    threadId: string,
    catIds: readonly string[],
  ): Promise<ExecutionAdmissionGuard | null> {
    const uniqueCatIds = [...new Set(catIds)];
    const keys = uniqueCatIds.map((catId) => this.slotKey(threadId, catId));
    while (true) {
      if (this.deleting.has(threadId)) return null;
      if (keys.some((key) => this.sessionSealing.has(key))) {
        await this.waitForSessionSealRelease(threadId, uniqueCatIds);
        continue;
      }

      for (const key of keys) {
        this.executionAdmissions.set(key, (this.executionAdmissions.get(key) ?? 0) + 1);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          for (const key of keys) {
            const count = this.executionAdmissions.get(key) ?? 0;
            if (count <= 1) this.executionAdmissions.delete(key);
            else this.executionAdmissions.set(key, count - 1);
          }
        },
      };
    }
  }

  /**
   * #1313: Whether a slot has a canceled tombstone whose provider teardown hasn't
   * completed yet. Teardown is marked done when complete()/completeSlot()/completeAll()
   * is called for the canceled slot. F118 post-close: age alone never clears the
   * pending state on this read path — stuck tombstones surface via listStaleSlots()
   * and the explicit liveness reaper.
   */
  private hasPendingTeardown(threadId: string, catId: string): boolean {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return false;
    if (inv.state !== 'canceled') return false;
    return !inv.teardownComplete;
  }

  /**
   * Retain a canceled slot until the route layer has completed provider teardown.
   * Tombstones are inactive for dispatch (`has() === false`) but remain visible to
   * the manual-seal guard so every cancel path has the same lifecycle fence.
   */
  private tombstoneCanceledInvocation(inv: ActiveInvocation, abortReason?: string): void {
    inv.controller.abort(abortReason);
    inv.state = 'canceled';
    inv.cancelReason = abortReason;
  }

  /**
   * Cancel an active invocation for a specific slot.
   * If requestUserId is provided, only cancels if it matches the invocation owner.
   * Optional abortReason is forwarded to AbortController.abort(reason).
   */
  cancel(threadId: string, catId: string, requestUserId?: string, abortReason?: string): CancelResult {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return { cancelled: false, catIds: [], executionIds: [] };
    if (requestUserId && inv.userId !== requestUserId) {
      return { cancelled: false, catIds: [], executionIds: [] };
    }
    const { catIds } = inv;
    this.tombstoneCanceledInvocation(inv, abortReason);
    // F211-REG6 instrument (observation-only): the cancel funnel is the complete chokepoint for the
    // hardcoded 'user_cancel' reason (SocketManager:211 + queue.ts). Logging abortReason + msSinceStart
    // here (vs only at the WS layer) disambiguates WS-sourced cancels from any non-WS path, and a very
    // short msSinceStart hints at reconnect/teardown churn rather than a deliberate mid-turn Stop.
    log.info(
      {
        event: 'f211_reg6_invocation_abort',
        method: 'cancel',
        threadId,
        catId,
        abortReason: abortReason ?? null,
        msSinceStart: Date.now() - inv.startedAt,
      },
      'F211-REG6: invocation aborted (cancel funnel) — abortReason provenance',
    );
    // F-parallel-cancel: tombstone — do NOT delete the slot. Keep it as a 'canceled' tombstone so
    // getController() still returns the aborted controller for a cat cancelled BEFORE the route
    // layer grabbed its own signal (pre-invoke cancel must not be lost / fall back to the batch
    // gate). Purged at the next start-family or complete-family call for this slot.
    return { cancelled: true, catIds, executionIds: inv.executionId ? [inv.executionId] : [] };
  }

  /**
   * Cancel ALL active slots for a thread.
   * F156: When requestUserId is provided, only cancels invocations owned by that user.
   * Without requestUserId, cancels all (system/admin action, e.g. thread deletion).
   * Returns both the aggregate InvocationRecord identities used by SessionMutex
   * and the exact cat→execution ownership used by slot-scoped terminal effects.
   */
  cancelAll(threadId: string, requestUserId?: string, abortReason?: string): CancelAllResult {
    const prefix = `${threadId}:`;
    const cancelledCatIds: string[] = [];
    const cancelledExecutionIds = new Set<string>();
    const cancelledExecutionIdByCatId = new Map<string, string>();
    // F211-REG6 instrument (observation-only): per-cat age evidence for the all-scope path,
    // mirroring cancel()'s msSinceStart. An all-scope cancel / force-reset must also answer
    // "just started" vs "ran a while" — without this, the cancelAll log can't distinguish them.
    const cancelledSlots: Array<{ catId: string; msSinceStart: number }> = [];
    // F-parallel-cancel: cancelAll is the "stop the whole invocation" path (force-reset /
    // cancel_all button), so it must abort the INDEPENDENT batch gate too — single-cat cancel
    // does NOT (see startAll). Collect + dedup batch controllers of the slots we cancel.
    const batchControllers = new Set<AbortController>();
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix)) {
        if (requestUserId && inv.userId !== requestUserId) continue;
        // Tombstones remain in the map for final-status and seal-fence observation,
        // but they are not newly canceled work. Re-reporting one would rebroadcast
        // stale execution IDs and pause a queued replacement a second time.
        if (inv.state === 'canceled') continue;
        cancelledCatIds.push(inv.catId);
        if (inv.executionId) {
          cancelledExecutionIds.add(inv.executionId);
          cancelledExecutionIdByCatId.set(inv.catId, inv.executionId);
        }
        cancelledSlots.push({ catId: inv.catId, msSinceStart: Date.now() - inv.startedAt });
        this.tombstoneCanceledInvocation(inv, abortReason);
        if (inv.batchController) batchControllers.add(inv.batchController);
        // #1313: tombstone instead of delete — guardSessionSeal() must see pending teardown
        // so "Stop (force-reset) → immediate Seal" blocks until the route completes cleanup.
        // has() stays false for tombstones (queue gates, tryStartThread unaffected).
        // Tombstones purged at next start*/tryStart* re-occupation or by TTL expiry.
      }
    }
    for (const bc of batchControllers) bc.abort(abortReason);
    if (cancelledCatIds.length > 0) {
      // F211-REG6 instrument (observation-only): mirror the cancel() funnel for the cancel_all path.
      log.info(
        {
          event: 'f211_reg6_invocation_abort',
          method: 'cancelAll',
          threadId,
          abortReason: abortReason ?? null,
          cancelledCatIds,
          cancelledSlots,
        },
        'F211-REG6: invocations aborted (cancelAll funnel) — abortReason provenance',
      );
    }
    return {
      catIds: cancelledCatIds,
      executionIds: [...cancelledExecutionIds],
      executionIdByCatId: Object.fromEntries(cancelledExecutionIdByCatId),
    };
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
      this.tombstoneCanceledInvocation(inv, abortReason);
    }
    for (const bc of targetBatches) bc.abort(abortReason);
    return cancelledCatIds;
  }

  /** Get the userId who started the invocation for a specific slot. */
  getUserId(threadId: string, catId: string): string | null {
    const key = this.slotKey(threadId, catId);
    return this.active.get(key)?.userId ?? null;
  }

  /** Exact execution fence for non-interrupting per-target reminder attempts. */
  getExecutionId(threadId: string, catId: string): string | undefined {
    const inv = this.active.get(this.slotKey(threadId, catId));
    if (!inv || inv.state !== 'active') return undefined;
    return inv.executionId;
  }

  /** Get target cat IDs of the active invocation for a specific slot. */
  getCatIds(threadId: string, catId: string): string[] {
    const key = this.slotKey(threadId, catId);
    return this.active.get(key)?.catIds ?? [];
  }

  /**
   * Get the AbortController for a specific slot, so the execution layer can subscribe
   * to a cat's OWN cancel signal (per-cat isolation). Returns undefined if there is no
   * tracked slot.
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
    // #1313: mark teardown as done so guardSessionSeal() unblocks.
    if (inv.state === 'canceled') {
      inv.teardownComplete = true;
      return;
    }
    this.active.delete(key);
  }

  /**
   * Classify whether an execution still matches the current slot without
   * changing ownership. Async terminal paths use this after awaited reads so a
   * replacement cannot inherit an older invocation's slot-keyed side effects.
   */
  classifyExecutionId(threadId: string, catId: string, executionId: string): ExecutionOwnerMatch {
    const inv = this.active.get(this.slotKey(threadId, catId));
    // #1313: a canceled tombstone is terminal — its ownership is over and only
    // the manual-seal guard and resolveFinalStatus() still observe it. Report
    // 'absent' so late terminal cleanup and force replacement neither inherit
    // the dead execution nor delete its pending-teardown fence.
    if (!inv || inv.state === 'canceled') return 'absent';
    return inv.executionId === executionId ? 'matching' : 'replacement';
  }

  /**
   * Retire a terminal slot only when the caller still owns its exact execution.
   *
   * Runtime zombie reconciliation can race with a replacement invocation for the
   * same (thread, cat) slot. Comparing only that pair would delete the replacement;
   * executionId is the ownership fence that makes late terminal cleanup safe.
   */
  completeByExecutionId(threadId: string, catId: string, executionId: string): ExactExecutionOwnerState {
    const key = this.slotKey(threadId, catId);
    const ownerMatch = this.classifyExecutionId(threadId, catId, executionId);
    if (ownerMatch === 'absent') return 'absent';
    if (ownerMatch === 'replacement') return 'replacement';
    this.active.delete(key);
    return 'released';
  }

  /**
   * Release an exact slot after an independent durable/provider probe has
   * already proved the execution terminal. Unlike routine late cleanup, this
   * path may remove a canceled teardown tombstone; executionId still fences a
   * replacement from inheriting that decision.
   */
  releaseTerminalByExecutionId(threadId: string, catId: string, executionId: string): ExactExecutionOwnerState {
    const key = this.slotKey(threadId, catId);
    const inv = this.active.get(key);
    if (!inv) return 'absent';
    if (inv.executionId !== executionId) return 'replacement';
    this.active.delete(key);
    return 'released';
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
    // #1313: do NOT mark teardown done here. A cancellation can surface a per-cat
    // 'error' event while the stream still has trailing events and route-finally
    // persistence pending; only the route's terminal completion (complete() /
    // completeAll() in its finally) proves teardown finished, so the manual-seal
    // fence must hold until then.
    if (inv.state === 'canceled') {
      return;
    }
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
      return true;
    }
    // Thread-level: check if ANY non-canceled slot is active.
    const prefix = `${threadId}:`;
    for (const [key, inv] of this.active) {
      if (key.startsWith(prefix) && inv.state !== 'canceled') return true;
    }
    return false;
  }

  /**
   * Start tracking ALL target cats for a unified multi-cat dispatch.
   * Each cat gets its own independent AbortController (per-cat cancel safe).
   * Returns the primaryCat's (catIds[0]) controller for execution signal.
   * All slots share a `batchController` ref so completeAll can match the batch.
   */
  startAll(
    threadId: string,
    catIds: string[],
    userId: string = 'unknown',
    executionId?: string,
  ): AbortController | null {
    if (catIds.some((catId) => this.sessionSealing.has(this.slotKey(threadId, catId)))) return null;
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
      this.active.set(key, {
        controller,
        threadId,
        userId,
        catId,
        catIds,
        startedAt: now,
        batchController,
        state: 'active',
        executionId,
      });
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
    executionId?: string,
  ): boolean {
    if (this.deleting.has(threadId) || this.sessionSealing.has(this.slotKey(threadId, catId))) return false;
    const key = this.slotKey(threadId, catId);
    const existing = this.active.get(key);
    // A2A re-track must REPLACE a 'canceled' tombstone, not idempotently keep it. getController()
    // intentionally returns a tombstone's aborted controller (pre-invoke cancel semantics); if a
    // freshly-handed-off A2A target still has a prior-turn canceled tombstone, route-serial reads that
    // aborted signal via signalForCat and skips the target at the top of the worklist loop — the cat
    // silently never invokes. Tombstones are purged by start-/complete-family calls; trackExternalSlot
    // is the A2A re-occupation path and must do the same. (bug: 2026-06-11 a2a-handoff-no-spawn.)
    if (existing && existing.state !== 'canceled') {
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
      threadId,
      userId,
      catId,
      catIds,
      startedAt: Date.now(),
      batchController: controller,
      state: 'active',
      executionId,
    });
    return true;
  }

  /**
   * Non-preemptive thread-level start for ALL target cats.
   * Atomically checks if ANY slot is active, then registers all cats with independent controllers.
   */
  tryStartThreadAll(
    threadId: string,
    catIds: string[],
    userId: string = 'unknown',
    executionId?: string,
  ): AbortController | null {
    if (this.deleting.has(threadId) || catIds.some((catId) => this.sessionSealing.has(this.slotKey(threadId, catId)))) {
      return null;
    }
    if (this.has(threadId)) return null;
    const now = Date.now();
    // F-parallel-cancel: independent batch gate (see startAll) — single-cat cancel must not trip
    // the whole-invocation gate; per-cat signals come from getController(threadId, catId).
    const batchController = new AbortController();
    for (const catId of catIds) {
      const key = this.slotKey(threadId, catId);
      const controller = new AbortController();
      this.active.set(key, {
        controller,
        threadId,
        userId,
        catId,
        catIds,
        startedAt: now,
        batchController,
        state: 'active',
        executionId,
      });
    }
    return batchController;
  }

  /**
   * Bind an InvocationRecord created after an atomic tracker reservation.
   * Controller matching prevents a late create from stamping a replacement slot.
   */
  bindExecutionId(threadId: string, catIds: readonly string[], controller: AbortController, executionId: string): void {
    for (const catId of catIds) {
      const inv = this.active.get(this.slotKey(threadId, catId));
      if (!inv) continue;
      if (inv.controller !== controller && inv.batchController !== controller) continue;
      inv.executionId = executionId;
    }
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
      // #1313: mark teardown as done so guardSessionSeal() unblocks.
      if (inv.state === 'canceled') {
        inv.teardownComplete = true;
        continue;
      }
      this.active.delete(key);
    }
  }

  /** Get all active slot info for a thread (catId + startedAt for F5 recovery). */
  getActiveSlots(threadId: string): ActiveSlotInfo[] {
    const prefix = `${threadId}:`;
    const result: ActiveSlotInfo[] = [];
    for (const [key, inv] of this.active) {
      // F-parallel-cancel: a canceled tombstone is not an active slot.
      if (key.startsWith(prefix) && inv.state !== 'canceled') {
        result.push({ catId: inv.catId, startedAt: inv.startedAt });
      }
    }
    return result;
  }

  /**
   * F297 OQ-1: sparse active-candidate index for list-scale presence reads.
   *
   * Sidebar 有 ~1760 行但同时活跃的通常个位数；逐 thread 跑 4-store 对账是 O(T)。
   * 本方法只枚举**进程内已持有 slot** 的 thread，把候选集压到 O(A)。
   *
   * 它是**候选发现**，不是 liveness 判定 —— tracker 按 F194 明确不是 lifecycle 真相源。
   * 候选拿到后仍必须交给 canonical classifier 定性。
   */
  listActiveThreadIds(): string[] {
    const threadIds = new Set<string>();
    for (const inv of this.active.values()) {
      if (inv.state === 'canceled') continue;
      threadIds.add(inv.threadId);
    }
    return [...threadIds];
  }

  /**
   * Enumerate old ownership leases for the explicit liveness reaper. This method
   * is deliberately non-mutating: age alone is never terminal evidence.
   */
  listStaleSlots(now = Date.now()): StaleInvocationSlotInfo[] {
    if (this.maxSlotTtlMs <= 0) return [];
    const result: StaleInvocationSlotInfo[] = [];
    for (const inv of this.active.values()) {
      const ageMs = now - inv.startedAt;
      if (ageMs <= this.maxSlotTtlMs) continue;
      result.push({
        threadId: inv.threadId,
        catId: inv.catId,
        userId: inv.userId,
        ...(inv.executionId ? { executionId: inv.executionId } : {}),
        startedAt: inv.startedAt,
        ageMs,
        state: inv.state,
      });
    }
    return result;
  }

  /** Whether a thread is currently being deleted (delete guard active). */
  isDeleting(threadId: string): boolean {
    return this.deleting.has(threadId);
  }
}
