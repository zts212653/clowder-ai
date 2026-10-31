import { getContinuityLease, leasePendingContinuity } from './continuity-operations.js';
import { expireAwakenedRuns } from './lease-operations.js';
import { requireRun } from './run-lifecycle-operations.js';
import type { AutoDreamStoreContext } from './store-context.js';
import { insertAutoDreamEvent } from './store-context.js';
import { requireNonEmpty } from './store-rows.js';
import type { BeginPresentLoopRunInput, BeginPresentLoopRunResult } from './store-types.js';

export function beginRun(context: AutoDreamStoreContext, input: BeginPresentLoopRunInput): BeginPresentLoopRunResult {
  requireNonEmpty(input.ownerUserId, 'ownerUserId');
  requireNonEmpty(input.catId, 'catId');
  requireNonEmpty(input.threadId, 'threadId');
  requireNonEmpty(input.taskId, 'taskId');
  expireAwakenedRuns(context, { ownerUserId: input.ownerUserId, catId: input.catId });

  const result = context.db.transaction(() => {
    const existing = findExistingSlot(context, input) ?? findActiveRun(context, input.ownerUserId, input.catId);
    if (existing) return { runId: existing, created: false };

    const now = context.now();
    const runId = context.idFactory('dreamrun_');
    context.db
      .prepare(
        `INSERT INTO present_loop_runs (
           run_id, owner_user_id, cat_id, thread_id, task_id, state,
           scheduled_at, fired_at, lateness_ms, missed_slots,
           awakened_at, lease_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'awakened', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        input.ownerUserId,
        input.catId,
        input.threadId,
        input.taskId,
        input.scheduledAt ?? null,
        input.firedAt,
        input.latenessMs ?? 0,
        input.missedSlots ?? 0,
        now,
        now + context.awakenedLeaseMs,
        now,
        now,
      );
    const continuity = leasePendingContinuity(context, input.ownerUserId, input.catId, runId, now);
    insertAutoDreamEvent(context, input.ownerUserId, input.catId, runId, 'wake_started', {
      postureId: continuity?.postureId,
      scheduledAt: input.scheduledAt,
      firedAt: input.firedAt,
      latenessMs: input.latenessMs ?? 0,
      missedSlots: input.missedSlots ?? 0,
    });
    return { runId, created: true };
  })();

  return {
    run: requireRun(context, input.ownerUserId, result.runId),
    continuity: getContinuityLease(context, input.ownerUserId, result.runId),
    created: result.created,
  };
}

function findExistingSlot(context: AutoDreamStoreContext, input: BeginPresentLoopRunInput): string | null {
  if (input.scheduledAt === undefined) return null;
  const row = context.db
    .prepare(
      `SELECT run_id FROM present_loop_runs
       WHERE owner_user_id = ? AND task_id = ? AND scheduled_at = ?`,
    )
    .get(input.ownerUserId, input.taskId, input.scheduledAt) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

function findActiveRun(context: AutoDreamStoreContext, ownerUserId: string, catId: string): string | null {
  const row = context.db
    .prepare(
      `SELECT run_id FROM present_loop_runs
       WHERE owner_user_id = ? AND cat_id = ? AND state = 'awakened' LIMIT 1`,
    )
    .get(ownerUserId, catId) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}
