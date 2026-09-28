import {
  type ArtifactReview,
  type ArtifactReviewActor,
  type RespondWithMediaVersion,
  respondWithMediaVersionSchema,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ContentOwnerConflictError, ContentOwnerIdempotencyError } from '../../video-studio/content-owner/service.js';
import type { ContentSettlementReceiptV1 } from '../../video-studio/content-owner/types.js';
import { ArtifactReviewError } from './errors.js';
import { appendRespondedVersion, assertVersionResponses } from './reducer.js';
import type { ArtifactReviewStore, ReviewMutation, ReviewMutationResult } from './store.js';

type MediaOwner = Pick<
  PublishedMediaService,
  'access' | 'publishVersion' | 'operationReceipt' | 'read' | 'currentRevision'
>;

/** A durable intent fences the review while F138 commits. Recovery projects its exact receipt, never guesses. */
export class ArtifactVersionResponseService {
  constructor(private readonly deps: { store: ArtifactReviewStore; media: MediaOwner; now: () => string }) {}

  mutation(
    command: RespondWithMediaVersion,
    actor: ArtifactReviewActor,
    round: number,
    now = this.deps.now(),
  ): ReviewMutation {
    return {
      reviewId: command.reviewId,
      expectedRevision: command.expectedRevision,
      operationId: command.operationId,
      actor,
      now,
      round,
      kind: 'respond_with_version',
      request: command,
    };
  }

  async respond(
    raw: RespondWithMediaVersion,
    principal: MediaReviewPrincipal,
    review: ArtifactReview,
  ): Promise<ReviewMutationResult> {
    const command = respondWithMediaVersionSchema.parse(raw);
    const last = review.rounds.at(-1);
    if (!last) throw new ArtifactReviewError('not_found');
    const base = review.rounds.find((round) => round.asset.ownerRevision === command.expectedOwnerRevision);
    if (!base) throw new ArtifactReviewError('asset_changed');
    const mutation = this.mutation(command, principal.actor, base.number);
    const replay = this.deps.store.replay(mutation);
    if (replay) return replay;
    const task = await this.deps.media.access.authorize(review.task.taskId, principal, {
      expectedRevision: command.expectedTaskRevision,
    });
    if (principal.actor.kind !== 'cat' || task.ownerCatId !== principal.actor.actorId)
      throw new ArtifactReviewError('owner_required');
    if (review.revision !== command.expectedRevision) throw new ArtifactReviewError('revision_conflict');
    if (last.asset.ownerRevision !== command.expectedOwnerRevision) throw new ArtifactReviewError('asset_changed');
    const currentRevision = await this.deps.media.currentRevision(review.contentRef, principal);
    if (currentRevision !== command.expectedOwnerRevision) throw new ArtifactReviewError('asset_changed');
    assertVersionResponses(last, command.responses);
    this.deps.store.reserveVersion(mutation, command);
    return this.resume(review, mutation, command, principal);
  }

  async recover(review: ArtifactReview, viewer: MediaReviewPrincipal): Promise<ReviewMutationResult | null> {
    const pending = this.deps.store.pendingVersion(review.reviewId);
    if (!pending) return null;
    const command = respondWithMediaVersionSchema.parse(pending.payload);
    if (
      command.reviewId !== review.reviewId ||
      command.operationId !== pending.input.operationId ||
      pending.input.actor.kind !== 'cat'
    ) {
      throw new ArtifactReviewError('operation_reused');
    }
    const observed = await this.deps.media.operationReceipt(
      review.contentRef,
      this.ownerOperationId(review.reviewId, command.operationId),
      viewer,
    );
    if (observed !== null) return this.project(review, pending.input, command, observed, viewer);
    // The persisted accepted intent is the actor proof. It may resume only while the same canonical owner and Task revision authorize it.
    const original: MediaReviewPrincipal = {
      userId: review.task.ownerUserId,
      threadId: review.task.threadId,
      actor: { kind: 'cat', actorId: pending.input.actor.actorId },
    };
    return this.resume(review, pending.input, command, original);
  }

  private async resume(
    review: ArtifactReview,
    mutation: ReviewMutation,
    command: RespondWithMediaVersion,
    principal: MediaReviewPrincipal,
  ): Promise<ReviewMutationResult> {
    const operationId = this.ownerOperationId(review.reviewId, command.operationId);
    try {
      const observed = await this.deps.media.operationReceipt(review.contentRef, operationId, principal);
      if (observed !== null) return this.project(review, mutation, command, observed, principal);
      const asset = await this.deps.media.publishVersion({
        taskId: review.task.taskId,
        expectedTaskRevision: command.expectedTaskRevision,
        contentRef: review.contentRef,
        expectedOwnerRevision: command.expectedOwnerRevision,
        artifactRef: command.artifactRef,
        expectedArtifactRevision: command.expectedArtifactRevision,
        operationId,
        principal,
      });
      return this.deps.store.finishVersion(mutation, (current) =>
        appendRespondedVersion(current, {
          asset,
          responses: command.responses,
          actor: principal.actor,
          now: mutation.now,
        }),
      );
    } catch (error) {
      // A post-commit failure is recoverable from F138. Never clear the intent on an unknown write outcome.
      const observed = await this.deps.media.operationReceipt(review.contentRef, operationId, principal);
      if (observed !== null) return this.project(review, mutation, command, observed, principal);
      if (
        error instanceof MediaOwnerError ||
        error instanceof ContentOwnerConflictError ||
        error instanceof ContentOwnerIdempotencyError
      ) {
        this.deps.store.abortVersion(mutation);
      }
      throw error;
    }
  }

  private async project(
    review: ArtifactReview,
    mutation: ReviewMutation,
    command: RespondWithMediaVersion,
    receipt: ContentSettlementReceiptV1,
    principal: MediaReviewPrincipal,
  ): Promise<ReviewMutationResult> {
    if (
      mutation.actor.kind !== 'cat' ||
      receipt.actor.kind !== 'cat' ||
      receipt.actor.actorId !== mutation.actor.actorId ||
      receipt.contentRef !== review.contentRef ||
      receipt.operationId !== this.ownerOperationId(review.reviewId, command.operationId) ||
      receipt.previousOwnerRevision !== command.expectedOwnerRevision ||
      receipt.ownerRevision !== command.expectedOwnerRevision + 1
    )
      throw new ArtifactReviewError('operation_reused');
    const actor = mutation.actor;
    const asset = await this.deps.media.read(review.contentRef, receipt.ownerRevision, principal);
    if (
      asset.ownerReceiptRef !== receipt.receiptId ||
      asset.blobDigest !== receipt.blobDigest ||
      asset.sourcePublication.artifactRef !== command.artifactRef ||
      asset.sourcePublication.revision !== command.expectedArtifactRevision
    )
      throw new ArtifactReviewError('operation_reused');
    return this.deps.store.finishVersion(mutation, (current) =>
      appendRespondedVersion(current, {
        asset,
        responses: command.responses,
        actor,
        now: mutation.now,
      }),
    );
  }

  private ownerOperationId(reviewId: string, operationId: string): string {
    return `review-version:${reviewId}:${operationId}`;
  }
}
