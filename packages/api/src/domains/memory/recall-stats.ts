import type Database from 'better-sqlite3';

export interface RecallStats24h {
  total: number;
  consumed: number;
  reformulated: number;
  abandoned: number;
  fellBackToGrep: number;
}

export function getRecallStats24h(db: Database.Database): RecallStats24h {
  const cutoff = Date.now() - 86_400_000;
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN consumed_json != '[]' THEN 1 ELSE 0 END) AS consumed,
        SUM(reformulated) AS reformulated,
        SUM(abandoned) AS abandoned,
        SUM(fell_back_to_grep) AS fellBackToGrep
      FROM recall_events
      WHERE timestamp >= ?`,
    )
    .get(cutoff) as
    | { total: number; consumed: number; reformulated: number; abandoned: number; fellBackToGrep: number }
    | undefined;

  return {
    total: row?.total ?? 0,
    consumed: row?.consumed ?? 0,
    reformulated: row?.reformulated ?? 0,
    abandoned: row?.abandoned ?? 0,
    fellBackToGrep: row?.fellBackToGrep ?? 0,
  };
}
