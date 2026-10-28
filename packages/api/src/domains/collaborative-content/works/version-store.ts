import { isDeepStrictEqual } from 'node:util';
import { type WorkVersionRecord, workVersionRecordSchema } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { AssetCanonStore } from '../asset-canon/store.js';
import { WorkContextStore } from './context-store.js';

/** Version annotations in the existing F309 database; only F138 owns identity, head and receipts. */
export class WorkVersionStore {
  readonly contexts: WorkContextStore;
  readonly assets: AssetCanonStore;
  constructor(private readonly db: Database.Database) {
    this.contexts = new WorkContextStore(db);
    this.assets = new AssetCanonStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS work_version_annotations (
      owner_user_id TEXT NOT NULL, content_ref TEXT NOT NULL, owner_revision INTEGER NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(owner_user_id, content_ref, owner_revision)
    )`);
  }

  recordVersion(input: WorkVersionRecord): WorkVersionRecord {
    const record = workVersionRecordSchema.parse(input);
    return this.db
      .transaction(() => {
        const previous = this.get(record.ownerUserId, record.contentRef, record.ownerRevision);
        if (previous) {
          if (!isDeepStrictEqual(previous, record)) throw new Error('Work version annotation idempotency conflict');
          return previous;
        }
        this.db
          .prepare('INSERT INTO work_version_annotations VALUES (?, ?, ?, ?)')
          .run(record.ownerUserId, record.contentRef, record.ownerRevision, JSON.stringify(record));
        return record;
      })
      .immediate();
  }

  get(ownerUserId: string, contentRef: string, ownerRevision: number): WorkVersionRecord | null {
    const row = this.db
      .prepare('SELECT body FROM work_version_annotations WHERE owner_user_id=? AND content_ref=? AND owner_revision=?')
      .get(ownerUserId, contentRef, ownerRevision) as { body: string } | undefined;
    return row ? workVersionRecordSchema.parse(JSON.parse(row.body)) : null;
  }
}
