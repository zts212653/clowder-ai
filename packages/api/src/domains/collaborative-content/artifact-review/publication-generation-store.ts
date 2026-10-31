import type Database from 'better-sqlite3';
import type { MediaPublicationReturnIntent } from '../modification/media-publication/media-publication-return.js';
import { ArtifactReviewError } from './errors.js';

interface CurrentPublication {
  receipt_ref: string;
  generation: number;
}
/** Permanent index and command bindings on the existing review/outbox connection. */
export class PublicationGenerationStore {
  constructor(private readonly database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS artifact_publication_current (
      request_id TEXT PRIMARY KEY, receipt_ref TEXT NOT NULL REFERENCES artifact_review_returns(receipt_ref),
      generation INTEGER NOT NULL CHECK(generation >= 0)
    ); CREATE TABLE IF NOT EXISTS artifact_publication_recovery_commands (
      owner_user_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      receipt_ref TEXT NOT NULL REFERENCES artifact_review_returns(receipt_ref),
      PRIMARY KEY(owner_user_id, operation_id)
    );`);
    // Only unambiguous pre-generation history can initialize generation0. Never sort candidates into authority.
    database
      .prepare(`INSERT OR IGNORE INTO artifact_publication_current(request_id,receipt_ref,generation)
      SELECT json_extract(body,'$.requestId'), MIN(receipt_ref), 0 FROM artifact_review_returns
      WHERE json_extract(body,'$.kind')='resume_media_publication'
      GROUP BY json_extract(body,'$.requestId') HAVING COUNT(*)=1 AND MAX(json_extract(body,'$.recovery')) IS NULL`)
      .run();
  }

  current(requestId: string): CurrentPublication | undefined {
    const current = this.database
      .prepare('SELECT receipt_ref,generation FROM artifact_publication_current WHERE request_id=?')
      .get(requestId) as CurrentPublication | undefined;
    if (
      !current &&
      this.database
        .prepare(
          "SELECT 1 FROM artifact_review_returns WHERE json_extract(body,'$.kind')='resume_media_publication' AND json_extract(body,'$.requestId')=?",
        )
        .get(requestId)
    )
      throw new ArtifactReviewError('revision_conflict', 'Ambiguous publication history has no current generation');
    return current;
  }

  initial(intent: MediaPublicationReturnIntent): void {
    if (!this.database.inTransaction || intent.recovery) throw new ArtifactReviewError('invalid_action');
    const prior = this.database
      .prepare('SELECT receipt_ref FROM artifact_publication_current WHERE request_id=?')
      .get(intent.requestId) as { receipt_ref: string } | undefined;
    if (prior && prior.receipt_ref !== intent.receiptRef) throw new ArtifactReviewError('revision_conflict');
    this.database
      .prepare('INSERT OR IGNORE INTO artifact_publication_current(request_id,receipt_ref,generation) VALUES(?,?,0)')
      .run(intent.requestId, intent.receiptRef);
  }

  replay(ownerUserId: string, operationId: string, fingerprint: string): string | undefined {
    const row = this.database
      .prepare(
        'SELECT receipt_ref,fingerprint FROM artifact_publication_recovery_commands WHERE owner_user_id=? AND operation_id=?',
      )
      .get(ownerUserId, operationId) as { receipt_ref: string; fingerprint: string } | undefined;
    if (row && row.fingerprint !== fingerprint) throw new ArtifactReviewError('operation_reused');
    return row?.receipt_ref;
  }

  advance(intent: MediaPublicationReturnIntent, fingerprint: string): void {
    const recovery = intent.recovery;
    if (!this.database.inTransaction || !recovery) throw new ArtifactReviewError('invalid_action');
    const changed = this.database
      .prepare(`UPDATE artifact_publication_current SET receipt_ref=?,generation=?
      WHERE request_id=? AND receipt_ref=? AND generation=?`)
      .run(
        intent.receiptRef,
        recovery.generation,
        intent.requestId,
        recovery.recoveryOfReceiptRef,
        recovery.generation - 1,
      );
    if (changed.changes !== 1) throw new ArtifactReviewError('revision_conflict');
    this.database
      .prepare(
        'INSERT INTO artifact_publication_recovery_commands(owner_user_id,operation_id,fingerprint,receipt_ref) VALUES(?,?,?,?)',
      )
      .run(intent.ownerUserId, recovery.operationId, fingerprint, intent.receiptRef);
  }
}
