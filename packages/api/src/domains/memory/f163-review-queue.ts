/**
 * F163 Phase C (AC-C3): Review queue — finds stale knowledge items.
 * Pure SQL query: docs where verified_at + review_cycle_days indicates staleness.
 */

import type Database from 'better-sqlite3';

export interface ReviewQueueItem {
  anchor: string;
  kind: string;
  title: string;
  verifiedAt: string;
  reviewCycleDays: number;
  daysSince: number;
  staleness: 'warning' | 'overdue';
}

const DEFAULT_CYCLE_DAYS: Record<string, number> = {
  lesson: 90,
  decision: 180,
  feature: 120,
  session: 60,
  thread: 60,
  discussion: 120,
  research: 120,
  plan: 120,
  'pack-knowledge': 90,
};

export function queryReviewQueue(db: Database.Database, opts?: { limit?: number; now?: string }): ReviewQueueItem[] {
  const limit = opts?.limit ?? 50;
  const nowValue = opts?.now ?? new Date().toISOString();

  const rows = db
    .prepare(
      `SELECT anchor, kind, title, verified_at, review_cycle_days,
        CAST(julianday(?) - julianday(verified_at) AS INTEGER) AS days_since
       FROM evidence_docs
       WHERE status = 'active'
         AND verified_at IS NOT NULL
         AND review_cycle_days IS NOT NULL
         AND julianday(?) - julianday(verified_at) > review_cycle_days * 0.8
       ORDER BY days_since DESC
       LIMIT ?`,
    )
    .all(nowValue, nowValue, limit) as Array<{
    anchor: string;
    kind: string;
    title: string;
    verified_at: string;
    review_cycle_days: number;
    days_since: number;
  }>;

  return rows.map((r) => ({
    anchor: r.anchor,
    kind: r.kind,
    title: r.title,
    verifiedAt: r.verified_at,
    reviewCycleDays: r.review_cycle_days,
    daysSince: r.days_since,
    staleness: r.days_since >= r.review_cycle_days ? 'overdue' : 'warning',
  }));
}

export { DEFAULT_CYCLE_DAYS };
