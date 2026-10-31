import { diaryEngagementInputSchema } from '@cat-cafe/shared';
import type { AutoDreamStoreContext } from './store-context.js';
import {
  AutoDreamStoreError,
  type DiaryEngagementMetrics,
  type DiaryEngagementRecord,
  type DiaryEngagementResult,
  type DiaryEngagementState,
  type DiaryEngagementValue,
} from './store-types.js';

interface DiaryIdentityRow {
  diary_id: string;
  cat_id: string;
}

interface EngagementRow {
  engagement_id: string;
  owner_user_id: string;
  diary_id: string;
  cat_id: string;
  kind: 'open' | 'reaction';
  client_event_id: string;
  active: number;
  created_at: number;
}

export function recordDiaryEngagement(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
  rawInput: DiaryEngagementValue,
): DiaryEngagementResult {
  const parsed = diaryEngagementInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AutoDreamStoreError('INVALID_ENGAGEMENT', `invalid diary engagement: ${parsed.error.message}`, 400);
  }
  const diary = context.db
    .prepare(
      `SELECT diary_id, cat_id FROM dream_diary_entries
       WHERE owner_user_id = ? AND diary_id = ?`,
    )
    .get(ownerUserId, diaryId) as DiaryIdentityRow | undefined;
  if (!diary) throw new AutoDreamStoreError('DIARY_NOT_FOUND', 'diary not found', 404);

  const input = parsed.data;
  const active = input.kind === 'open' ? true : input.active;
  if (input.kind === 'reaction') {
    const opened = context.db
      .prepare(
        `SELECT 1 FROM diary_engagement_events
         WHERE owner_user_id = ? AND diary_id = ? AND kind = 'open'
         LIMIT 1`,
      )
      .get(ownerUserId, diaryId);
    if (!opened) {
      throw new AutoDreamStoreError('INVALID_ENGAGEMENT', 'reaction requires an explicit diary open', 409);
    }
  }
  const existing = context.db
    .prepare(
      `SELECT * FROM diary_engagement_events
       WHERE owner_user_id = ? AND diary_id = ? AND kind = ? AND client_event_id = ?`,
    )
    .get(ownerUserId, diaryId, input.kind, input.clientEventId) as EngagementRow | undefined;
  if (existing) {
    if ((existing.active === 1) !== active) {
      throw new AutoDreamStoreError(
        'INVALID_ENGAGEMENT',
        'clientEventId was already used with a different engagement value',
        409,
      );
    }
    return {
      event: rowToEngagement(existing),
      state: getDiaryEngagement(context, ownerUserId, diaryId),
      created: false,
    };
  }

  const engagementId = context.idFactory('diaryengage_');
  context.db
    .prepare(
      `INSERT INTO diary_engagement_events (
         engagement_id, owner_user_id, diary_id, cat_id, kind,
         client_event_id, active, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      engagementId,
      ownerUserId,
      diary.diary_id,
      diary.cat_id,
      input.kind,
      input.clientEventId,
      active ? 1 : 0,
      context.now(),
    );
  const event = context.db
    .prepare('SELECT * FROM diary_engagement_events WHERE engagement_id = ?')
    .get(engagementId) as EngagementRow;
  return {
    event: rowToEngagement(event),
    state: getDiaryEngagement(context, ownerUserId, diaryId),
    created: true,
  };
}

export function getDiaryEngagement(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
): DiaryEngagementState {
  const diary = context.db
    .prepare('SELECT diary_id FROM dream_diary_entries WHERE owner_user_id = ? AND diary_id = ?')
    .get(ownerUserId, diaryId);
  if (!diary) throw new AutoDreamStoreError('DIARY_NOT_FOUND', 'diary not found', 404);

  const openCount = Number(
    (
      context.db
        .prepare(
          `SELECT COUNT(*) AS count FROM diary_engagement_events
           WHERE owner_user_id = ? AND diary_id = ? AND kind = 'open'`,
        )
        .get(ownerUserId, diaryId) as { count: number }
    ).count,
  );
  const latestReaction = context.db
    .prepare(
      `SELECT active FROM diary_engagement_events
       WHERE owner_user_id = ? AND diary_id = ? AND kind = 'reaction'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ownerUserId, diaryId) as { active: number } | undefined;
  return {
    opened: openCount > 0,
    reacted: latestReaction?.active === 1,
    openCount,
  };
}

export function getDiaryEngagementMetrics(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
): DiaryEngagementMetrics {
  const publishedDiaryCount = countQuery(
    context,
    `SELECT COUNT(*) AS count FROM dream_diary_entries
     WHERE owner_user_id = ? AND cat_id = ? AND status = 'published' AND sealed_at IS NULL`,
    ownerUserId,
    catId,
  );
  const openedDiaryCount = countQuery(
    context,
    `SELECT COUNT(DISTINCT d.diary_id) AS count
     FROM dream_diary_entries d
     JOIN diary_engagement_events e
       ON e.owner_user_id = d.owner_user_id AND e.diary_id = d.diary_id AND e.kind = 'open'
     WHERE d.owner_user_id = ? AND d.cat_id = ? AND d.status = 'published' AND d.sealed_at IS NULL`,
    ownerUserId,
    catId,
  );
  const reactedDiaryCount = countQuery(
    context,
    `SELECT COUNT(*) AS count
     FROM dream_diary_entries d
     JOIN diary_engagement_events latest
       ON latest.owner_user_id = d.owner_user_id
      AND latest.diary_id = d.diary_id
      AND latest.kind = 'reaction'
     WHERE d.owner_user_id = ? AND d.cat_id = ? AND d.status = 'published' AND d.sealed_at IS NULL
       AND latest.active = 1
       AND NOT EXISTS (
         SELECT 1 FROM diary_engagement_events newer
         WHERE newer.owner_user_id = latest.owner_user_id
           AND newer.diary_id = latest.diary_id
           AND newer.kind = 'reaction'
           AND (
             newer.created_at > latest.created_at
             OR (newer.created_at = latest.created_at AND newer.rowid > latest.rowid)
           )
       )`,
    ownerUserId,
    catId,
  );
  return {
    publishedDiaryCount,
    openedDiaryCount,
    reactedDiaryCount,
    diaryOpenRate: publishedDiaryCount === 0 ? 0 : openedDiaryCount / publishedDiaryCount,
    reactionRate: openedDiaryCount === 0 ? 0 : reactedDiaryCount / openedDiaryCount,
  };
}

function countQuery(context: AutoDreamStoreContext, sql: string, ownerUserId: string, catId: string): number {
  const row = context.db.prepare(sql).get(ownerUserId, catId) as { count: number };
  return Number(row.count);
}

function rowToEngagement(row: EngagementRow): DiaryEngagementRecord {
  return {
    engagementId: row.engagement_id,
    ownerUserId: row.owner_user_id,
    diaryId: row.diary_id,
    catId: row.cat_id,
    kind: row.kind,
    clientEventId: row.client_event_id,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}
