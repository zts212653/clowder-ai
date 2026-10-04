import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ArtifactReview,
  type ArtifactReviewActor,
  type ArtifactReviewAuditEntry,
  type ArtifactReviewReceipt,
  artifactReviewSchema,
  respondWithMediaVersionSchema,
  type WorkspaceContentReview,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { ContentAcceptanceStore } from '../modification/acceptance-store.js';
import { ContentModificationJournal } from '../modification/journal.js';
import { ModificationTextStore } from '../modification/text/text-store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import {
  WorkspaceContentReviewStore,
  type WorkspaceReviewMutation,
  type WorkspaceReviewMutationResult,
} from '../workspace-review/store.js';
import { ArtifactReviewAuditStore } from './audit-store.js';
import {
  bindExistingPublicationLedgers,
  ensureRoundLedgers,
  projectLinkedReview,
  serializeLinkedReview,
} from './canonical-ledger.js';
import { ArtifactReviewError } from './errors.js';
import { assertModificationResponseReference } from './modification-request-reference.js';
import { ArtifactReviewReturnStore } from './return-store.js';
import type { PendingReviewVersion, ReviewMutation, ReviewMutationResult } from './store-contract.js';

export type { PendingReviewVersion, ReviewMutation, ReviewMutationResult } from './store-contract.js';

import { ArtifactReviewDirectory } from './review-directory.js';
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

/** One permanent owner database; atomic CAS + audit + intent receipt, with no TTL or shadow work state. */
export class ArtifactReviewStore {
  reviewReceipt(reviewId: string, receiptRef: string): ArtifactReviewReceipt | null {
    return this.audit.receiptByRef(reviewId, receiptRef);
  }
  private readonly database: Database.Database;
  private readonly audit: ArtifactReviewAuditStore;
  readonly returns: ArtifactReviewReturnStore;
  readonly ledgers: WorkspaceContentReviewStore;
  readonly directory: ArtifactReviewDirectory;
  readonly requests: ContentModificationJournal;
  readonly text: ModificationTextStore;
  readonly acceptances: ContentAcceptanceStore;

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
    this.audit = new ArtifactReviewAuditStore(this.database);
    this.returns = new ArtifactReviewReturnStore(this.database);
    this.ledgers = new WorkspaceContentReviewStore(
      this.database,
      (reviewId) => this.assertLedgerWritable(reviewId),
      (review) => this.directory.assertNewLedger(review),
    );
    this.directory = new ArtifactReviewDirectory(this.database, this.ledgers);
    this.requests = new ContentModificationJournal(this.database);
    this.text = new ModificationTextStore(this.database);
    this.acceptances = new ContentAcceptanceStore(this.database);
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  get(reviewId: string): ArtifactReview | null {
    const row = this.database.prepare('SELECT body FROM artifact_reviews WHERE review_id = ?').get(reviewId) as
      | ReviewRow
      | undefined;
    return row ? projectLinkedReview(artifactReviewSchema.parse(JSON.parse(row.body)), this.ledgers) : null;
  }

  listForOwner(ownerUserId: string): ArtifactReview[] {
    return this.directory.forOwner(ownerUserId);
  }

  /** Uses the existing owner/task/content unique index; unrelated review bodies are never loaded. */
  listForTask(ownerUserId: string, taskId: string): ArtifactReview[] {
    return this.directory.forTask(ownerUserId, taskId);
  }

