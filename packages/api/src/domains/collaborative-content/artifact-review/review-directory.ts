import { type ArtifactReview, artifactReviewSchema, type WorkspaceContentReview } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewStore } from '../workspace-review/store.js';
import { projectLinkedReview } from './canonical-ledger.js';

/** Reads the existing owner rows; no secondary index of identities or writable discussion bodies. */
export class ArtifactReviewDirectory {
  constructor(
    private readonly db: Database.Database,
    private readonly ledgers: WorkspaceContentReviewStore,
  ) {
    db.exec('CREATE INDEX IF NOT EXISTS artifact_reviews_content ON artifact_reviews(owner_user_id,content_ref)');
  }
  forOwner(ownerUserId: string): ArtifactReview[] {
    return this.parse(
      this.db.prepare('SELECT body FROM artifact_reviews WHERE owner_user_id=? ORDER BY review_id').all(ownerUserId),
    );
  }
  ids(ownerUserId?: string): string[] {
    const rows = (
      ownerUserId === undefined
        ? this.db.prepare('SELECT review_id FROM artifact_reviews ORDER BY review_id').all()
        : this.db
            .prepare('SELECT review_id FROM artifact_reviews WHERE owner_user_id=? ORDER BY review_id')
            .all(ownerUserId)
    ) as { review_id: string }[];
    return rows.map((row) => row.review_id);
  }
  forTask(ownerUserId: string, taskId: string): ArtifactReview[] {
    return this.parse(
      this.db
        .prepare('SELECT body FROM artifact_reviews WHERE owner_user_id=? AND task_id=? ORDER BY review_id')
        .all(ownerUserId, taskId),
    );
  }
  forPublication(ownerUserId: string, contentRef: string): ArtifactReview[] {
    return this.parse(
      this.db
        .prepare('SELECT body FROM artifact_reviews WHERE owner_user_id=? AND content_ref=? ORDER BY review_id')
        .all(ownerUserId, contentRef),
    );
  }
  assertNewLedger(review: WorkspaceContentReview): void {
    if (review.source.kind !== 'publication') return;
    const publication = review.source.publication;
    if (
      this.forPublication(review.ownerUserId, publication.contentRef).some((item) => {
        const round = item.rounds.find((round) => round.asset.ownerRevision === publication.ownerRevision);
        return round ? !round.ledgerRef : !item.rounds.at(-1)?.ledgerRef;
      })
    )
      throw new WorkspaceContentReviewError('existing_contexts');
  }
  private parse(rows: unknown[]): ArtifactReview[] {
    return (rows as { body: string }[]).map((row) =>
      projectLinkedReview(artifactReviewSchema.parse(JSON.parse(row.body)), this.ledgers),
    );
  }
}
