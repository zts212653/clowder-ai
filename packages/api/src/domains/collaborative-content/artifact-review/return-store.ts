import type { ArtifactReview, ArtifactReviewReceipt } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { ReviewMutation } from './store.js';

export interface ReviewReturnTarget {
  targetCatId: string;
  expectedTaskRevision: number;
}

/** Delivery custody only. The referenced Task and review remain their respective owners' truth. */
export interface ReviewReturnIntent extends ReviewReturnTarget {
  receiptRef: string;
  reviewId: string;
  reviewRevision: number;
  round: number;
  ownerUserId: string;
  threadId: string;
  taskId: string;
  contentRef: string;
  ownerRevision: number;
  state: 'pending' | 'queued' | 'retired';
  kind: 'submit_feedback' | 'decide' | 'reopen' | 'request_image_edit';
  createdAt: string;
  messageId?: string;
  retirementReason?: string;
}

export class ArtifactReviewReturnStore {
  constructor(private readonly database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS artifact_review_returns (
      receipt_ref TEXT PRIMARY KEY, state TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS artifact_review_returns_pending ON artifact_review_returns(state, created_at);`);
  }

  /** Called inside the review mutation transaction, never independently of the human decision receipt. */
  record(review: ArtifactReview, receipt: ArtifactReviewReceipt, input: ReviewMutation): void {
    if (receipt.outcome !== 'applied' || receipt.actor.kind !== 'human' || !input.returnTarget) return;
    const kind = input.kind;
    if (kind !== 'submit_feedback' && kind !== 'decide' && kind !== 'reopen' && kind !== 'request_image_edit') return;
    const round = review.rounds.find((item) => item.number === input.round);
    if (!round) throw new Error('Review return has no receipt round');
    const intent: ReviewReturnIntent = {
      ...input.returnTarget,
      receiptRef: receipt.receiptRef,
      reviewId: review.reviewId,
      reviewRevision: receipt.revision,
      round: round.number,
      ownerUserId: review.task.ownerUserId,
      threadId: review.task.threadId,
      taskId: review.task.taskId,
      contentRef: review.contentRef,
      ownerRevision: round.asset.ownerRevision,
      state: 'pending',
      kind,
      createdAt: receipt.createdAt,
    };
    this.database
      .prepare('INSERT INTO artifact_review_returns (receipt_ref, state, created_at, body) VALUES (?, ?, ?, ?)')
      .run(intent.receiptRef, intent.state, intent.createdAt, JSON.stringify(intent));
  }

  pending(limit = 100): ReviewReturnIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid return batch limit');
    const rows = this.database
      .prepare(
        "SELECT body FROM artifact_review_returns WHERE state = 'pending' ORDER BY created_at, receipt_ref LIMIT ?",
      )
      .all(limit) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as ReviewReturnIntent);
  }

  get(receiptRef: string): ReviewReturnIntent | null {
    const row = this.database
      .prepare('SELECT body FROM artifact_review_returns WHERE receipt_ref = ?')
      .get(receiptRef) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ReviewReturnIntent) : null;
  }

  latest(reviewId: string): ReviewReturnIntent | null {
    const row = this.database
      .prepare(
        "SELECT body FROM artifact_review_returns WHERE json_extract(body, '$.reviewId') = ? ORDER BY json_extract(body, '$.reviewRevision') DESC LIMIT 1",
      )
      .get(reviewId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ReviewReturnIntent) : null;
  }

  queued(receiptRef: string, messageId: string): void {
    const intent = this.get(receiptRef);
    if (!intent || intent.state !== 'pending') return;
    this.update({ ...intent, state: 'queued', messageId });
  }

  retire(receiptRef: string, retirementReason: string): void {
    const intent = this.get(receiptRef);
    if (!intent || intent.state !== 'pending') return;
    this.update({ ...intent, state: 'retired', retirementReason });
  }

  private update(intent: ReviewReturnIntent): void {
    this.database
      .prepare("UPDATE artifact_review_returns SET state = ?, body = ? WHERE receipt_ref = ? AND state = 'pending'")
      .run(intent.state, JSON.stringify(intent), intent.receiptRef);
  }
}
