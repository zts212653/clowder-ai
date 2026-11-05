import type { CollectiveMediaShareScope, WorkspaceContentReview } from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewStore } from '../workspace-review/store.js';
import { appendWorkspaceSourceHistory } from '../workspace-review/workspace-review-mutations.js';
import { prepareCanonicalWorkspaceReview } from '../workspace-review/workspace-review-preparation.js';
import {
  collectiveMediaBinding,
  collectiveMediaSource,
  mediaShareOperation,
  type SharedPublishedMediaAsset,
  sameMediaBinding,
} from './media-source.js';

export class CollectiveMediaReviews {
  constructor(
    readonly store: WorkspaceContentReviewStore,
    readonly ownerUserId: string,
  ) {}
  bind(scope: CollectiveMediaShareScope, asset: SharedPublishedMediaAsset) {
    const binding = collectiveMediaBinding(scope, asset.contentRef);
    const source = collectiveMediaSource(asset);
    const review = prepareCanonicalWorkspaceReview(
      this.store,
      { contentRef: binding.ledgerRef, source },
      {
        principal: { userId: this.ownerUserId, actor: { kind: 'human', actorId: this.ownerUserId } },
        collaborationScope: binding.scope,
        operationId: mediaShareOperation(source),
        request: source,
      },
      new Date().toISOString(),
    );
    if (!sameMediaBinding(review, scope, asset.contentRef)) throw new WorkspaceContentReviewError('access_denied');
    // A durable share receipt lives in the original ledger. No ACL table, copy of bytes, or new owner version.
    this.store.recordNoop({
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      fingerprintRevision: 0,
      operationId: mediaShareOperation(source),
      actor: { kind: 'human', actorId: this.ownerUserId },
      now: new Date().toISOString(),
      kind: 'prepare',
      request: source,
    });
    return review;
  }
  require(scope: CollectiveMediaShareScope, asset: SharedPublishedMediaAsset) {
    const review = this.find(scope, asset.contentRef);
    if (!this.store.operationReceipt(review.reviewId, mediaShareOperation(collectiveMediaSource(asset))))
      throw new WorkspaceContentReviewError('access_denied');
    return review;
  }
  find(scope: CollectiveMediaShareScope, contentRef: string) {
    const binding = collectiveMediaBinding(scope, contentRef);
    const review = this.store.getByContent(this.ownerUserId, binding.ledgerRef, binding.scope.scopeRef);
    if (!review || !sameMediaBinding(review, scope, contentRef)) throw new WorkspaceContentReviewError('access_denied');
    return review;
  }
  advance(review: WorkspaceContentReview, asset: SharedPublishedMediaAsset) {
    if (review.source.kind !== 'collective-media') throw new WorkspaceContentReviewError('access_denied');
    if (review.source.ownerRevision >= asset.ownerRevision) return review;
    const source = collectiveMediaSource(asset),
      now = new Date().toISOString();
    return this.store.mutate(
      {
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        operationId: `public-media-version:${asset.ownerRevision}:${asset.blobDigest}`,
        actor: { kind: 'human', actorId: this.ownerUserId },
        now,
        kind: 'collective-media:version',
        request: source,
      },
      (current) => ({
        ...current,
        source,
        sourceHistory: appendWorkspaceSourceHistory(current, source),
        revision: current.revision + 1,
        updatedAt: now,
      }),
    ).review;
  }
}
