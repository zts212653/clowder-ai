import type Database from 'better-sqlite3';

/** Observations only: owner, thread and current taste visibility are checked by the consumer. */
export interface TastePullRecallRow {
  recall_id: string;
  invocation_id: string;
  thread_id: string;
  candidates: readonly string[];
  consumed: readonly string[];
  timestamp: number;
}

interface StoredRecallRow {
  recall_id: string;
  invocation_id: string;
  thread_id: string;
  candidates_json: string;
  consumed_json: string;
  timestamp: number;
}

function tasteAnchors(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.flatMap((item) =>
          typeof item === 'object' &&
          item !== null &&
          'anchor' in item &&
          typeof item.anchor === 'string' &&
          item.anchor.startsWith('doc:taste/vignettes/')
            ? [item.anchor]
            : [],
        ),
      ),
    ];
  } catch {
    return [];
  }
}

/** Fixed read, including legacy JSON parsing, runs in the scan child for file-backed stores. */
export function readTastePullRecallRows(db: Database.Database): TastePullRecallRow[] {
  const rows: TastePullRecallRow[] = [];
  const query = db.prepare(`SELECT recall_id, invocation_id, thread_id, candidates_json, consumed_json, timestamp
    FROM recall_events WHERE source = 'pull'
      AND (candidates_json LIKE '%doc:taste/vignettes/%' OR consumed_json LIKE '%doc:taste/vignettes/%')
    ORDER BY timestamp ASC, recall_id ASC`);
  for (const value of query.iterate()) {
    const row = value as StoredRecallRow;
    const candidates = tasteAnchors(row.candidates_json);
    const consumed = tasteAnchors(row.consumed_json);
    if (candidates.length || consumed.length)
      rows.push({
        recall_id: row.recall_id,
        invocation_id: row.invocation_id,
        thread_id: row.thread_id,
        timestamp: row.timestamp,
        candidates,
        consumed,
      });
  }
  return rows;
}
