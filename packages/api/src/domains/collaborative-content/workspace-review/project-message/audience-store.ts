import { createHash } from 'node:crypto';
import type { WorkspaceContentReview, WorkspaceContentReviewReceipt } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { WorkspaceContentReviewError } from '../errors.js';
import { ProjectAudienceConflict } from './audience.js';

interface ProjectionRow {
  revision: number;
  digest: string;
  updated_at: string;
}
/** A derived CAS index inside the canonical F309 DB. It retains no second review or source payload. */
export class ProjectReviewAudienceStore {
  constructor(private readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_project_review_audiences (
        review_id TEXT NOT NULL REFERENCES workspace_content_reviews(review_id),
        audience TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(review_id, audience)
      );
      CREATE TABLE IF NOT EXISTS workspace_project_review_audience_receipts (
        review_id TEXT NOT NULL REFERENCES workspace_content_reviews(review_id),
        audience TEXT NOT NULL, operation_id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(review_id, audience, operation_id)
      );
    `);
  }

  observe(canonical: WorkspaceContentReview, visible: WorkspaceContentReview, audience: string) {
    return this.database
      .transaction(() => {
        const current = this.database
          .prepare('SELECT revision FROM workspace_content_reviews WHERE review_id=?')
          .get(canonical.reviewId) as { revision: number } | undefined;
        // An old async visibility read must never roll the audience index back past a newer ledger write.
        if (current?.revision !== canonical.revision) throw new WorkspaceContentReviewError('revision_conflict');
        const digest = createHash('sha256')
          .update(JSON.stringify({ ...visible, revision: 0 }))
          .digest('hex');
        const row = this.database
          .prepare(
            'SELECT revision,digest,updated_at FROM workspace_project_review_audiences WHERE review_id=? AND audience=?',
          )
          .get(canonical.reviewId, audience) as ProjectionRow | undefined;
        const revision = row ? row.revision + Number(row.digest !== digest) : 1;
        const updatedAt = visible.updatedAt;
        this.database
          .prepare(`INSERT INTO workspace_project_review_audiences (review_id,audience,revision,digest,updated_at)
        VALUES (?,?,?,?,?) ON CONFLICT(review_id,audience) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,updated_at=excluded.updated_at`)
          .run(canonical.reviewId, audience, revision, digest, updatedAt);
        return { ...visible, revision, updatedAt };
      })
      .immediate();
  }

  assertRevision(reviewId: string, audience: string, revision: number) {
    const row = this.database
      .prepare('SELECT revision FROM workspace_project_review_audiences WHERE review_id=? AND audience=?')
      .get(reviewId, audience) as { revision: number } | undefined;
    if (row?.revision !== revision) throw new ProjectAudienceConflict();
  }

  hasReceipt(receipt: WorkspaceContentReviewReceipt, audience: string): boolean {
    return Boolean(
      this.database
        .prepare(
          'SELECT 1 FROM workspace_project_review_audience_receipts WHERE review_id=? AND audience=? AND operation_id=?',
        )
        .get(receipt.reviewId, audience, receipt.operationId),
    );
  }

  receipt(receipt: WorkspaceContentReviewReceipt, audience: string, revision: number): WorkspaceContentReviewReceipt {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO workspace_project_review_audience_receipts (review_id,audience,operation_id,revision) VALUES (?,?,?,?)`,
      )
      .run(receipt.reviewId, audience, receipt.operationId, revision);
    const row = this.database
      .prepare(
        'SELECT revision FROM workspace_project_review_audience_receipts WHERE review_id=? AND audience=? AND operation_id=?',
      )
      .get(receipt.reviewId, audience, receipt.operationId) as { revision: number };
    return { ...receipt, revision: row.revision };
  }
}
