import { expireAwakenedRuns } from './lease-operations.js';
import { type AutoDreamStoreContext, insertAutoDreamEvent } from './store-context.js';
import { type DbRow, requireNonEmpty, rowToRun, runNotFound } from './store-rows.js';
import { AutoDreamStoreError, type PresentLoopRunRecord } from './store-types.js';

export function failRun(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  runId: string,
  reason: string,
): PresentLoopRunRecord {
  requireNonEmpty(reason, 'reason');
  expireAwakenedRuns(context, { ownerUserId, runId });
  context.db.transaction(() => {
    const run = requireRun(context, ownerUserId, runId);
    if (run.state === 'wake_failed') return;
    if (run.state !== 'awakened') {
      throw new AutoDreamStoreError('RUN_NOT_SETTLEABLE', 'present loop run cannot become wake_failed', 409);
    }
    const now = context.now();
    context.db
      .prepare(
        `UPDATE present_loop_runs
         SET state = 'wake_failed', failure_reason = ?, failed_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND run_id = ? AND state = 'awakened'`,
      )
      .run(reason, now, now, ownerUserId, runId);
    insertAutoDreamEvent(context, run.ownerUserId, run.catId, run.runId, 'wake_failed', { reason });
  })();
  return requireRun(context, ownerUserId, runId);
}

export function getRun(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  runId: string,
): PresentLoopRunRecord | null {
  expireAwakenedRuns(context, { ownerUserId, runId });
  return readRun(context, ownerUserId, runId);
}

export function getLatestRun(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
): PresentLoopRunRecord | null {
  expireAwakenedRuns(context, { ownerUserId, catId });
  const row = context.db
    .prepare(
      `SELECT * FROM present_loop_runs
       WHERE owner_user_id = ? AND cat_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ownerUserId, catId) as DbRow | undefined;
  return row ? rowToRun(row) : null;
}

export function requireRun(context: AutoDreamStoreContext, ownerUserId: string, runId: string): PresentLoopRunRecord {
  const run = readRun(context, ownerUserId, runId);
  if (!run) throw runNotFound();
  return run;
}

export function isOffDuty(context: AutoDreamStoreContext, ownerUserId: string, catId: string): boolean {
  expireAwakenedRuns(context, { ownerUserId, catId });
  return Boolean(
    context.db
      .prepare(
        `SELECT 1 FROM present_loop_runs
         WHERE owner_user_id = ? AND cat_id = ? AND state = 'awakened' LIMIT 1`,
      )
      .get(ownerUserId, catId),
  );
}

function readRun(context: AutoDreamStoreContext, ownerUserId: string, runId: string): PresentLoopRunRecord | null {
  const row = context.db
    .prepare('SELECT * FROM present_loop_runs WHERE owner_user_id = ? AND run_id = ?')
    .get(ownerUserId, runId) as DbRow | undefined;
  return row ? rowToRun(row) : null;
}
