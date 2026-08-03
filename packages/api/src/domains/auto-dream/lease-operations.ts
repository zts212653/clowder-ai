import { type AutoDreamStoreContext, insertAutoDreamEvent } from './store-context.js';
import { type DbRow, rowToRun } from './store-rows.js';
import type { PresentLoopRunRecord } from './store-types.js';

export interface ExpireAwakenedRunFilter {
  ownerUserId?: string;
  catId?: string;
  runId?: string;
}

export function expireAwakenedRuns(
  context: AutoDreamStoreContext,
  filter: ExpireAwakenedRunFilter = {},
): PresentLoopRunRecord[] {
  const now = context.now();
  const clauses = ["state = 'awakened'", 'lease_expires_at <= ?'];
  const params: Array<string | number> = [now];
  if (filter.ownerUserId) {
    clauses.push('owner_user_id = ?');
    params.push(filter.ownerUserId);
  }
  if (filter.catId) {
    clauses.push('cat_id = ?');
    params.push(filter.catId);
  }
  if (filter.runId) {
    clauses.push('run_id = ?');
    params.push(filter.runId);
  }

  return context.db.transaction(() => {
    const due = context.db
      .prepare(`SELECT * FROM present_loop_runs WHERE ${clauses.join(' AND ')} ORDER BY awakened_at, run_id`)
      .all(...params) as DbRow[];
    const expired: PresentLoopRunRecord[] = [];
    for (const row of due) {
      const run = rowToRun(row);
      const updated = context.db
        .prepare(
          `UPDATE present_loop_runs
           SET state = 'wake_expired', expired_at = ?, updated_at = ?
           WHERE owner_user_id = ? AND run_id = ? AND state = 'awakened' AND lease_expires_at <= ?`,
        )
        .run(now, now, run.ownerUserId, run.runId, now);
      if (updated.changes !== 1) continue;
      insertAutoDreamEvent(context, run.ownerUserId, run.catId, run.runId, 'wake_expired', {
        reason: 'lease_expired',
        leaseExpiresAt: run.leaseExpiresAt,
      });
      expired.push({ ...run, state: 'wake_expired', expiredAt: now, updatedAt: now });
    }
    return expired;
  })();
}
