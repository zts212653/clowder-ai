import { isRecallResultStatus } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { RecallCandidateView } from './recall-candidate-view.js';

export interface RecallPageEventRow {
  recall_id: string;
  cat_id: string;
  invocation_id: string;
  source_event_id: string | null;
  tool_name: string;
  query: string;
  mode: string | null;
  scope: string | null;
  candidates_json: string;
  consumed_json: string;
  result_count: number | null;
  result_status: string | null;
  timestamp: number;
  source: 'pull' | 'push';
  push_surface: string | null;
  inspected: number;
}
export function readRecallPageEvent(db: Database.Database, id: string) {
  return db
    .prepare(`SELECT recall_id, cat_id, invocation_id, source_event_id, tool_name, query, mode, scope,
    candidates_json, consumed_json, result_count, result_status, timestamp, source, push_surface, inspected
    FROM recall_events WHERE recall_id = ?`)
    .get(id) as RecallPageEventRow | undefined;
}
export function recallCandidates(row: RecallPageEventRow) {
  const raw: unknown = JSON.parse(row.candidates_json || '[]');
  if (!Array.isArray(raw) || raw.some((item) => !item || typeof item.anchor !== 'string'))
    throw new Error('Malformed recall candidates');
  return raw as Array<{ anchor: string }>;
}
function resultStatus(row: RecallPageEventRow) {
  if (isRecallResultStatus(row.result_status)) return row.result_status;
  if (row.result_count == null) return 'legacy_unknown';
  return row.result_count === 0 ? 'no_results' : 'counted';
}
export function projectRecallPageEvent(row: RecallPageEventRow, views: Map<string, RecallCandidateView>) {
  const status = resultStatus(row);
  const consumed: unknown = JSON.parse(row.consumed_json || '[]');
  const anchors = new Set(
    Array.isArray(consumed) ? consumed.flatMap((item) => (typeof item?.anchor === 'string' ? [item.anchor] : [])) : [],
  );
  return {
    id: row.recall_id,
    catId: row.cat_id || undefined,
    invocationId: row.invocation_id || undefined,
    sourceEventId: row.source_event_id ?? undefined,
    toolName: row.tool_name,
    query: row.query,
    mode: row.mode ?? undefined,
    scope: row.scope ?? undefined,
    timestamp: row.timestamp,
    source: row.source,
    pushSurface: row.push_surface ?? undefined,
    inspected: row.inspected === 1,
    consumedCount: anchors.size,
    ...(status !== 'legacy_unknown' && row.result_count != null ? { resultCount: row.result_count } : {}),
    resultStatus: status,
    results: recallCandidates(row).map(({ anchor }) => ({
      anchor,
      title: views.get(anchor)?.title ?? '',
      titleStatus: views.get(anchor)?.titleStatus,
      sourceType: views.get(anchor)?.kind,
      href: views.get(anchor)?.href ?? null,
      consumed: anchors.has(anchor),
    })),
  };
}
