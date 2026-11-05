import type Database from 'better-sqlite3';

/** Storage-only row shape for the durable projection recovery cursor. */
interface ProjectionRow {
  readonly request_id: string;
  readonly body: string;
}

export function initializeContentModificationProjectionCursor(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS content_modification_projection_cursor (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_request_id TEXT
  ); INSERT OR IGNORE INTO content_modification_projection_cursor(singleton,last_request_id) VALUES(1,NULL);`);
}

/**
 * Return one durable round-robin batch. Advancing inside the same immediate
 * transaction makes concurrent poller attempts share one recovery frontier.
 */
export function nextContentModificationProjectionBodies(db: Database.Database, limit: number): string[] {
  return db
    .transaction(() => {
      const cursor = db
        .prepare('SELECT last_request_id FROM content_modification_projection_cursor WHERE singleton=1')
        .get() as { last_request_id: string | null };
      let rows = db
        .prepare(
          `SELECT request_id,body FROM content_modification_requests
           WHERE request_id>? AND COALESCE(json_extract(body,'$.kind'),'private')<>'collective-artifact' ORDER BY request_id LIMIT ?`,
        )
        .all(cursor.last_request_id ?? '', limit) as ProjectionRow[];
      if (rows.length === 0 && cursor.last_request_id !== null) {
        rows = db
          .prepare(`SELECT request_id,body FROM content_modification_requests
            WHERE COALESCE(json_extract(body,'$.kind'),'private')<>'collective-artifact' ORDER BY request_id LIMIT ?`)
          .all(limit) as ProjectionRow[];
      }
      db.prepare('UPDATE content_modification_projection_cursor SET last_request_id=? WHERE singleton=1').run(
        rows.at(-1)?.request_id ?? null,
      );
      return rows.map((row) => row.body);
    })
    .immediate();
}
