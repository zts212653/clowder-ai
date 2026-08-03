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
import {
  convergeZombieQueueEntry,
  type QueueConvergedHandler,
  type ZombieQueueConverger,
} from './convergeZombieQueue.js';
import type { ZombieRecord } from './getThreadLiveInvocations.js';
import type { TaskProgressStore } from './TaskProgressStore.js';

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
  /**
   * Exact terminal side effect for the CAS winner. Runtime composition uses this
   * to retire only the matching tracker owner and re-enter normal queue recovery.
   */
  onReconciledZombie?: (event: ReconciledZombieEvent) => void | Promise<void>;
  /**
   * F220 Phase 2a (#972) — optional. When present, a zombie sweep also converges the
   * dead invocation's stale `processing` queue entry, so later user work stops queuing
   * behind a corpse. Absent → record-only cleanup (previous behavior).
   */
  invocationQueue?: ZombieQueueConverger;
  /**
   * F220 Phase 2a (#972) — optional broadcast hook, fired once per thread whose queue
   * actually changed. Kept as a callback so this module stays free of socket coupling;
   * the caller (queue.ts / messages.ts) owns the `queue_updated` emit.
   */
  onQueueConverged?: QueueConvergedHandler;
}

export interface ReconciledZombieEvent {
  invocationId: string;
  threadId: string;
  /** Durable parent scope. catId below is detector provenance only. */
  targetCats: CatId[];
  catId: string | null;
  status: 'failed';
}

export interface ReconcileZombieResult {
  /** Number of zombies successfully marked failed. */
  reconciled: number;
  /** Already-terminal zombies skipped (idempotent no-op). */
  alreadyTerminal: number;
  /** TaskProgress snapshots cleared. */
  taskProgressCleared: number;
  /** F220 Phase 2a (#972): stale `processing` queue entries removed. */
  queueConverged: number;
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
  taskProgressCleared: number;
  queueConverged: number;
  errors: number;
}

async function clearTaskProgress(
  taskProgressStore: TaskProgressStore | undefined,
  threadId: string,
  invocationId: string,
  targetCats: readonly CatId[],
  log: NonNullable<ReconcileZombieDeps['log']>,
): Promise<{ cleared: number; errors: number }> {
  if (!taskProgressStore) return { cleared: 0, errors: 0 };
  let cleared = 0;
  let errors = 0;
  for (const catId of new Set(targetCats)) {
    try {
      const deleted = await taskProgressStore.deleteSnapshotIfOwner(threadId, catId, invocationId);
      if (deleted) cleared += 1;
    } catch (err) {
      errors += 1;
      log.warn(
        {
          invocationId,
          catId,
          err: err instanceof Error ? err.message : String(err),
        },
        '[reconcile-zombies] failed to clear TaskProgress',
      );
    }
  }
  return { cleared, errors };
}

function taskProgressTargets(targetCats: readonly CatId[], detectorCatId: string | null): CatId[] {
  const durableTargets = [...new Set(targetCats)];
  if (durableTargets.length > 0) return durableTargets;
  return detectorCatId ? [detectorCatId as CatId] : [];
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
      // Owner-bound snapshot deletion might have failed transiently. Future zombie sweeps won't
      // re-surface it (only running records are zombies), so phantom progress
      // would persist indefinitely. Defensively re-attempt the owner-bound delete for
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
        return {
          reconciled: false,
          alreadyTerminal: true,
          taskProgressCleared: 0,
          queueConverged: 0,
          errors: 0,
        };
      }
      const isTerminal = current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled';
      if (isTerminal) {
        const tp = await clearTaskProgress(
          deps.taskProgressStore,
          current.threadId,
          zombie.invocationId,
          taskProgressTargets(current.targetCats, zombie.catId),
          log,
        );
        // #972: same redundancy rationale as the R15 P1 TaskProgress retry — a concurrent
        // reconcile may have flipped the record terminal but died before converging the
        // queue, and future sweeps only enumerate *running* records, so this entry would
        // pin the head forever. removeProcessed is idempotent, so retrying is safe.
        const qc = convergeZombieQueueEntry(deps.invocationQueue, current, zombie, log, deps.onQueueConverged);
        log.info(
          { invocationId: zombie.invocationId, currentStatus: current.status, reason: zombie.reason },
          '[reconcile-zombies] skipped (already terminal); re-attempted TaskProgress cleanup',
        );
        return {
          reconciled: false,
          alreadyTerminal: true,
          taskProgressCleared: tp.cleared,
          queueConverged: qc.converged,
          errors: tp.errors + qc.errors,
        };
      }
      // Record still alive (queued/running) but CAS update returned null — could be
      // CAS-drift retry exhaustion or any transient store failure. Classify as error
      // so the metric reflects "real zombie not converged". Next sweep re-tries.
      log.warn(
        { invocationId: zombie.invocationId, currentStatus: current.status, reason: zombie.reason },
        '[reconcile-zombies] update returned null but record still alive — transient failure',
      );
      return {
        reconciled: false,
        alreadyTerminal: false,
        taskProgressCleared: 0,
        queueConverged: 0,
        errors: 1,
      };
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
    const targetCats = [...new Set(updated.targetCats)];
    const tp = await clearTaskProgress(
      deps.taskProgressStore,
      updated.threadId,
      zombie.invocationId,
      taskProgressTargets(targetCats, zombie.catId),
      log,
    );
    // #972: the record is now terminal, so its `processing` queue entry is a corpse
    // pinning the queue head. Converge it or later user work never runs.
    const qc = convergeZombieQueueEntry(deps.invocationQueue, updated, zombie, log, deps.onQueueConverged);
    let terminalRecoveryErrors = 0;
    if (deps.onReconciledZombie) {
      try {
        await deps.onReconciledZombie({
          invocationId: zombie.invocationId,
          threadId: updated.threadId,
          targetCats,
          catId: zombie.catId,
          status: 'failed',
        });
      } catch (err) {
        terminalRecoveryErrors = 1;
        log.warn({ invocationId: zombie.invocationId, err }, '[reconcile-zombies] terminal recovery callback failed');
      }
    }
    return {
      reconciled: true,
      alreadyTerminal: false,
      taskProgressCleared: tp.cleared,
      queueConverged: qc.converged,
      errors: tp.errors + qc.errors + terminalRecoveryErrors,
    };
  } catch (err) {
    log.warn(
      {
        invocationId: zombie.invocationId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[reconcile-zombies] update failed',
    );
    return {
      reconciled: false,
      alreadyTerminal: false,
      taskProgressCleared: 0,
      queueConverged: 0,
      errors: 1,
    };
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
  let queueConverged = 0;
  let errors = 0;

  for (const zombie of zombies) {
    const outcome = await processZombie(zombie, deps, log);
    if (outcome.reconciled) reconciled += 1;
    if (outcome.alreadyTerminal) alreadyTerminal += 1;
    taskProgressCleared += outcome.taskProgressCleared;
    queueConverged += outcome.queueConverged;
    errors += outcome.errors;
  }

  const result: ReconcileZombieResult = {
    reconciled,
    alreadyTerminal,
    taskProgressCleared,
    queueConverged,
    errors,
    durationMs: Date.now() - start,
  };

  if (zombies.length > 0) {
    log.info(result, '[reconcile-zombies] sweep complete');
  }

  return result;
}
