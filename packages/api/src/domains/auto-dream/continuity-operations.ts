import type { AutoDreamStoreContext } from './store-context.js';
import { type DbRow, rowToPosture } from './store-rows.js';
import type { InvocationPrincipal, SleepPosturePayload, SleepPostureRecord } from './store-types.js';

export function leasePendingContinuity(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  runId: string,
  now: number,
): SleepPostureRecord | null {
  const pending = context.db
    .prepare(
      `SELECT posture_id FROM sleep_postures
       WHERE owner_user_id = ? AND cat_id = ? AND status = 'pending'
       ORDER BY created_at DESC, posture_id DESC LIMIT 1`,
    )
    .get(ownerUserId, catId) as { posture_id: string } | undefined;
  if (!pending) return null;
  context.db
    .prepare(
      `UPDATE present_loop_runs SET continuity_posture_id = ?, updated_at = ?
       WHERE owner_user_id = ? AND run_id = ? AND state = 'awakened'`,
    )
    .run(pending.posture_id, now, ownerUserId, runId);
  return getContinuityLease(context, ownerUserId, runId);
}

export function getContinuityLease(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  runId: string,
): SleepPostureRecord | null {
  const row = context.db
    .prepare(
      `SELECT posture.*,
              CASE WHEN run.state = 'awakened' THEN run.run_id END AS leased_by_run_id
       FROM present_loop_runs run
       JOIN sleep_postures posture ON posture.posture_id = run.continuity_posture_id
       WHERE run.owner_user_id = ? AND run.run_id = ? LIMIT 1`,
    )
    .get(ownerUserId, runId) as DbRow | undefined;
  return row ? rowToPosture(row) : null;
}

export function consumeContinuityLease(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  runId: string,
  now: number,
): void {
  context.db
    .prepare(
      `UPDATE sleep_postures
       SET status = 'archived', consumed_by_run_id = ?, consumed_at = ?,
           archived_at = ?, archive_reason = 'consumed', updated_at = ?
       WHERE owner_user_id = ? AND status = 'pending'
         AND posture_id = (
           SELECT continuity_posture_id FROM present_loop_runs
           WHERE owner_user_id = ? AND run_id = ? AND state = 'awakened'
         )`,
    )
    .run(runId, now, now, now, ownerUserId, ownerUserId, runId);
}

export function replacePendingPosture(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  payload: SleepPosturePayload,
  now: number,
): string {
  context.db
    .prepare(
      `UPDATE sleep_postures
       SET status = 'archived', archived_at = ?, archive_reason = 'superseded', updated_at = ?
       WHERE owner_user_id = ? AND cat_id = ? AND status = 'pending'`,
    )
    .run(now, now, principal.userId, principal.catId);
  const postureId = context.idFactory('posture_');
  context.db
    .prepare(
      `INSERT INTO sleep_postures (
         posture_id, owner_user_id, cat_id, source_run_id, author_invocation_id,
         payload_json, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      postureId,
      principal.userId,
      principal.catId,
      runId,
      principal.invocationId,
      JSON.stringify(payload),
      now,
      now,
    );
  return postureId;
}
