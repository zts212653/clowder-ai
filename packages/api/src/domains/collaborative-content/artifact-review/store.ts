import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ArtifactReview,
  type ArtifactReviewActor,
  type ArtifactReviewAuditActor,
  type ArtifactReviewAuditEntry,
  type ArtifactReviewReceipt,
  artifactReviewSchema,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { ArtifactReviewError } from './errors.js';
import { ArtifactReviewReturnStore, type ReviewReturnTarget } from './return-store.js';
import {
  assertReservation,
  assertReviewSuccessor,
  assertSameReservation,
  auditPredecessor,
  fingerprint,
  receiptReference,
} from './store-support.js';

interface ReviewRow {
  body: string;
}
interface OperationRow {
  fingerprint: string;
  receipt: string;
  round: number;
  kind: string;
  detail: string;
}
export interface ReviewMutation {
  reviewId: string;
  expectedRevision: number;
  operationId: string;
  actor: ArtifactReviewAuditActor;
  now: string;
  round: number;
  kind: string;
  request: unknown;
  returnTarget?: ReviewReturnTarget;
}
export interface ReviewMutationResult {
  review: ArtifactReview;
  receipt: ArtifactReviewReceipt;
  replayed: boolean;
}
export interface PendingReviewVersion {
  input: ReviewMutation;
  payload: unknown;
}

