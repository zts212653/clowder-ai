import type { AutoDreamStoreContext } from './store-context.js';
import { type DbRow, rowToPosture } from './store-rows.js';
import type { SleepPostureRecord } from './store-types.js';

export function getSleepPosture(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  postureId: string,
): SleepPostureRecord | null {
  const row = context.db
    .prepare(
      `SELECT posture.*,
              (SELECT run_id FROM present_loop_runs
               WHERE continuity_posture_id = posture.posture_id AND state = 'awakened'
               ORDER BY awakened_at DESC LIMIT 1) AS leased_by_run_id
       FROM sleep_postures posture
       WHERE owner_user_id = ? AND posture_id = ?`,
    )
    .get(ownerUserId, postureId) as DbRow | undefined;
  return row ? rowToPosture(row) : null;
}

export function listPendingPostures(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
): SleepPostureRecord[] {
  const rows = context.db
    .prepare(
      `SELECT posture.*,
              (SELECT run_id FROM present_loop_runs
               WHERE continuity_posture_id = posture.posture_id AND state = 'awakened'
               ORDER BY awakened_at DESC LIMIT 1) AS leased_by_run_id
       FROM sleep_postures posture
       WHERE owner_user_id = ? AND cat_id = ? AND status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(ownerUserId, catId) as DbRow[];
  return rows.map(rowToPosture);
}
