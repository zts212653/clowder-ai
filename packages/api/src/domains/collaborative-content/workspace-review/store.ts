import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type WorkspaceContentActor,
  type WorkspaceContentReview,
  type WorkspaceContentReviewReceipt,
  workspaceContentReviewSchema,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { CollectiveWorkspaceCustody } from './collective-custody.js';
import { WorkspaceContentReviewError } from './errors.js';
import { ProjectReviewAudienceStore } from './project-message/audience-store.js';
import { VideoProjectMessageImportCursor } from './project-message/cursor.js';
import { RetainedWorkspaceLedger } from './retained-ledger.js';

interface ReviewRow {
  readonly body: string;
}

interface OperationRow {
  readonly fingerprint: string;
  readonly receipt: string;
}

interface LegacyOperationResultRow extends OperationRow {
  readonly review: string;
}

export interface WorkspaceReviewMutation {
  readonly reviewId: string;
  readonly expectedRevision: number;
  /** Original caller CAS remains stable when an audience revision is translated to canonical CAS. */
  readonly fingerprintRevision?: number;
  /** Internal derivative bookkeeping commits or rolls back with the authoritative operation. */
  readonly committed?: (result: WorkspaceReviewMutationResult) => void;
  readonly assertScopedRevision?: () => void;
  readonly operationId: string;
  readonly actor: WorkspaceContentActor;
  readonly now: string;
  readonly kind: string;
  readonly request: unknown;
  readonly preparationSource?: WorkspaceContentReviewReceipt['preparationSource'];
}

export interface WorkspaceReviewMutationResult {
  readonly review: WorkspaceContentReview;
  readonly receipt: WorkspaceContentReviewReceipt;
  readonly replayed: boolean;
}

/** Durable F309 collaboration metadata only; it never contains source bytes or F063 policy. */
export class WorkspaceContentReviewStore {
  private readonly database: Database.Database;
  private readonly ownsDatabase: boolean;
  readonly retained: RetainedWorkspaceLedger;
  readonly collectiveCustody: CollectiveWorkspaceCustody;
  readonly projectAudiences: ProjectReviewAudienceStore;
  readonly projectMessageImports: VideoProjectMessageImportCursor;

  constructor(
    path: string | Database.Database,
    private readonly assertWritable: (reviewId: string) => void = () => {},
    private readonly assertNewReview: (review: WorkspaceContentReview) => void = () => {},
  ) {
    this.ownsDatabase = typeof path === 'string';
    if (typeof path === 'string') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.database = new Database(path);
      chmodSync(path, 0o600);
    } else this.database = path;
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_content_reviews (
        review_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        content_ref TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL,
        UNIQUE(owner_user_id, content_ref)
      );
      CREATE INDEX IF NOT EXISTS workspace_content_reviews_owner
        ON workspace_content_reviews(owner_user_id, content_ref);
      CREATE TABLE IF NOT EXISTS workspace_content_review_operations (
        review_id TEXT NOT NULL REFERENCES workspace_content_reviews(review_id),
        operation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        receipt TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY(review_id, operation_id),
        UNIQUE(review_id, revision)
      );
      CREATE TABLE IF NOT EXISTS workspace_content_review_operation_results (
        review_id TEXT NOT NULL REFERENCES workspace_content_reviews(review_id),
        operation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        receipt TEXT NOT NULL,
        review TEXT NOT NULL,
        PRIMARY KEY(review_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_content_review_operation_receipts (
        review_id TEXT NOT NULL REFERENCES workspace_content_reviews(review_id),
        operation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        receipt TEXT NOT NULL,
        result_revision INTEGER NOT NULL,
        PRIMARY KEY(review_id, operation_id)
      );
    `);
    const columns = this.database.pragma('table_info(workspace_content_reviews)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'collaboration_scope'))
      this.database.exec('ALTER TABLE workspace_content_reviews ADD COLUMN collaboration_scope TEXT');
    this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS workspace_content_reviews_scope
      ON workspace_content_reviews(collaboration_scope, content_ref) WHERE collaboration_scope IS NOT NULL`);
    this.projectAudiences = new ProjectReviewAudienceStore(this.database);
    this.retained = new RetainedWorkspaceLedger(this.database);
    this.projectMessageImports = new VideoProjectMessageImportCursor(this.database);
    this.collectiveCustody = new CollectiveWorkspaceCustody(this.database);
  }