/** One permanent owner database; atomic CAS + audit + intent receipt, with no TTL or shadow work state. */
export class ArtifactReviewStore {
  private readonly database: Database.Database;
  readonly returns: ArtifactReviewReturnStore;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    chmodSync(path, 0o600);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS artifact_reviews (
        review_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, task_id TEXT NOT NULL,
        content_ref TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
        UNIQUE(owner_user_id, task_id, content_ref)
      );
      CREATE INDEX IF NOT EXISTS artifact_reviews_owner ON artifact_reviews(owner_user_id);
      CREATE TABLE IF NOT EXISTS artifact_review_operations (
        review_id TEXT NOT NULL REFERENCES artifact_reviews(review_id), operation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, receipt TEXT NOT NULL,
        round INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
        PRIMARY KEY(review_id, operation_id), UNIQUE(review_id, revision)
      );
      CREATE TABLE IF NOT EXISTS artifact_review_pending_versions (
        review_id TEXT PRIMARY KEY REFERENCES artifact_reviews(review_id), body TEXT NOT NULL
      );
    `);
    this.returns = new ArtifactReviewReturnStore(this.database);
  }

  close(): void {
    this.database.close();
  }

  get(reviewId: string): ArtifactReview | null {
    const row = this.database.prepare('SELECT body FROM artifact_reviews WHERE review_id = ?').get(reviewId) as
      | ReviewRow
      | undefined;
    return row ? artifactReviewSchema.parse(JSON.parse(row.body)) : null;
  }

  listForOwner(ownerUserId: string): ArtifactReview[] {
    const rows = this.database
      .prepare('SELECT body FROM artifact_reviews WHERE owner_user_id = ? ORDER BY review_id')
      .all(ownerUserId) as ReviewRow[];
    return rows.map((row) => artifactReviewSchema.parse(JSON.parse(row.body)));
  }

  /** Uses the existing owner/task/content unique index; unrelated review bodies are never loaded. */
  listForTask(ownerUserId: string, taskId: string): ArtifactReview[] {
    const rows = this.database
      .prepare('SELECT body FROM artifact_reviews WHERE owner_user_id = ? AND task_id = ? ORDER BY review_id')
      .all(ownerUserId, taskId) as ReviewRow[];
    return rows.map((row) => artifactReviewSchema.parse(JSON.parse(row.body)));
  }

  listReviewIds(ownerUserId?: string): string[] {
    const rows = (
      ownerUserId === undefined
        ? this.database.prepare('SELECT review_id FROM artifact_reviews ORDER BY review_id').all()
        : this.database
            .prepare('SELECT review_id FROM artifact_reviews WHERE owner_user_id = ? ORDER BY review_id')
            .all(ownerUserId)
    ) as { review_id: string }[];
    return rows.map((row) => row.review_id);
  }

  create(
    candidate: ArtifactReview,
    context: { operationId: string; actor: ArtifactReviewActor; now: string },
  ): ArtifactReview {
    const initial = artifactReviewSchema.parse(candidate);
    return this.database
      .transaction(() => {
        const existing = this.get(initial.reviewId);
        if (existing) {
          if (
            existing.contentRef !== initial.contentRef ||
            existing.task.taskId !== initial.task.taskId ||
            existing.task.ownerUserId !== initial.task.ownerUserId ||
            existing.task.threadId !== initial.task.threadId
          ) {
            throw new ArtifactReviewError('operation_reused');
          }
          return existing;
        }
        if (initial.revision !== 1) throw new ArtifactReviewError('invalid_action');
        this.database
          .prepare(
            'INSERT INTO artifact_reviews (review_id, owner_user_id, task_id, content_ref, revision, body) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            initial.reviewId,
            initial.task.ownerUserId,
            initial.task.taskId,
            initial.contentRef,
            1,
            JSON.stringify(initial),
          );
        this.writeOperation(
          {
            reviewId: initial.reviewId,
            expectedRevision: 0,
            operationId: context.operationId,
            actor: context.actor,
            now: context.now,
            round: 1,
            kind: 'prepare',
            request: { contentRef: initial.contentRef, asset: initial.rounds[0]?.asset },
          },
          1,
        );
        return initial;
      })
      .immediate();
  }

  /** A lookup never skips authorization: the service authorizes before requesting or returning a replay. */
  replay(input: ReviewMutation): ReviewMutationResult | null {
    const row = this.operation(input.reviewId, input.operationId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint(input)) throw new ArtifactReviewError('operation_reused');
    const review = this.get(input.reviewId);
    if (!review) throw new ArtifactReviewError('not_found');
    return { review, receipt: JSON.parse(row.receipt) as ArtifactReviewReceipt, replayed: true };
  }

  mutate(
    input: ReviewMutation,
    transition: (review: ArtifactReview, receiptRef: string) => ArtifactReview,
  ): ReviewMutationResult {
    return this.commitMutation(input, transition, false, 'applied');
  }

  pendingVersion(reviewId: string): PendingReviewVersion | null {
    const row = this.database
      .prepare('SELECT body FROM artifact_review_pending_versions WHERE review_id = ?')
      .get(reviewId) as ReviewRow | undefined;
    return row ? (JSON.parse(row.body) as PendingReviewVersion) : null;
  }

  reserveVersion(input: ReviewMutation, payload: unknown): void {
    this.database
      .transaction(() => {
        if (this.replay(input)) return;
        const current = this.get(input.reviewId);
        if (!current) throw new ArtifactReviewError('not_found');
        if (current.revision !== input.expectedRevision) throw new ArtifactReviewError('revision_conflict');
        const pending = this.pendingVersion(input.reviewId);
        if (pending) {
          assertSameReservation(pending, input);
          return;
        }
        const body = JSON.stringify({ input, payload });
        if (Buffer.byteLength(body) > 5 * 1024 * 1024) throw new ArtifactReviewError('limit_reached');
        this.database
          .prepare('INSERT INTO artifact_review_pending_versions (review_id, body) VALUES (?, ?)')
          .run(input.reviewId, body);
      })
      .immediate();
  }

  finishVersion(
    input: ReviewMutation,
    transition: (review: ArtifactReview, receiptRef: string) => ArtifactReview,
  ): ReviewMutationResult {
    return this.commitMutation(input, transition, true, 'applied');
  }

  abortVersion(input: ReviewMutation): ReviewMutationResult {
    return this.commitMutation(
      input,
      (review) => ({ ...review, revision: review.revision + 1, updatedAt: input.now }),
      true,
      'aborted',
    );
  }

  private commitMutation(
    input: ReviewMutation,
    transition: (review: ArtifactReview, receiptRef: string) => ArtifactReview,
    finishPending: boolean,
    outcome: ArtifactReviewReceipt['outcome'],
  ): ReviewMutationResult {
    return this.database
      .transaction(() => {
        const replay = this.replay(input);
        if (replay) return replay;
        const pending = this.pendingVersion(input.reviewId);
        assertReservation(pending, input, finishPending);
        const current = this.get(input.reviewId);
        if (!current) throw new ArtifactReviewError('not_found');
        if (current.revision !== input.expectedRevision) throw new ArtifactReviewError('revision_conflict');
        const receiptRef = receiptReference(input.reviewId, input.operationId);
        const next = artifactReviewSchema.parse(transition(current, receiptRef));
        assertReviewSuccessor(current, next);
        const body = JSON.stringify(next);
        if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new ArtifactReviewError('limit_reached');
        const changed = this.database
          .prepare('UPDATE artifact_reviews SET revision = ?, body = ? WHERE review_id = ? AND revision = ?')
          .run(next.revision, body, next.reviewId, current.revision);
        if (changed.changes !== 1) throw new ArtifactReviewError('revision_conflict');
        const receipt = this.writeOperation(input, next.revision, auditPredecessor(current, input), outcome);
        this.returns.record(next, receipt, input);
        if (finishPending)
          this.database.prepare('DELETE FROM artifact_review_pending_versions WHERE review_id = ?').run(input.reviewId);
        return { review: next, receipt, replayed: false };
      })
      .immediate();
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

  private operation(reviewId: string, operationId: string): OperationRow | undefined {
    return this.database
      .prepare(
        'SELECT fingerprint, receipt, round, kind, detail FROM artifact_review_operations WHERE review_id = ? AND operation_id = ?',
      )
      .get(reviewId, operationId) as OperationRow | undefined;
  }

  private writeOperation(
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