  listReviewIds(ownerUserId?: string): string[] {
    return this.directory.ids(ownerUserId);
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
        const canonical = bindExistingPublicationLedgers(initial, this.ledgers);
        ensureRoundLedgers(this.ledgers, canonical, context.actor);
        const projected = projectLinkedReview(canonical, this.ledgers);
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
            serializeLinkedReview(projected, this.ledgers),
          );
        this.audit.writeOperation(
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
        return projected;
      })
      .immediate();
  }

  /** A lookup never skips authorization: the service authorizes before requesting or returning a replay. */
  replay(input: ReviewMutation): ReviewMutationResult | null {
    const row = this.audit.operation(input.reviewId, input.operationId);
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

  /** The ledger and return receipt share one connection; nested mutations use SQLite savepoints. */
  mutateWithLedger(
    input: ReviewMutation,
    ledgerInput: WorkspaceReviewMutation,
    transition: {
      ledger: (ledger: WorkspaceContentReview) => WorkspaceContentReview;
      review: (review: ArtifactReview, receiptRef: string) => ArtifactReview;
    },
  ): { review: ReviewMutationResult; ledger: WorkspaceReviewMutationResult } {
    if (
      input.operationId !== ledgerInput.operationId ||
      input.actor.kind !== ledgerInput.actor.kind ||
      input.actor.actorId !== ledgerInput.actor.actorId
    )
      throw new ArtifactReviewError('operation_reused');
    return this.database
      .transaction(() => {
        const priorReview = this.replay(input);
        const priorLedger = this.ledgers.replay(ledgerInput);
        if (priorReview || priorLedger) {
          if (!priorReview || !priorLedger) throw new ArtifactReviewError('operation_reused');
          return { review: priorReview, ledger: priorLedger };
        }
        const before = this.get(input.reviewId);
        if (!before) throw new ArtifactReviewError('not_found');
        const predecessor = () => auditPredecessor(before, input);
        const ledger = this.ledgers.mutate(ledgerInput, transition.ledger);
        const review = this.commitMutation(input, transition.review, false, 'applied', predecessor);
        return { review, ledger };
      })
      .immediate();
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
        const requestId =
          payload !== null && typeof payload === 'object' && 'requestId' in payload ? payload.requestId : undefined;
        assertModificationResponseReference(this, current, { requestId }, input.actor);
        if (current.revision !== input.expectedRevision) throw new ArtifactReviewError('revision_conflict');
        const pending = this.pendingVersion(input.reviewId);
        if (pending) {
          assertSameReservation(pending, input);
          return;
        }
        const round = current.rounds.at(-1);
        if (round?.ledgerRef) {
          this.assertLedgerWritable(round.ledgerRef);
          const command = respondWithMediaVersionSchema.parse(payload);
          if (command.expectedLedgerRevision !== round.ledgerRevision)
            throw new ArtifactReviewError('revision_conflict');
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
    predecessor: (review: ArtifactReview) => unknown = (review) => auditPredecessor(review, input),
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
        let next = artifactReviewSchema.parse(transition(current, receiptRef));
        assertReviewSuccessor(current, next);
        if (finishPending) {
          ensureRoundLedgers(this.ledgers, next, input.actor);
          next = projectLinkedReview(next, this.ledgers);
        }
        const body = serializeLinkedReview(next, this.ledgers);
        if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new ArtifactReviewError('limit_reached');
        const changed = this.database
          .prepare('UPDATE artifact_reviews SET revision = ?, body = ? WHERE review_id = ? AND revision = ?')
          .run(next.revision, body, next.reviewId, current.revision);
        if (changed.changes !== 1) throw new ArtifactReviewError('revision_conflict');
        const receipt = this.audit.writeOperation(input, next.revision, predecessor(current), outcome);
        this.returns.record(next, receipt, input);
        if (finishPending)
          this.database.prepare('DELETE FROM artifact_review_pending_versions WHERE review_id = ?').run(input.reviewId);
        return { review: next, receipt, replayed: false };
      })
      .immediate();
  }

  history(reviewId: string, afterRevision = 0, limit = 100): ArtifactReviewAuditEntry[] {
    return this.audit.history(reviewId, afterRevision, limit);
  }

  private assertLedgerWritable(ledgerRef: string): void {
    const pending = this.database
      .prepare(`
      SELECT 1 FROM artifact_review_pending_versions AS pending
      JOIN artifact_reviews AS review ON review.review_id = pending.review_id,
      json_each(review.body, '$.rounds') AS round
      WHERE json_extract(round.value, '$.ledgerRef') = ? LIMIT 1
    `)
      .get(ledgerRef);
    if (pending) throw new WorkspaceContentReviewError('version_pending');
  }
}