  close(): void {
    if (this.ownsDatabase && this.database.open) this.database.close();
  }

  get(reviewId: string): WorkspaceContentReview | null {
    const row = this.database.prepare('SELECT body FROM workspace_content_reviews WHERE review_id = ?').get(reviewId) as
      | ReviewRow
      | undefined;
    return row ? workspaceContentReviewSchema.parse(JSON.parse(row.body)) : null;
  }

  getByContent(ownerUserId: string, contentRef: string, scopeRef?: string): WorkspaceContentReview | null {
    const row = this.database
      .prepare(
        scopeRef
          ? 'SELECT body FROM workspace_content_reviews WHERE collaboration_scope = ? AND content_ref = ?'
          : 'SELECT body FROM workspace_content_reviews WHERE owner_user_id = ? AND content_ref = ? AND collaboration_scope IS NULL',
      )
      .get(scopeRef ?? ownerUserId, contentRef) as ReviewRow | undefined;
    return row ? workspaceContentReviewSchema.parse(JSON.parse(row.body)) : null;
  }

  create(
    review: WorkspaceContentReview,
    input: Omit<WorkspaceReviewMutation, 'reviewId' | 'expectedRevision'>,
  ): WorkspaceContentReview {
    const initial = workspaceContentReviewSchema.parse(review);
    return this.database
      .transaction(() => {
        const existing = this.getByContent(
          initial.ownerUserId,
          initial.contentRef,
          initial.collaborationScope?.scopeRef,
        );
        if (existing) {
          if (!isDeepStrictEqual(existing.collaborationScope, initial.collaborationScope))
            throw new WorkspaceContentReviewError('access_denied');
          return existing;
        }
        this.assertNewReview(initial);
        if (initial.revision !== 1) throw new WorkspaceContentReviewError('invalid_action');
        this.database
          .prepare(
            'INSERT INTO workspace_content_reviews (review_id, owner_user_id, content_ref, revision, body, collaboration_scope) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            initial.reviewId,
            initial.ownerUserId,
            initial.contentRef,
            initial.revision,
            JSON.stringify(initial),
            initial.collaborationScope?.scopeRef ?? null,
          );
        this.writeOperationReceipt({ ...input, reviewId: initial.reviewId, expectedRevision: 0 }, initial, false);
        return initial;
      })
      .immediate();
  }

  replay(input: WorkspaceReviewMutation): WorkspaceReviewMutationResult | null {
    const receiptRow = this.database
      .prepare(
        'SELECT fingerprint, receipt FROM workspace_content_review_operation_receipts WHERE review_id = ? AND operation_id = ?',
      )
      .get(input.reviewId, input.operationId) as OperationRow | undefined;
    if (receiptRow) {
      if (receiptRow.fingerprint !== fingerprint(input)) throw new WorkspaceContentReviewError('operation_reused');
      const review = this.get(input.reviewId);
      if (!review) throw new WorkspaceContentReviewError('not_found');
      return {
        review,
        receipt: { ...(JSON.parse(receiptRow.receipt) as WorkspaceContentReviewReceipt), replayed: true },
        replayed: true,
      };
    }
    // Read-only migration compatibility: older unshipped rows copied the aggregate JSON.
    const legacyResult = this.database
      .prepare(
        'SELECT fingerprint, receipt, review FROM workspace_content_review_operation_results WHERE review_id = ? AND operation_id = ?',
      )
      .get(input.reviewId, input.operationId) as LegacyOperationResultRow | undefined;
    if (legacyResult) {
      if (legacyResult.fingerprint !== fingerprint(input)) throw new WorkspaceContentReviewError('operation_reused');
      return {
        review: workspaceContentReviewSchema.parse(JSON.parse(legacyResult.review)),
        receipt: { ...(JSON.parse(legacyResult.receipt) as WorkspaceContentReviewReceipt), replayed: true },
        replayed: true,
      };
    }
    const legacy = this.database
      .prepare(
        'SELECT fingerprint, receipt FROM workspace_content_review_operations WHERE review_id = ? AND operation_id = ?',
      )
      .get(input.reviewId, input.operationId) as OperationRow | undefined;
    if (!legacy) return null;
    if (legacy.fingerprint !== fingerprint(input)) throw new WorkspaceContentReviewError('operation_reused');
    const review = this.get(input.reviewId);
    if (!review) throw new WorkspaceContentReviewError('not_found');
    const legacyReceipt = JSON.parse(legacy.receipt) as WorkspaceContentReviewReceipt;
    return { review, receipt: { ...legacyReceipt, replayed: true }, replayed: true };
  }

