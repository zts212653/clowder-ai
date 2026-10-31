import type Database from 'better-sqlite3';
import { compareCursors, parseCursor } from '../../../cats/services/stores/cursor.js';
import { WorkspaceContentReviewError } from '../errors.js';

/** Import recovery metadata shares the canonical ledger database; successful writes replay after a crash. */
export class VideoProjectMessageImportCursor {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS video_project_message_import_cursors (
      owner_user_id TEXT NOT NULL, content_ref TEXT NOT NULL, thread_id TEXT NOT NULL, cursor TEXT NOT NULL,
      PRIMARY KEY(owner_user_id, content_ref, thread_id))`);
  }
  get(ownerUserId: string, contentRef: string, threadId: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT cursor FROM video_project_message_import_cursors WHERE owner_user_id=? AND content_ref=? AND thread_id=?',
      )
      .get(ownerUserId, contentRef, threadId) as { cursor: string } | undefined;
    return row?.cursor;
  }
  advance(
    ownerUserId: string,
    contentRef: string,
    threadId: string,
    expected: string | undefined,
    cursor: string,
  ): string {
    const next = parseCursor(cursor);
    if (!next) throw new WorkspaceContentReviewError('revision_conflict');
    return this.db
      .transaction(() => {
        const current = this.get(ownerUserId, contentRef, threadId);
        if (current !== expected) {
          // Only the same coordinate domain can prove that another successful page already covers this page.
          if (current && pageAlreadyCovered(current, cursor)) return current;
          throw new WorkspaceContentReviewError('revision_conflict');
        }
        if (current === cursor) return current;
        assertMonotonicAdvance(current, cursor);
        this.db
          .prepare(
            'INSERT INTO video_project_message_import_cursors(owner_user_id,content_ref,thread_id,cursor) VALUES(?,?,?,?) ON CONFLICT(owner_user_id,content_ref,thread_id) DO UPDATE SET cursor=excluded.cursor',
          )
          .run(ownerUserId, contentRef, threadId, cursor);
        return cursor;
      })
      .immediate();
  }
}

function pageAlreadyCovered(current: string, cursor: string) {
  const before = parseCursor(current),
    after = parseCursor(cursor);
  return before?.version === after?.version && compareCursors(current, cursor) >= 0;
}
function assertMonotonicAdvance(current: string | undefined, cursor: string) {
  if (!current) return;
  const before = parseCursor(current),
    after = parseCursor(cursor);
  if (
    (before?.version === 2 && after?.version === 1) ||
    (before?.version === after?.version && compareCursors(cursor, current) < 0)
  )
    throw new WorkspaceContentReviewError('revision_conflict');
}
