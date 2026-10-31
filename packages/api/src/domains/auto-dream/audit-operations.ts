import type { AutoDreamStoreContext } from './store-context.js';
import type { DbRow } from './store-rows.js';

export interface AutoDreamAuditEventRecord {
  eventId: string;
  ownerUserId: string;
  catId: string;
  runId: string;
  eventKind: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export function listAuditEvents(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  filter: { runId?: string; catId?: string; eventKind?: string; limit?: number } = {},
): AutoDreamAuditEventRecord[] {
  const clauses = ['owner_user_id = ?'];
  const params: Array<string | number> = [ownerUserId];
  if (filter.runId) {
    clauses.push('run_id = ?');
    params.push(filter.runId);
  }
  if (filter.catId) {
    clauses.push('cat_id = ?');
    params.push(filter.catId);
  }
  if (filter.eventKind) {
    clauses.push('event_kind = ?');
    params.push(filter.eventKind);
  }
  params.push(Math.max(1, Math.min(filter.limit ?? 100, 500)));
  const rows = context.db
    .prepare(
      `SELECT rowid, * FROM auto_dream_events
       WHERE ${clauses.join(' AND ')} ORDER BY created_at, rowid LIMIT ?`,
    )
    .all(...params) as DbRow[];
  return rows.map((row) => ({
    eventId: String(row.event_id),
    ownerUserId: String(row.owner_user_id),
    catId: String(row.cat_id),
    runId: String(row.run_id),
    eventKind: String(row.event_kind),
    payload: parsePayload(row.payload_json),
    createdAt: Number(row.created_at),
  }));
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
