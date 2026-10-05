import { type WorkspaceContentReview, workspaceContentReviewSchema } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { WorkspaceContentReviewError } from './errors.js';

/** Read-only evidence for an explicit source snapshot. Reopens and ordinary reads never copy the aggregate. */
export class RetainedWorkspaceLedger {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_content_review_snapshots(
      review_id TEXT NOT NULL REFERENCES workspace_content_reviews(review_id), revision INTEGER NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(review_id,revision))`);
  }

  get(reviewId: string, revision: number): WorkspaceContentReview | null {
    const row = this.db
      .prepare('SELECT body FROM workspace_content_review_snapshots WHERE review_id=? AND revision=?')
      .get(reviewId, revision) as { body: string } | undefined;
    return row ? workspaceContentReviewSchema.parse(JSON.parse(row.body)) : null;
  }

  retain(reviewId: string, revision: number): WorkspaceContentReview {
    return this.db
      .transaction(() => {
        const existing = this.get(reviewId, revision);
        if (existing) return existing;
        const row = this.db
          .prepare('SELECT body FROM workspace_content_reviews WHERE review_id=? AND revision=?')
          .get(reviewId, revision) as { body: string } | undefined;
        if (!row) throw new WorkspaceContentReviewError('revision_conflict');
        const review = workspaceContentReviewSchema.parse(JSON.parse(row.body));
        this.db
          .prepare('INSERT INTO workspace_content_review_snapshots(review_id,revision,body) VALUES(?,?,?)')
          .run(reviewId, revision, row.body);
        return review;
      })
      .immediate();
  }
}
