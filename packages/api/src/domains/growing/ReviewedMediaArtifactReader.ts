import type { ArtifactReview } from '@cat-cafe/shared';
import { type ArtifactReviewService, reviewRetainsArtifact } from '../collaborative-content/artifact-review/service.js';
import type { ArtifactReviewStore } from '../collaborative-content/artifact-review/store.js';
import { MediaOwnerError } from '../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../video-studio/content-owner/published-media-access.js';
import type { PreparedArtifactReader, PreparedArtifactReadInput } from './EntrustedWorkOwnerReadService.js';

/** F138 retained publications join F310 through the original Task; F232 continues to own other Artifact reads. */
export class ReviewedMediaArtifactReader implements PreparedArtifactReader {
  constructor(
    private readonly deps: {
      reviews: ArtifactReviewService;
      store: ArtifactReviewStore;
      publications: PreparedArtifactReader;
    },
  ) {}

  readPreparedArtifact(input: PreparedArtifactReadInput) {
    return this.readArtifact(input, true);
  }

  readRetainedArtifact(input: PreparedArtifactReadInput) {
    return this.readArtifact(input, false);
  }

  private async readArtifact(input: PreparedArtifactReadInput, includePublications: boolean) {
    const taskId = /^task:work:(.+)$/.exec(input.taskSubjectRef)?.[1];
    const candidates = taskId
      ? this.deps.store.listForTask(input.ownerUserId, taskId).filter((review) => matchesTaskArtifact(review, input))
      : [];
    if (!candidates.length)
      return includePublications && !input.artifactRef.startsWith('content:')
        ? this.deps.publications.readPreparedArtifact(input)
        : null;
    if (candidates.length !== 1 || !input.viewer || input.viewer.userId !== input.ownerUserId) return null;
    const candidate = candidates[0];
    if (!candidate) return null;
    const principal: MediaReviewPrincipal =
      input.viewer.surface === 'human'
        ? { userId: input.viewer.userId, actor: { kind: 'human', actorId: input.viewer.userId } }
        : {
            userId: input.viewer.userId,
            threadId: input.viewer.threadId,
            actor: { kind: 'cat', actorId: input.viewer.catId },
          };
    try {
      const view = await this.deps.reviews.readCurrent(candidate.reviewId, principal);
      if (
        view.authority.taskRevision !== input.taskRevision ||
        view.authority.state === 'asset_changed' ||
        view.pendingVersion
      )
        return null;
      const round = view.review.rounds.at(-1);
      if (!round) return null;
      return {
        artifactRef: input.artifactRef,
        artifactRevision: String(round.asset.ownerRevision),
        completenessRef: round.asset.ownerReceiptRef,
        previewRef: `content-review:${view.review.reviewId}:round:${round.number}`,
        openInWorkspaceRef: `workspace:content-review:${view.review.task.threadId}:${view.review.reviewId}`,
      };
    } catch (error) {
      if (error instanceof MediaOwnerError && (error.code === 'access_denied' || error.code === 'publication_changed'))
        return null;
      throw error;
    }
  }
}

function matchesTaskArtifact(review: ArtifactReview, input: PreparedArtifactReadInput): boolean {
  return (
    review.task.threadId === input.taskThreadId &&
    `task:work:${review.task.taskId}` === input.taskSubjectRef &&
    `task:item:${review.task.taskId}` === input.taskOwnerRef &&
    reviewRetainsArtifact(review, input.artifactRef)
  );
}
