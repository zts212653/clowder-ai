import type { ApprovalProducerId } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';

export interface ApprovalDecisionSubject {
  ownerUserId: string;
  producerId: ApprovalProducerId;
  canonicalProposalId: string;
}

/** Durable delivery intent only. Decision state always comes from the producer. */
export class ApprovalDecisionReceiptOutbox {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS approval_decision_receipt_outbox_v1 (
      owner_user_id TEXT NOT NULL,
      producer_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      attempted_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_user_id, producer_id, proposal_id)
    )`);
  }

  enqueue(subject: ApprovalDecisionSubject): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO approval_decision_receipt_outbox_v1
      (owner_user_id, producer_id, proposal_id) VALUES (?, ?, ?)`)
      .run(subject.ownerUserId, subject.producerId, subject.canonicalProposalId);
  }

  list(limit = 100): ApprovalDecisionSubject[] {
    return this.db
      .prepare(`SELECT owner_user_id AS ownerUserId, producer_id AS producerId, proposal_id AS canonicalProposalId
      FROM approval_decision_receipt_outbox_v1
      ORDER BY attempted_at, owner_user_id, producer_id, proposal_id LIMIT ?`)
      .all(limit) as ApprovalDecisionSubject[];
  }

  attempted(subject: ApprovalDecisionSubject): void {
    this.db
      .prepare(`UPDATE approval_decision_receipt_outbox_v1 SET attempted_at = ?
      WHERE owner_user_id = ? AND producer_id = ? AND proposal_id = ?`)
      .run(Date.now(), subject.ownerUserId, subject.producerId, subject.canonicalProposalId);
  }

  remove(subject: ApprovalDecisionSubject): void {
    this.db
      .prepare(`DELETE FROM approval_decision_receipt_outbox_v1
      WHERE owner_user_id = ? AND producer_id = ? AND proposal_id = ?`)
      .run(subject.ownerUserId, subject.producerId, subject.canonicalProposalId);
  }
}
