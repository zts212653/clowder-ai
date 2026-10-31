import type Database from 'better-sqlite3';
import { visibleRecallThreads } from './memory-recall-query.js';
import type { RecallSourceReaders } from './recall-candidate-view.js';

/** Same recall_events ledger units, bounded by canonical owner visibility and both time boundaries. */
export async function readMemoryRecallStats(
  db: Database.Database,
  owner: string,
  store: NonNullable<RecallSourceReaders['threadStore']>,
  days: number,
) {
  const threads = await visibleRecallThreads(owner, store);
  const to = Date.now();
  const from = to - days * 86400000;
  const rows = db
    .prepare(`SELECT source, COALESCE(push_surface, tool_name) AS surface,
    COUNT(*) AS presented, SUM(inspected) AS inspected,
    SUM(CASE WHEN outcome = 'used' THEN 1 ELSE 0 END) AS used
    FROM recall_events WHERE timestamp BETWEEN @from AND @to
      AND thread_id IN (SELECT value FROM json_each(@threads))
    GROUP BY source, COALESCE(push_surface, tool_name) ORDER BY source DESC, presented DESC`)
    .all({
      from,
      to,
      threads: JSON.stringify([...threads.keys()]),
    });
  return { days, from, to, rows };
}
