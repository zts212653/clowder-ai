import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContentModificationAcceptance, ContentModificationRejection } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { workspaceWritebackReceiptRef } from '../../workspace/writeback/journal.js';
import { ContentModificationJournalError } from './journal.js';

export type ContentAcceptance = ContentModificationAcceptance;
export class ContentAcceptanceStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS content_modification_acceptances (
      owner_user_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner_user_id,operation_id));
      CREATE TABLE IF NOT EXISTS content_modification_rejections (
        owner_user_id TEXT NOT NULL, request_id TEXT NOT NULL, candidate_ref TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner_user_id,request_id,candidate_ref));`);
  }
  reserve(input: Omit<ContentAcceptance, 'humanReceiptRef' | 'fileReceiptRef' | 'acceptedAt'>): ContentAcceptance {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT body FROM content_modification_acceptances WHERE owner_user_id=? AND operation_id=?')
          .get(input.ownerUserId, input.acceptOperationId) as { body: string } | undefined;
        if (row) {
          const old = JSON.parse(row.body) as ContentAcceptance;
          const { humanReceiptRef: _human, fileReceiptRef: _file, acceptedAt: _time, ...prior } = old;
          if (!isDeepStrictEqual(prior, input)) throw new ContentModificationJournalError('operation_reused');
          return old;
        }
        if (
          this.rejections(input.requestId, input.ownerUserId).some((item) => item.candidateRef === input.candidateRef)
        )
          throw new ContentModificationJournalError('candidate_rejected');
        const fileReceiptRef = workspaceWritebackReceiptRef(input.ownerUserId, input.acceptOperationId);
        const receipt = {
          ...input,
          fileReceiptRef,
          humanReceiptRef: `${fileReceiptRef}#human-accepted`,
          acceptedAt: Date.now(),
        };
        this.db
          .prepare('INSERT INTO content_modification_acceptances VALUES (?,?,?,?)')
          .run(input.ownerUserId, input.acceptOperationId, input.requestId, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
  list(requestId: string, ownerUserId: string): ContentAcceptance[] {
    const rows = this.db
      .prepare(
        'SELECT body FROM content_modification_acceptances WHERE request_id=? AND owner_user_id=? ORDER BY rowid',
      )
      .all(requestId, ownerUserId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as ContentAcceptance);
  }
  rejections(requestId: string, ownerUserId: string): ContentModificationRejection[] {
    const rows = this.db
      .prepare('SELECT body FROM content_modification_rejections WHERE request_id=? AND owner_user_id=? ORDER BY rowid')
      .all(requestId, ownerUserId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as ContentModificationRejection);
  }
  reject(requestId: string, ownerUserId: string, candidateRef: string): ContentModificationRejection {
    return this.db
      .transaction(() => {
        const old = this.rejections(requestId, ownerUserId).find((item) => item.candidateRef === candidateRef);
        if (old) return old;
        if (this.list(requestId, ownerUserId).some((item) => item.candidateRef === candidateRef))
          throw new ContentModificationJournalError('acceptance_exists');
        const receipt: ContentModificationRejection = {
          requestId,
          ownerUserId,
          actorId: ownerUserId,
          candidateRef,
          state: 'rejected',
          rejectedAt: Date.now(),
          receiptRef: `f309-rejection:${createHash('sha256')
            .update(JSON.stringify([requestId, ownerUserId, candidateRef]))
            .digest('hex')}`,
        };
        this.db
          .prepare('INSERT INTO content_modification_rejections VALUES (?,?,?,?)')
          .run(ownerUserId, requestId, candidateRef, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
}
