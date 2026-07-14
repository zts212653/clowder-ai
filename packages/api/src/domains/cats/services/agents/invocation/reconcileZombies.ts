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
 * - removeStaleProcessing accepts userId to scope the queue lookup to the
 *   zombie owner's entries, preventing cross-user entry deletion in shared threads.
 * - zombieCreatedAt provides a generation identity guard (Sol review P1-1):
 *   only entries created at or before the zombie's invocation creation time
 *   are eligible for removal. This prevents deleting a NEW live processing
 *   entry when old and new same-cat generations coexist (F194 Phase Z).
 * - No bulk emitQueueUpdated broadcast: that would wipe other users' queue state
 *   (frontend blindly replaces). The adapter emits per-user queue_updated after
 *   removal; dispatch emits its own events via the normal execution path.
 * - tryDispatchNext mirrors the normal completion path: cross-user fair drain
 *   (tryExecuteNextAcrossUsers) + auto-execute scan, so both user/connector
 *   entries and agent entries get dispatched (Sol review P1-2).
 */
export interface QueueConvergence {
  /** Find and remove stale processing entry for this thread+cat, scoped to userId.
   *  @param zombieCreatedAt — the zombie invocation's createdAt timestamp.
   *    Only entries with createdAt <= this value are eligible for removal,
   *    preventing deletion of newer live entries for the same cat.
   *  Returns primaryCatId (targetCats[0]) so the caller can release the correct slot —
   *  processingSlots are keyed by primary target, not necessarily the zombie catId. */
  removeStaleProcessing(
    threadId: string,
    catId: string,
    userId: string,
    zombieCreatedAt: number,
  ): { removed: boolean; entryId?: string; primaryCatId?: string };
  /** Release the in-memory processing slot for this thread+cat. */
  releaseSlot(threadId: string, catId: string): void;
  /** Kick the queue: dispatch waiting entries now that the slot is free.
   *  Uses the normal completion path (cross-user fair drain + auto-execute scan)
   *  so both user/connector and agent entries get dispatched. */
  tryDispatchNext(threadId: string, catId: string): void;
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
}

async function clearTaskProgress(
  taskProgressStore: TaskProgressStore | undefined,
  threadId: string,
  zombie: ZombieRecord,
  log: NonNullable<ReconcileZombieDeps['log']>,
): Promise<{ cleared: boolean; errors: number }> {
  if (!taskProgressStore || !zombie.catId) return { cleared: false, errors: 0 };
  try {
    await taskProgressStore.deleteSnapshot(threadId, zombie.catId as CatId);
    return { cleared: true, errors: 0 };
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
        const tp = await clearTaskProgress(deps.taskProgressStore, current.threadId, zombie, log);
        // P2-1 (Sol review): retry queue convergence in the terminal path.
        // Previously blocked (codex R6 P1) because cat-only matching could delete
        // a NEW live entry. Now safe: P1-1's zombieCreatedAt age guard ensures
        // only entries from the zombie's own generation match. If the CAS winner
        // already cleaned the stale entry, removeStaleProcessing returns
        // {removed: false} (idempotent).
        let convergenceErrors = 0;
        if (deps.queueConvergence && zombie.catId) {
          try {
            const qr = deps.queueConvergence.removeStaleProcessing(
              current.threadId,
              zombie.catId,
              current.userId,
              current.createdAt,
            );
            if (qr.removed) {
              const slotCat = qr.primaryCatId ?? zombie.catId;
              deps.queueConvergence.releaseSlot(current.threadId, slotCat);
              deps.queueConvergence.tryDispatchNext(current.threadId, slotCat);
              log.info(
                { threadId: current.threadId, catId: zombie.catId, slotCat, entryId: qr.entryId },
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
          }
        }
        log.info(
          { invocationId: zombie.invocationId, currentStatus: current.status, reason: zombie.reason },
          '[reconcile-zombies] skipped (already terminal); re-attempted cleanup',
        );
        return {
          reconciled: false,
          alreadyTerminal: true,
          taskProgressCleared: tp.cleared,
          errors: tp.errors + convergenceErrors,
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
    const tp = await clearTaskProgress(deps.taskProgressStore, updated.threadId, zombie, log);
    // F220 Phase 2a (#972): converge queue state — remove stale processing entry + slot.
    // - userId-scoped to prevent cross-user entry deletion (codex review R1 P2).
    // - zombieCreatedAt age guard ensures only the zombie's own generation entry is
    //   removed, not a newer live entry for the same cat (Sol review P1-1).
    // - tryDispatchNext uses cross-user fair drain so user/connector entries (like
    //   the original #972 @codex message) also get dispatched (Sol review P1-2).
    let convergenceErrors = 0;
    if (deps.queueConvergence && zombie.catId) {
      try {
        const qr = deps.queueConvergence.removeStaleProcessing(
          updated.threadId,
          zombie.catId,
          updated.userId,
          updated.createdAt,
        );
        if (qr.removed) {
          // Release by primaryCatId — processingSlots are keyed by targetCats[0],
          // which may differ from zombie.catId for multi-cat entries (codex R4 P2).
          const slotCat = qr.primaryCatId ?? zombie.catId;
          deps.queueConvergence.releaseSlot(updated.threadId, slotCat);
          // Kick the queue: mirrors normal onInvocationComplete path (cross-user
          // fair drain + auto-execute scan). Fire-and-forget.
          deps.queueConvergence.tryDispatchNext(updated.threadId, slotCat);
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
      }
    }
    return {
      reconciled: true,
      alreadyTerminal: false,
      taskProgressCleared: tp.cleared,
      errors: tp.errors + convergenceErrors,
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

  for (const zombie of zombies) {
    const outcome = await processZombie(zombie, deps, log);
    if (outcome.reconciled) reconciled += 1;
    if (outcome.alreadyTerminal) alreadyTerminal += 1;
    if (outcome.taskProgressCleared) taskProgressCleared += 1;
    errors += outcome.errors;
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
