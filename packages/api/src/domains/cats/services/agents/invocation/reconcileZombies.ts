/**
 * F194 Phase B (Bundle) — runtime zombie cleanup pathway.
 *
 * Consumes `zombies[]` from getThreadLiveInvocations and converges them to a stable
 * lifecycle status, mirroring F048 StartupReconciler's sweep semantics:
 *   - mark `running` → `failed(error='zombie_record_detected')`
 *   - clear TaskProgress snapshot (per-cat) so the frontend doesn't hold a phantom progress bar
 *   - audit log per-zombie + summary
 *
 * Idempotency: the underlying InvocationRecordStore.update() rejects illegal transitions
 * (succeeded/canceled have empty allow-sets); so calling reconcileZombies twice on the same
 * id is safe — the second call sees `failed` and the state machine guard makes it a no-op.
 *
 * Read-path safety: this is invoked AFTER the read endpoint has already returned its
 * response. The read endpoint (messages.ts / queue.ts) calls helper, gets {active, zombies},
 * surfaces `active` to the user, and fires reconcileZombies(zombies, deps) without awaiting.
 * The helper is read-only; cleanup runs in the background.
 */

import type { CatId } from '@cat-cafe/shared';
import type { IBallCustodyIngest } from '../../../../ball-custody/BallCustodyIngest.js';
import { buildInvocationDiedEvent } from '../../../../ball-custody/ball-custody-events.js';
import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import type { ZombieRecord } from './getThreadLiveInvocations.js';
import type { TaskProgressStore } from './TaskProgressStore.js';

/**
 * F220 Phase 2a (#972): Queue convergence interface.
 * When reconcileZombies marks a zombie failed, it calls this to clean up
 * matching stale `processing` queue entries and slots that would otherwise
 * block subsequent dispatches.
 *
 * Design notes:
 * - removeStaleProcessing accepts the zombie invocation's raw idempotencyKey
 *   (Sol R2 P1-1 + R3 P2 connector). The adapter parses two formats:
 *     "queue-${entry.id}"       → match by entry.id (user/agent entries)
 *     "connector-${messageId}"  → match by entry.messageId (connector entries)
 *   Both provide precise entry identity — no time-based approximation.
 * - userId scopes the queue lookup to prevent cross-user entry deletion.
 * - No bulk emitQueueUpdated broadcast: that would wipe other users' queue state
 *   (frontend blindly replaces). The adapter emits per-user queue_updated after
 *   removal; dispatch emits its own events via the normal execution path.
 * - tryDispatchNext mirrors the normal completion path: cross-user fair drain
 *   (tryExecuteNextAcrossUsers) + auto-execute scan, so both user/connector
 *   entries and agent entries get dispatched (Sol review P1-2).
 * - scheduleRetry provides durable recovery with exponential backoff (Sol R4 P2):
 *   when convergence fails transiently, retries are scheduled with backoff
 *   (30s → 60s → 120s cap), deduped by (threadId, userId, idempotencyKey).
 *   Retries continue until entry removed or process restart. Timers use unref().
 */
