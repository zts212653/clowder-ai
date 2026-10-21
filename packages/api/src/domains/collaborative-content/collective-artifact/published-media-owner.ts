import { type CollectiveMediaShareScope, collectiveMediaShareScopeSchema } from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewStore } from '../workspace-review/store.js';
import { admitCollectiveMedia, mediaConstraintScope } from './media-authority.js';
import { actOnCollectiveMediaReview } from './media-review-actions.js';
import { CollectiveMediaReviews } from './media-reviews.js';
import { type SharedPublishedMediaAsset, sharedMediaAsset } from './media-source.js';
import { collectiveMediaView } from './media-view.js';
import type { CollectiveArtifactOwnerPort, CollectiveArtifactOwnerResult } from './owner-port.js';
import { mediaOwnerError, publishedMediaReadPort } from './published-media-read.js';
import { CollectiveArtifactScopeQueue } from './scope-serial-queue.js';

export type { CollectiveMediaShareScope } from '@cat-cafe/shared';

/** Adapter boundary: retained F138 content, original F309 metadata, and Service-issued member constraints. */
export class CollectivePublishedMediaOwner implements CollectiveArtifactOwnerPort {
  private readonly reviews: CollectiveMediaReviews;
  private readonly queue = new CollectiveArtifactScopeQueue();
  readonly media: ReturnType<typeof publishedMediaReadPort>;
  constructor(
    readonly deps: { media: PublishedMediaService; reviews: WorkspaceContentReviewStore; ownerUserId: string },
  ) {
    this.reviews = new CollectiveMediaReviews(deps.reviews, deps.ownerUserId);
    this.media = publishedMediaReadPort(deps, this.reviews);
  }
  async listRetained(userId: string, after?: string, authorizeEffect?: () => Promise<void>) {
    if (userId !== this.deps.ownerUserId) throw new WorkspaceContentReviewError('access_denied');
    await authorizeEffect?.();
    const result = await this.deps.media.listRetained({ userId, actor: { kind: 'human', actorId: userId } }, after);
    await authorizeEffect?.();
    return result;
  }
  async prepareShare(input: {
    contentRef: string;
    ownerRevision: number;
    scope: CollectiveMediaShareScope;
    principal: MediaReviewPrincipal;
    authorizeEffect?: () => Promise<void>;
  }): Promise<SharedPublishedMediaAsset> {
    if (
      input.principal.userId !== this.deps.ownerUserId ||
      input.principal.actor.kind !== 'human' ||
      input.principal.actor.actorId !== input.principal.userId
    )
      throw new WorkspaceContentReviewError('access_denied');
    const scope = collectiveMediaShareScopeSchema.parse(input.scope);
    return this.queue.run(input.contentRef, async () => {
      await input.authorizeEffect?.();
      const asset = sharedMediaAsset(
        await this.deps.media.read(input.contentRef, input.ownerRevision, input.principal),
      );
      await input.authorizeEffect?.();
      this.reviews.bind(scope, asset);
      await input.authorizeEffect?.();
      return asset;
    });
  }
  async execute(
    operation: Parameters<CollectiveArtifactOwnerPort['execute']>[0],
    authority: Parameters<CollectiveArtifactOwnerPort['execute']>[1],
  ): Promise<CollectiveArtifactOwnerResult> {
    return this.queue.run(operation.constraint.contentRef, async () => {
      try {
        const admitted = await admitCollectiveMedia(this.deps, this.reviews, operation, authority);
        if (admitted.constraint.action === 'annotate') {
          const value = await actOnCollectiveMediaReview(admitted, operation.payload, this.reviews);
          await admitted.authorize();
          return { status: 'ok', ownerDecisionRef: `retained-media:${admitted.operationId}`, value };
        }
        if (!['read', 'history'].includes(admitted.constraint.action))
          return { status: 'error', error: { code: 'unsupported_operation' } };
        let review = this.reviews.require(mediaConstraintScope(admitted.constraint), admitted.asset);
        await admitted.authorize();
        if (admitted.constraint.catalogueOwnerRevision === admitted.asset.ownerRevision)
          review = this.reviews.advance(review, admitted.asset);
        const value = collectiveMediaView(admitted, review, operation.payload);
        await admitted.authorize();
        return { status: 'ok', ownerDecisionRef: `retained-media:${admitted.operationId}`, value };
      } catch (error) {
        return mediaOwnerError(error);
      }
    });
  }
}
