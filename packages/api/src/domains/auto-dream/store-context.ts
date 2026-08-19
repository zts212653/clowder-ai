import type Database from 'better-sqlite3';

export interface AutoDreamStoreContext {
  db: Database.Database;
  now: () => number;
  idFactory: (prefix: string) => string;
  awakenedLeaseMs: number;
  foregroundVisitBudget: number;
}

export function insertAutoDreamEvent(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  runId: string,
  eventKind: string,
  payload: Record<string, unknown>,
): void {
  context.db
    .prepare(
      `INSERT INTO auto_dream_events (
         event_id, owner_user_id, cat_id, run_id, event_kind, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      context.idFactory('dreamevent_'),
      ownerUserId,
      catId,
      runId,
      eventKind,
      JSON.stringify(payload),
      context.now(),
    );
}
