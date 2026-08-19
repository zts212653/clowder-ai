import type { AutoDreamStoreContext } from './store-context.js';
import { type DbRow, rowToCitation, rowToDiary } from './store-rows.js';
import type {
  DiaryCitationRecord,
  DiaryTraceKind,
  DreamDiaryEntryRecord,
  PresentLoopMetrics,
  PresentLoopOutcome,
} from './store-types.js';

const MINIMUM_DIARY_SAMPLES = 5;

export function getDiary(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
): DreamDiaryEntryRecord | null {
  const row = context.db
    .prepare('SELECT * FROM dream_diary_entries WHERE owner_user_id = ? AND diary_id = ?')
    .get(ownerUserId, diaryId) as DbRow | undefined;
  return row ? rowToDiary(row) : null;
}

export function listDiaries(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  options: { includeArchived?: boolean; limit?: number; catId?: string } = {},
): DreamDiaryEntryRecord[] {
  const params: Array<string | number> = [ownerUserId];
  let sql = 'SELECT * FROM dream_diary_entries WHERE owner_user_id = ?';
  if (!options.includeArchived) sql += " AND status = 'published' AND sealed_at IS NULL";
  if (options.catId) {
    sql += ' AND cat_id = ?';
    params.push(options.catId);
  }
  sql += ' ORDER BY written_at DESC, rowid DESC LIMIT ?';
  params.push(Math.max(1, Math.min(options.limit ?? 50, 500)));
  return (context.db.prepare(sql).all(...params) as DbRow[]).map(rowToDiary);
}

export function archiveDiary(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
): DreamDiaryEntryRecord | null {
  const current = getDiary(context, ownerUserId, diaryId);
  if (!current || current.status === 'archived') return current;
  const now = context.now();
  context.db.transaction(() => {
    context.db
      .prepare(
        `UPDATE dream_diary_entries
         SET status = 'archived', archived_at = ?, revision = revision + 1, updated_at = ?
         WHERE owner_user_id = ? AND diary_id = ? AND status = 'published'`,
      )
      .run(now, now, ownerUserId, diaryId);
    context.db
      .prepare(
        `UPDATE dream_projection_state SET product_revision = product_revision + 1
         WHERE owner_user_id = ? AND diary_id = ?`,
      )
      .run(ownerUserId, diaryId);
  })();
  return getDiary(context, ownerUserId, diaryId);
}

export function listDiaryCitations(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
): DiaryCitationRecord[] {
  const rows = context.db
    .prepare(
      `SELECT * FROM dream_diary_citations
       WHERE owner_user_id = ? AND from_diary_id = ? ORDER BY cited_at, rowid`,
    )
    .all(ownerUserId, diaryId) as DbRow[];
  return rows.map(rowToCitation);
}

export function getMetrics(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  window = 20,
): PresentLoopMetrics {
  const safeWindow = Math.max(1, Math.min(Math.trunc(window), 500));
  const diaryRows = context.db
    .prepare(
      `SELECT trace_kind FROM dream_diary_entries
       WHERE owner_user_id = ? AND cat_id = ?
       ORDER BY written_at DESC, rowid DESC LIMIT ?`,
    )
    .all(ownerUserId, catId, safeWindow) as Array<{ trace_kind: DiaryTraceKind }>;
  const runRows = context.db
    .prepare(
      `SELECT outcome FROM present_loop_runs
       WHERE owner_user_id = ? AND cat_id = ? AND state = 'settled'
       ORDER BY settled_at DESC, rowid DESC LIMIT ?`,
    )
    .all(ownerUserId, catId, safeWindow) as Array<{ outcome: PresentLoopOutcome }>;

  const workCount = diaryRows.filter((row) => row.trace_kind === 'work').length;
  const workShare = diaryRows.length === 0 ? 0 : workCount / diaryRows.length;
  const lowSample = diaryRows.length < MINIMUM_DIARY_SAMPLES;
  const outcomes: Record<PresentLoopOutcome, number> = { diary: 0, quiet: 0, daze: 0 };
  for (const row of runRows) outcomes[row.outcome] += 1;
  const silent = outcomes.quiet + outcomes.daze;
  return {
    window: safeWindow,
    diaryCount: diaryRows.length,
    workCount,
    workShare,
    minimumDiarySamples: MINIMUM_DIARY_SAMPLES,
    lowSample,
    reportificationWarning: !lowSample && workShare > 0.8,
    outcomes,
    silentOutcomeShare: runRows.length === 0 ? 0 : silent / runRows.length,
  };
}
