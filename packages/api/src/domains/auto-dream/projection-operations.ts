import type { AutoDreamStoreContext } from './store-context.js';
import { type DbRow, numberValue, rowToDiary, stringOrUndefined } from './store-rows.js';
import type { DiaryProjectionCandidate } from './store-types.js';

export function listProjectionCandidates(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  limit = 100,
): DiaryProjectionCandidate[] {
  const rows = context.db
    .prepare(
      `SELECT d.*, p.projected_revision, p.last_error
       FROM dream_diary_entries d
       JOIN dream_projection_state p
         ON p.owner_user_id = d.owner_user_id AND p.diary_id = d.diary_id
       WHERE d.owner_user_id = ? AND p.projected_revision < p.product_revision
       ORDER BY d.updated_at, d.diary_id LIMIT ?`,
    )
    .all(ownerUserId, Math.max(1, Math.min(limit, 1_000))) as DbRow[];
  return rows.map((row) => ({
    diary: rowToDiary(row),
    projectedRevision: numberValue(row.projected_revision),
    lastError: stringOrUndefined(row.last_error),
  }));
}

export function markDiaryProjected(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
  revision: number,
): boolean {
  const now = context.now();
  const result = context.db
    .prepare(
      `UPDATE dream_projection_state
       SET projected_revision = ?, last_error = NULL, last_attempt_at = ?, projected_at = ?
       WHERE owner_user_id = ? AND diary_id = ? AND product_revision = ?`,
    )
    .run(revision, now, now, ownerUserId, diaryId, revision);
  return result.changes === 1;
}

export function markDiaryProjectionFailed(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
  error: string,
): void {
  context.db
    .prepare(
      `UPDATE dream_projection_state SET last_error = ?, last_attempt_at = ?
       WHERE owner_user_id = ? AND diary_id = ?`,
    )
    .run(error.slice(0, 2_000), context.now(), ownerUserId, diaryId);
}