export interface QueueConvergence {
  /** Find and remove the exact stale processing entry that produced this zombie.
   *  @param idempotencyKey — the zombie invocation's raw idempotencyKey. Adapter parses:
   *    "queue-${entry.id}" → match by entry.id; "connector-${messageId}" → match by
   *    entry.messageId; undefined/unknown → {removed: false}.
   *  Returns primaryCatId (targetCats[0]) so the caller can release the correct slot —
   *  processingSlots are keyed by primary target, not necessarily the zombie catId. */
  removeStaleProcessing(
    threadId: string,
    catId: string,
    userId: string,
    idempotencyKey?: string,
  ):
    | {
        removed: true;
        entryId: string;
        primaryCatId?: string;
        rolledBackSiblings?: string[];
        /** Resolves after the removal snapshot is published. Redispatch must be
         *  chained behind this promise so an older full snapshot cannot arrive last. */
        queueUpdate: Promise<void>;
      }
    | {
        removed: false;
        entryId?: undefined;
        primaryCatId?: undefined;
        rolledBackSiblings?: undefined;
        queueUpdate?: undefined;
      };
  /** Release the in-memory processing slot for this thread+cat, ONLY if it is
   *  still owned by ownerEntryId (Sol maintainer R17 P1: owner-bound reservation).
   *  The adapter binds each slot reservation to its owning queue entry at
   *  claim-time; a slot reclaimed by a replacement entry has a different owner
   *  and MUST be preserved — an unconditional delete would let another dispatch
   *  start beside the replacement. */
  releaseSlot(threadId: string, catId: string, ownerEntryId: string): void;
  /** Kick the queue: dispatch waiting entries now that the slot is free.
   *  Uses the normal completion path (cross-user fair drain + auto-execute scan)
   *  so both user/connector and agent entries get dispatched. */
  tryDispatchNext(threadId: string, catId: string, waitForQueueUpdate?: Promise<void>): void;
  /** Schedule durable retry of queue convergence with exponential backoff (Sol R4 P2).
   *  Called when removeStaleProcessing fails transiently. The adapter implements:
   *  - Dedup registry keyed by (threadId, userId, idempotencyKey) — no double-scheduling
   *  - Exponential backoff: 30s → 60s → 120s (cap) — retries continue until the stale
   *    entry is removed or the process restarts (StartupReconciler covers that case)
   *  - Timer unref() — won't prevent Node.js process exit
   *  Optional — callers degrade gracefully if absent. */
  scheduleRetry?(threadId: string, catId: string, userId: string, idempotencyKey: string): void;
}

export interface ReconcileZombieDeps {
  invocationRecordStore: IInvocationRecordStore;
  /** Optional — if absent, TaskProgress is not cleared (test or embedded mode). */
  taskProgressStore?: TaskProgressStore;
  /** Optional structured logger; defaults to console.warn. Signature matches Fastify
   *  request.log style: `(obj, msg?)` so the route handler can pass `request.log` directly. */
  log?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
  ballCustody?: IBallCustodyIngest;
  /** F220 Phase 2a (#972): optional queue convergence — clean up stale processing
   *  entries after zombie reconciliation. If absent, queue entries are not touched
   *  (backward-compatible with existing callers). */
  queueConvergence?: QueueConvergence;
}

export interface ReconcileZombieResult {
  /** Number of zombies successfully marked failed. */
  reconciled: number;
  /** Already-terminal zombies skipped (idempotent no-op). */
  alreadyTerminal: number;
  /** TaskProgress snapshots cleared. */
  taskProgressCleared: number;
  /** Errors during cleanup (non-fatal). */
  errors: number;
  durationMs: number;
}

/**
 * Cleanup a list of zombie records produced by getThreadLiveInvocations.
 *
 * Idempotent: safe to call multiple times for the same zombie. State machine guards
 * in InvocationRecordStore.update() prevent double-write of `failed` status.
 */
interface PerZombieOutcome {
  reconciled: boolean;
  alreadyTerminal: boolean;
  taskProgressCleared: boolean;
  errors: number;
  /** Sol maintainer review P2: deferred TaskProgress cleanup. Convergence runs
   *  synchronously per-zombie; cleanup awaited in parallel AFTER all zombies converge
   *  so one pending Redis delete cannot block later zombies from reaching convergence. */
  deferredCleanup?: Promise<{ cleared: boolean; errors: number }>;
}

