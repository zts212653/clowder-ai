import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ProactiveCandidateNudgeReceipt {
  ownerScopeHash: string;
  subjectHash: string;
  state: 'claimed' | 'delivered';
  claimId: string;
  leaseUntil: number | null;
  deliveredAt: number | null;
  windowEndsAt: number;
}

export interface ClaimProactiveCandidateNudgeInput {
  ownerUserId: string;
  normalizedSubject: string;
  now: number;
  leaseMs: number;
  windowEndsAt: number;
}

export type ClaimProactiveCandidateNudgeResult =
  | { outcome: 'claimed'; receipt: ProactiveCandidateNudgeReceipt }
  | { outcome: 'suppressed'; reason: 'active_claim' | 'delivered'; receipt: ProactiveCandidateNudgeReceipt };

interface ReceiptRow {
  owner_scope_hash: string;
  subject_hash: string;
  state: 'claimed' | 'delivered';
  claim_id: string;
  lease_until: number | null;
  delivered_at: number | null;
  window_ends_at: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function receiptKey(
  ownerUserId: string,
  normalizedSubject: string,
): {
  ownerScopeHash: string;
  subjectHash: string;
} {
  const ownerScopeHash = digest(`F282:owner\u0000${ownerUserId}`);
  return {
    ownerScopeHash,
    subjectHash: digest(`F282:subject\u0000${ownerScopeHash}\u0000${normalizedSubject}`),
  };
}

function toReceipt(row: ReceiptRow): ProactiveCandidateNudgeReceipt {
  return {
    ownerScopeHash: row.owner_scope_hash,
    subjectHash: row.subject_hash,
    state: row.state,
    claimId: row.claim_id,
    leaseUntil: row.lease_until,
    deliveredAt: row.delivered_at,
    windowEndsAt: row.window_ends_at,
  };
}

export class ProactiveCandidateNudgeReceiptStore {
  private readonly claimTransaction: (input: ClaimProactiveCandidateNudgeInput) => ClaimProactiveCandidateNudgeResult;

  constructor(private readonly db: Database.Database) {
    this.ensureTable();
    this.claimTransaction = this.db.transaction((input: ClaimProactiveCandidateNudgeInput) =>
      this.claimInsideTransaction(input),
    );
  }

  claim(input: ClaimProactiveCandidateNudgeInput): ClaimProactiveCandidateNudgeResult {
    if (input.leaseMs <= 0 || input.windowEndsAt <= input.now) {
      throw new Error('invalid proactive memory receipt window');
    }
    return this.claimTransaction(input);
  }

  finalize(input: { claimId: string; deliveredAt: number }): boolean {
    const result = this.db
      .prepare(
        `UPDATE proactive_memory_nudge_receipts
         SET state = 'delivered', lease_until = NULL, delivered_at = ?
         WHERE claim_id = ? AND state = 'claimed'`,
      )
      .run(input.deliveredAt, input.claimId);
    return result.changes === 1;
  }

  read(input: { ownerUserId: string; normalizedSubject: string }): ProactiveCandidateNudgeReceipt | null {
    const key = receiptKey(input.ownerUserId, input.normalizedSubject);
    const row = this.db
      .prepare(
        `SELECT *
         FROM proactive_memory_nudge_receipts
         WHERE owner_scope_hash = ? AND subject_hash = ?`,
      )
      .get(key.ownerScopeHash, key.subjectHash) as ReceiptRow | undefined;
    return row ? toReceipt(row) : null;
  }

  private claimInsideTransaction(input: ClaimProactiveCandidateNudgeInput): ClaimProactiveCandidateNudgeResult {
    const key = receiptKey(input.ownerUserId, input.normalizedSubject);
    const current = this.db
      .prepare(
        `SELECT *
         FROM proactive_memory_nudge_receipts
         WHERE owner_scope_hash = ? AND subject_hash = ?`,
      )
      .get(key.ownerScopeHash, key.subjectHash) as ReceiptRow | undefined;

    if (current?.state === 'delivered' && current.window_ends_at > input.now) {
      return { outcome: 'suppressed', reason: 'delivered', receipt: toReceipt(current) };
    }
    if (current?.state === 'claimed' && (current.lease_until ?? 0) > input.now) {
      return { outcome: 'suppressed', reason: 'active_claim', receipt: toReceipt(current) };
    }

    const receipt: ProactiveCandidateNudgeReceipt = {
      ...key,
      state: 'claimed',
      claimId: randomUUID(),
      leaseUntil: input.now + input.leaseMs,
      deliveredAt: null,
      windowEndsAt: input.windowEndsAt,
    };
    this.db
      .prepare(
        `INSERT INTO proactive_memory_nudge_receipts
          (owner_scope_hash, subject_hash, state, claim_id, lease_until, delivered_at, window_ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_scope_hash, subject_hash) DO UPDATE SET
           state = excluded.state,
           claim_id = excluded.claim_id,
           lease_until = excluded.lease_until,
           delivered_at = excluded.delivered_at,
           window_ends_at = excluded.window_ends_at`,
      )
      .run(
        receipt.ownerScopeHash,
        receipt.subjectHash,
        receipt.state,
        receipt.claimId,
        receipt.leaseUntil,
        receipt.deliveredAt,
        receipt.windowEndsAt,
      );
    return { outcome: 'claimed', receipt };
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_memory_nudge_receipts (
        owner_scope_hash TEXT NOT NULL,
        subject_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'delivered')),
        claim_id TEXT NOT NULL UNIQUE,
        lease_until INTEGER,
        delivered_at INTEGER,
        window_ends_at INTEGER NOT NULL,
        PRIMARY KEY (owner_scope_hash, subject_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_memory_nudge_receipt_expiry
        ON proactive_memory_nudge_receipts(window_ends_at);
    `);
  }
}