  operationReceipt(reviewId: string, operationId: string): WorkspaceContentReviewReceipt | null {
    // Three persisted schema generations retain their original receipt identities; none synthesizes an effect from current state.
    const row = this.database
      .prepare(`SELECT receipt FROM workspace_content_review_operation_receipts WHERE review_id=@reviewId AND operation_id=@operationId
      UNION ALL SELECT receipt FROM workspace_content_review_operation_results WHERE review_id=@reviewId AND operation_id=@operationId
      UNION ALL SELECT receipt FROM workspace_content_review_operations WHERE review_id=@reviewId AND operation_id=@operationId LIMIT 1`)
      .get({ reviewId, operationId }) as Pick<OperationRow, 'receipt'> | undefined;
    return row ? (JSON.parse(row.receipt) as WorkspaceContentReviewReceipt) : null;
  }

  recordNoop(input: WorkspaceReviewMutation): WorkspaceReviewMutationResult {
    return this.database
      .transaction(() => {
        const replay = this.replay(input);
        if (replay) return replay;
        const current = this.get(input.reviewId);
        if (!current) throw new WorkspaceContentReviewError('not_found');
        if (current.revision !== input.expectedRevision) throw new WorkspaceContentReviewError('revision_conflict');
        input.assertScopedRevision?.();
        const result = { review: current, receipt: this.writeOperationReceipt(input, current, false), replayed: false };
        input.committed?.(result);
        return result;
      })
      .immediate();
  }

  mutate(
    input: WorkspaceReviewMutation,
    transition: (current: WorkspaceContentReview) => WorkspaceContentReview,
  ): WorkspaceReviewMutationResult {
    return this.database
      .transaction(() => {
        const replay = this.replay(input);
        if (replay) return replay;
        this.assertWritable(input.reviewId);
        const current = this.get(input.reviewId);
        if (!current) throw new WorkspaceContentReviewError('not_found');
        if (current.revision !== input.expectedRevision) throw new WorkspaceContentReviewError('revision_conflict');
        input.assertScopedRevision?.();
        const next = workspaceContentReviewSchema.parse(transition(current));
        if (
          next.reviewId !== current.reviewId ||
          next.ownerUserId !== current.ownerUserId ||
          next.contentRef !== current.contentRef ||
          !isDeepStrictEqual(next.collaborationScope, current.collaborationScope) ||
          next.revision !== current.revision + 1
        ) {
          throw new WorkspaceContentReviewError('invalid_action');
        }
        const changed = this.database
          .prepare('UPDATE workspace_content_reviews SET revision = ?, body = ? WHERE review_id = ? AND revision = ?')
          .run(next.revision, JSON.stringify(next), next.reviewId, current.revision);
        if (changed.changes !== 1) throw new WorkspaceContentReviewError('revision_conflict');
        const receipt = this.writeOperationReceipt(input, next, false);
        const result = { review: next, receipt, replayed: false };
        input.committed?.(result);
        return result;
      })
      .immediate();
  }

  private writeOperationReceipt(
    input: WorkspaceReviewMutation,
    review: WorkspaceContentReview,
    replayed: boolean,
  ): WorkspaceContentReviewReceipt {
    const receipt: WorkspaceContentReviewReceipt = {
      receiptRef: `workspace-content-review:${input.reviewId}:receipt:${createHash('sha256')
        .update(input.operationId)
        .digest('hex')}`,
      reviewId: input.reviewId,
      operationId: input.operationId,
      revision: review.revision,
      actor: input.actor,
      createdAt: input.now,
      replayed,
      ...(input.preparationSource ? { preparationSource: input.preparationSource } : {}),
    };
    this.database
      .prepare(
        'INSERT INTO workspace_content_review_operation_receipts (review_id, operation_id, fingerprint, receipt, result_revision) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.reviewId, input.operationId, fingerprint(input), JSON.stringify(receipt), review.revision);
    return receipt;
  }
}

function fingerprint(input: WorkspaceReviewMutation): string {
  return createHash('sha256')
    .update(
      JSON.stringify([input.actor, input.fingerprintRevision ?? input.expectedRevision, input.kind, input.request]),
    )
    .digest('hex');
}