async function clearTaskProgress(
  taskProgressStore: TaskProgressStore | undefined,
  threadId: string,
  zombie: ZombieRecord,
  log: NonNullable<ReconcileZombieDeps['log']>,
): Promise<{ cleared: boolean; errors: number }> {
  if (!taskProgressStore || !zombie.catId) return { cleared: false, errors: 0 };
  try {
    const cleared = await taskProgressStore.deleteSnapshotIfOwner(threadId, zombie.catId as CatId, zombie.invocationId);
    return { cleared, errors: 0 };
  } catch (err) {
    log.warn(
      {
        invocationId: zombie.invocationId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[reconcile-zombies] failed to clear TaskProgress',
    );
    return { cleared: false, errors: 1 };
  }
}

async function processZombie(
  zombie: ZombieRecord,
  deps: ReconcileZombieDeps,
  log: NonNullable<ReconcileZombieDeps['log']>,
): Promise<PerZombieOutcome> {
  try {
    const updated = await deps.invocationRecordStore.update(zombie.invocationId, {
      status: 'failed',
      error: 'zombie_record_detected',
      expectedStatus: 'running',
    });
    if (!updated) {
      // Cloud R15 P1: CAS returned null — record is missing OR already non-running.
      // If a concurrent reconcile already flipped it to terminal, that path's
      // deleteSnapshot might have failed transiently. Future zombie sweeps won't
      // re-surface it (only running records are zombies), so phantom progress
      // would persist indefinitely. Defensively re-attempt deleteSnapshot for
      // terminal records — cleanup is idempotent so redundancy is safe.
      //
      // Cloud R17 P2: distinguish three sub-cases. The Redis store's update() can
      // also return null after exhausting CAS-drift retries (concurrent reassignment
      // race) where the record is STILL running. Mis-classifying that as
      // alreadyTerminal silently drops a real zombie; the next sweep will re-surface
      // it but we should at least count it as transient error so monitors can flag.
      const current = await deps.invocationRecordStore.get(zombie.invocationId);
      if (current === null || current === undefined) {
        log.info(
          { invocationId: zombie.invocationId, reason: zombie.reason },
          '[reconcile-zombies] skipped (record missing)',
        );
        return { reconciled: false, alreadyTerminal: true, taskProgressCleared: false, errors: 0 };
      }
      const isTerminal = current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled';
      if (isTerminal) {
        // P2-1 (Sol review): retry queue convergence in the terminal path.
        // Run convergence BEFORE TaskProgress cleanup (codex R12 P2): convergence
        // is critical (unblocks dispatch), TaskProgress is cosmetic.
        // GUARD (codex R6 P2): only converge records terminalized by zombie
        // reconciliation (error='zombie_record_detected'). If the record was
        // terminalized by normal completion (succeeded/canceled/failed-with-agent-error),
        // the normal executeEntry .then() cleanup path handles slot release and
        // dispatch. Running convergence alongside it risks double-releasing the
        // processingSlot mutex — the .then() microtask fires after our synchronous
        // convergence, deleting a slot that was re-claimed by the newly dispatched entry.
        let convergenceErrors = 0;
        if (deps.queueConvergence && zombie.catId && current.error === 'zombie_record_detected') {
          try {
            const qr = deps.queueConvergence.removeStaleProcessing(
              current.threadId,
              zombie.catId,
              current.userId,
              current.idempotencyKey,
            );
            if (qr.removed) {
              const slotCat = qr.primaryCatId ?? zombie.catId;
              deps.queueConvergence.releaseSlot(current.threadId, slotCat, qr.entryId);
              deps.queueConvergence.tryDispatchNext(current.threadId, slotCat, qr.queueUpdate);
              log.info(
                {
                  threadId: current.threadId,
                  catId: zombie.catId,
                  slotCat,
                  entryId: qr.entryId,
                  rolledBackSiblings: qr.rolledBackSiblings?.length ?? 0,
                },
                '[reconcile-zombies] terminal-path queue convergence: removed stale entry + released slot + kicked queue',
              );
            }
          } catch (qErr) {
            convergenceErrors = 1;
            log.warn(
              {
                threadId: current.threadId,
                catId: zombie.catId,
                err: qErr instanceof Error ? qErr.message : String(qErr),
              },
              '[reconcile-zombies] terminal-path queue convergence failed',
            );
            if (current.idempotencyKey) {
              deps.queueConvergence.scheduleRetry?.(
                current.threadId,
                zombie.catId,
                current.userId,
                current.idempotencyKey,
              );
            }
          }
        }
        // Sol maintainer review P2: defer TaskProgress cleanup so it doesn't serially
        // block later zombies from reaching convergence. Caller awaits all deferred
        // cleanups in parallel after all zombies have converged.
        log.info(
          { invocationId: zombie.invocationId, currentStatus: current.status, reason: zombie.reason },
          '[reconcile-zombies] skipped (already terminal); re-attempted cleanup',
        );
        return {
          reconciled: false,
          alreadyTerminal: true,
          taskProgressCleared: false,
          errors: convergenceErrors,
          deferredCleanup: clearTaskProgress(deps.taskProgressStore, current.threadId, zombie, log),
        };
      }
      // Record still alive (queued/running) but CAS update returned null — could be
      // CAS-drift retry exhaustion or any transient store failure. Classify as error
      // so the metric reflects "real zombie not converged". Next sweep re-tries.
      log.warn(
        { invocationId: zombie.invocationId, currentStatus: current.status, reason: zombie.reason },
        '[reconcile-zombies] update returned null but record still alive — transient failure',
      );
      return { reconciled: false, alreadyTerminal: false, taskProgressCleared: false, errors: 1 };
    }
    log.info(
      {
        invocationId: zombie.invocationId,
        catId: zombie.catId,
        recordUpdatedAt: zombie.recordUpdatedAt,
        reason: zombie.reason,
      },
      '[reconcile-zombies] marked failed',
    );
    deps.ballCustody
      ?.record(
        buildInvocationDiedEvent({
          invocationId: zombie.invocationId,
          threadId: updated.threadId,
          catId: zombie.catId ?? undefined,
          reason: zombie.reason,
          lastScanAt: zombie.recordUpdatedAt,
          at: Date.now(),
        }),
      )
      .catch((err) =>
        log.warn({ invocationId: zombie.invocationId, err }, '[reconcile-zombies] failed to record invocation.died'),
      );
    // F220 Phase 2a (#972): converge queue state BEFORE TaskProgress cleanup (codex R12 P2).
    // Queue convergence is the critical path (unblocks dispatch); TaskProgress cleanup
    // is cosmetic (clears phantom progress bar). If deleteSnapshot() hangs on an
    // unavailable Redis connection, convergence must still run — the record is already
    // 'failed' so future zombie sweeps won't rediscover it.
    // - Raw idempotencyKey passed to adapter for precise identity (Sol R2 P1-1 + R3 P2):
    //   "queue-${entry.id}" → match by entry.id; "connector-${messageId}" → match by
    //   entry.messageId. No time-based approximation.
    // - userId-scoped to prevent cross-user entry deletion (codex review R1 P2).
    // - tryDispatchNext uses cross-user fair drain so user/connector entries (like
    //   the original #972 @codex message) also get dispatched (Sol review P1-2).
    // - On failure, scheduleRetry provides durable recovery (Sol R3 P2 durable retry).
    let convergenceErrors = 0;
    if (deps.queueConvergence && zombie.catId) {
      try {
        const qr = deps.queueConvergence.removeStaleProcessing(
          updated.threadId,
          zombie.catId,
          updated.userId,
          updated.idempotencyKey,
        );
        if (qr.removed) {
          // Release by primaryCatId — processingSlots are keyed by targetCats[0],
          // which may differ from zombie.catId for multi-cat entries (codex R4 P2).
          // Owner-guarded (Sol maintainer R17 P1): releases ONLY if the slot still
          // belongs to the exact entry just removed — a replacement that reclaimed
          // the slot after a TTL sweep is preserved.
          const slotCat = qr.primaryCatId ?? zombie.catId;
          deps.queueConvergence.releaseSlot(updated.threadId, slotCat, qr.entryId);
          // Kick the queue: mirrors normal onInvocationComplete path (cross-user
          // fair drain + auto-execute scan). Fire-and-forget.
          deps.queueConvergence.tryDispatchNext(updated.threadId, slotCat, qr.queueUpdate);
          log.info(
            { threadId: updated.threadId, catId: zombie.catId, slotCat, userId: updated.userId, entryId: qr.entryId },
            '[reconcile-zombies] #972 queue convergence: removed stale entry + released slot + kicked queue',
          );
        }
      } catch (qErr) {
        // P2-1: count convergence failure so telemetry/monitors surface it.
        convergenceErrors = 1;
        log.warn(
          { threadId: updated.threadId, catId: zombie.catId, err: qErr instanceof Error ? qErr.message : String(qErr) },
          '[reconcile-zombies] #972 queue convergence failed',
        );
        // Sol R3 P2 durable retry: schedule one-shot retry so recovery doesn't
        // depend on a concurrent loser (record is now terminal → no future zombie sweep).
        if (updated.idempotencyKey) {
          deps.queueConvergence.scheduleRetry?.(updated.threadId, zombie.catId, updated.userId, updated.idempotencyKey);
        }
      }
    }
    // Sol maintainer review P2: defer TaskProgress cleanup so it doesn't serially
    // block later zombies from reaching convergence. Caller awaits all deferred
    // cleanups in parallel after all zombies have converged.
    return {
      reconciled: true,
      alreadyTerminal: false,
      taskProgressCleared: false,
      errors: convergenceErrors,
      deferredCleanup: clearTaskProgress(deps.taskProgressStore, updated.threadId, zombie, log),
    };
  } catch (err) {
    log.warn(
      {
        invocationId: zombie.invocationId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[reconcile-zombies] update failed',
    );
    return { reconciled: false, alreadyTerminal: false, taskProgressCleared: false, errors: 1 };
  }
}

export async function reconcileZombies(
  zombies: ZombieRecord[],
  deps: ReconcileZombieDeps,
): Promise<ReconcileZombieResult> {
  const start = Date.now();
  const log = deps.log ?? {
    info: () => {},
    warn: (obj: unknown, msg?: string) => console.warn(msg ?? '', obj),
  };

  let reconciled = 0;
  let alreadyTerminal = 0;
  let taskProgressCleared = 0;
  let errors = 0;

  // Sol maintainer review P2: two-pass approach.
  // Pass 1: converge all zombies (record update + queue cleanup). Each zombie's
  // convergence is awaited serially (safe, single-threaded), but TaskProgress
  // cleanup is deferred so one pending Redis delete cannot block later zombies.
  const deferredCleanups: Array<Promise<{ cleared: boolean; errors: number }>> = [];
  for (const zombie of zombies) {
    const outcome = await processZombie(zombie, deps, log);
    if (outcome.reconciled) reconciled += 1;
    if (outcome.alreadyTerminal) alreadyTerminal += 1;
    errors += outcome.errors;
    if (outcome.deferredCleanup) deferredCleanups.push(outcome.deferredCleanup);
  }

  // Pass 2: await all deferred TaskProgress cleanups in parallel.
  // All zombie convergence is complete — dispatch is unblocked for all threads.
  // Now safely await cosmetic cleanup without blocking critical paths.
  const cleanupResults = await Promise.allSettled(deferredCleanups);
  for (const result of cleanupResults) {
    if (result.status === 'fulfilled') {
      if (result.value.cleared) taskProgressCleared += 1;
      errors += result.value.errors;
    } else {
      errors += 1;
    }
  }

  const result: ReconcileZombieResult = {
    reconciled,
    alreadyTerminal,
    taskProgressCleared,
    errors,
    durationMs: Date.now() - start,
  };

  if (zombies.length > 0) {
    log.info(result, '[reconcile-zombies] sweep complete');
  }

  return result;
}
