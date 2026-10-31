import type { ArtifactReviewAuditEntry, ArtifactReviewReceipt } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { ArtifactReviewError } from './errors.js';
import type { ReviewMutation } from './store.js';
import { fingerprint, receiptReference } from './store-support.js';

interface OperationRow {
  fingerprint: string;
  receipt: string;
  round: number;
  kind: string;
  detail: string;
}
export class ArtifactReviewAuditStore {
  constructor(private readonly database: Database.Database) {
    database.exec(`CREATE INDEX IF NOT EXISTS artifact_review_operations_receipt
      ON artifact_review_operations(review_id, json_extract(receipt,'$.receiptRef'));`);
  }
  receiptByRef(reviewId: string, receiptRef: string): ArtifactReviewReceipt | null {
    const rows = this.database
      .prepare(`SELECT receipt FROM artifact_review_operations
      WHERE review_id=? AND json_extract(receipt,'$.receiptRef')=?`)
      .all(reviewId, receiptRef) as Pick<OperationRow, 'receipt'>[];
    if (rows.length > 1) throw new ArtifactReviewError('operation_reused');
    return rows[0] ? (JSON.parse(rows[0].receipt) as ArtifactReviewReceipt) : null;
  }
  history(reviewId: string, afterRevision = 0, limit = 100): ArtifactReviewAuditEntry[] {
    if (
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new ArtifactReviewError('invalid_action');
    }
    const rows = this.database
      .prepare(
        'SELECT fingerprint, receipt, round, kind, detail FROM artifact_review_operations WHERE review_id = ? AND revision > ? ORDER BY revision LIMIT ?',
      )
      .all(reviewId, afterRevision, limit) as OperationRow[];
    return rows.map((row) => ({
      receipt: JSON.parse(row.receipt) as ArtifactReviewReceipt,
      round: row.round,
      kind: row.kind,
      detail: JSON.parse(row.detail) as unknown,
    }));
  }

  operation(reviewId: string, operationId: string): OperationRow | undefined {
    return this.database
      .prepare(
        'SELECT fingerprint, receipt, round, kind, detail FROM artifact_review_operations WHERE review_id = ? AND operation_id = ?',
      )
      .get(reviewId, operationId) as OperationRow | undefined;
  }

  writeOperation(
    input: ReviewMutation,
    revision: number,
    predecessor?: unknown,
    outcome: ArtifactReviewReceipt['outcome'] = 'applied',
  ): ArtifactReviewReceipt {
    const receipt: ArtifactReviewReceipt = {
      receiptRef: receiptReference(input.reviewId, input.operationId),
      reviewId: input.reviewId,
      operationId: input.operationId,
      revision,
      actor: input.actor,
      createdAt: input.now,
      outcome,
    };
    this.database
      .prepare(
        'INSERT INTO artifact_review_operations (review_id, operation_id, fingerprint, revision, receipt, round, kind, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.reviewId,
        input.operationId,
        fingerprint(input),
        revision,
        JSON.stringify(receipt),
        input.round,
        input.kind,
        JSON.stringify({ request: input.request, ...(predecessor !== undefined ? { predecessor } : {}) }),
      );
    return receipt;
  }
}
