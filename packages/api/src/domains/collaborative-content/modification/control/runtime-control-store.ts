import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContentModificationRecord, ContentRuntimeControl, ContentRuntimeControlTarget } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { ContentModificationJournalError } from '../journal-errors.js';

/** Stores explicit selections and native acknowledgements, never a second queue or execution state. */
export class ModificationRuntimeControlStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS content_modification_controls (
      receipt_ref TEXT PRIMARY KEY, request_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(request_id,kind)
    )`);
  }
  list(requestId: string, ownerUserId: string): ContentRuntimeControl[] {
    return (
      this.db
        .prepare('SELECT body FROM content_modification_controls WHERE request_id=? AND owner_user_id=? ORDER BY kind')
        .all(requestId, ownerUserId) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as ContentRuntimeControl);
  }
  get(receiptRef: string, ownerUserId: string): ContentRuntimeControl | undefined {
    const row = this.db
      .prepare('SELECT body FROM content_modification_controls WHERE receipt_ref=? AND owner_user_id=?')
      .get(receiptRef, ownerUserId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ContentRuntimeControl) : undefined;
  }
  confirm(record: ContentModificationRecord, target: ContentRuntimeControlTarget): ContentRuntimeControl {
    return this.db
      .transaction(() => {
        const existing = this.list(record.requestId, record.ownerUserId).find(
          (item) => item.target.kind === target.kind,
        );
        if (existing) {
          if (!isDeepStrictEqual(existing.target, target))
            throw new ContentModificationJournalError('operation_reused');
          return existing;
        }
        const action: ContentRuntimeControl = {
          receiptRef: `f309-control:${createHash('sha256')
            .update(JSON.stringify([record.requestId, target.kind]))
            .digest('hex')}`,
          requestId: record.requestId,
          ownerUserId: record.ownerUserId,
          threadId: record.payload.threadId,
          catId: record.payload.targetCatId,
          target,
          confirmedAt: Date.now(),
          state: 'confirmed',
        };
        this.db
          .prepare('INSERT INTO content_modification_controls VALUES(?,?,?,?,?)')
          .run(action.receiptRef, action.requestId, action.ownerUserId, target.kind, JSON.stringify(action));
        return action;
      })
      .immediate();
  }
  observe(receiptRef: string, ownerUserId: string, statusCode: number, acknowledged: boolean, code?: string) {
    return this.db
      .transaction(() => {
        const action = this.get(receiptRef, ownerUserId);
        if (!action) throw new ContentModificationJournalError('not_found');
        if (action.state === 'acknowledged') return action;
        const next: ContentRuntimeControl = {
          ...action,
          state: acknowledged ? 'acknowledged' : 'confirmed',
          observation: { statusCode, ...(code ? { code } : {}), observedAt: Date.now() },
        };
        this.db
          .prepare('UPDATE content_modification_controls SET body=? WHERE receipt_ref=?')
          .run(JSON.stringify(next), receiptRef);
        return next;
      })
      .immediate();
  }
}
