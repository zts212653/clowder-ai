import { isDeepStrictEqual } from 'node:util';
import type { ArtifactReview, ReviewedMediaAsset, SubmitWork, WorkCommand } from '@cat-cafe/shared';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import {
  type ContentSettlementReceiptV1,
  isWorkPublicationScope,
  type WorkPublicationScopeV1,
} from '../../video-studio/content-owner/types.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import { assertModificationResponseReference } from '../artifact-review/modification-request-reference.js';
import { appendRespondedVersion } from '../artifact-review/reducer.js';
import type {
  ArtifactReviewStore,
  PendingReviewVersion,
  ReviewMutation,
  ReviewMutationResult,
} from '../artifact-review/store.js';
import { fingerprint } from '../artifact-review/store-support.js';
import {
  acceptedWorkResponseSchema,
  isWorkResponseIntent,
  readAcceptedWorkResponse,
} from './review-response-contract.js';
import { completedWorkResponseResolution } from './review-response-resolution.js';
import type { OpenWorkSource, WorkPrincipal } from './service.js';
import { workVersionRecord } from './version-record.js';

type Resolution = Extract<WorkCommand, { action: 'resolve-review-submission' }>;
export interface WorkResponseAuthorityInput {
  review: ArtifactReview;
  principal: WorkPrincipal;
  permission: 'read' | 'respond';
  response?: NonNullable<SubmitWork['reviewResponse']>;
}
export class WorkReviewResponseService {
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      owner: ProjectContentOwnerService;
      readAsset(review: ArtifactReview, revision: number, principal: WorkPrincipal): Promise<ReviewedMediaAsset>;
      authorize(input: WorkResponseAuthorityInput): Promise<void>;
      now?: () => string;
      onCommitted?: (reviewId: string) => Promise<void>;
    },
  ) {}

  private mutation(command: SubmitWork, principal: WorkPrincipal): ReviewMutation {
    const response = command.reviewResponse;
    if (!response) throw new ArtifactReviewError('invalid_action');
    return {
      reviewId: response.reviewId,
      expectedRevision: response.expectedReviewRevision,
      operationId: command.operationId,
      actor: principal.actor,
      now: this.now(),
      round: response.sourceRound,
      kind: 'work_submit_response',
      request: command,
    };
  }
  private now() {
    return this.deps.now?.() ?? new Date().toISOString();
  }
  private review(reviewId: string, principal: WorkPrincipal) {
    const review = this.deps.store.get(reviewId);
    if (!review) throw new ArtifactReviewError('not_found');
    if (review.task.ownerUserId !== principal.userId) throw new ArtifactReviewError('access_denied');
    return review;
  }

  async reserve(
    command: SubmitWork,
    principal: WorkPrincipal,
    scope: WorkPublicationScopeV1,
    opened: OpenWorkSource,
    requestDigest: `sha256:${string}`,
  ) {
    const response = command.reviewResponse!;
    const review = this.review(response.reviewId, principal);
    if (
      principal.actor.kind !== 'cat' ||
      review.contentRef !== command.contentRef ||
      scope.ownerUserId !== principal.userId
    )
      throw new ArtifactReviewError('owner_required');
    await this.deps.authorize({ review, principal, permission: 'respond', response });
    const input = this.mutation(command, principal);
    const replay = this.deps.store.replay(input);
    if (replay) throw new ArtifactReviewError('invalid_action', 'This submission is already final');
    assertModificationResponseReference(this.deps.store, review, response, principal.actor, response.sourceRound);
    if (!opened.media) throw new ArtifactReviewError('invalid_media');
    const accepted = acceptedWorkResponseSchema.parse({
      kind: 'work-submit-response',
      command,
      ownerUserId: scope.ownerUserId,
      threadId: scope.threadId,
      requestDigest,
      blobDigest: opened.blobDigest,
      media: opened.media,
      publication: { ...opened.publication, threadId: scope.threadId },
    });
    // Validate before the irreversible owner effect, including a shortened result with the same stream id.
    appendRespondedVersion(review, {
      sourceRound: response.sourceRound,
      sourceRequestId: response.requestId,
      responses: response.responses,
      actor: principal.actor,
      now: input.now,
      asset: {
        contentRef: command.contentRef,
        ownerRevision: command.expectedOwnerRevision + 1,
        blobDigest: accepted.blobDigest,
        mediaType: 'video/mp4',
        media: accepted.media,
        sourcePublication: accepted.publication,
        ownerReceiptRef: 'pending-owner-receipt',
      },
    });
    const prior = this.deps.store.pendingVersion(review.reviewId);
    if (prior && !isDeepStrictEqual(acceptedWorkResponseSchema.parse(prior.payload), accepted))
      throw new ArtifactReviewError('operation_reused');
    this.deps.store.reserveVersion(input, accepted);
    return this.deps.store.pendingVersion(review.reviewId)!;
  }

  /** Called at both owner fences, including after all stream awaits while its lock is still held. */
  async assertEffect(pending: PendingReviewVersion, principal: WorkPrincipal) {
    const accepted = readAcceptedWorkResponse(pending);
    const current = this.deps.store.pendingVersion(pending.input.reviewId);
    if (
      !current ||
      fingerprint(current.input) !== fingerprint(pending.input) ||
      !isDeepStrictEqual(current.payload, pending.payload)
    )
      throw new ArtifactReviewError('operation_reused');
    const review = this.review(pending.input.reviewId, principal);
    await this.deps.authorize({ review, principal, permission: 'respond', response: accepted.command.reviewResponse });
    assertModificationResponseReference(
      this.deps.store,
      review,
      accepted.command.reviewResponse,
      principal.actor,
      pending.input.round,
    );
    // Authorization may await; a concurrent explicit resolution must win before a manifest can appear.
    const after = this.deps.store.pendingVersion(pending.input.reviewId);
    if (!after || fingerprint(after.input) !== fingerprint(pending.input))
      throw new ArtifactReviewError('operation_reused');
  }

  async project(
    command: SubmitWork,
    principal: WorkPrincipal,
    scope: WorkPublicationScopeV1,
    receipt: ContentSettlementReceiptV1,
    requestDigest: `sha256:${string}`,
  ) {
    const input = this.mutation(command, principal);
    const review = this.review(input.reviewId, principal);
    await this.deps.authorize({ review, principal, permission: 'read' });
    const pending = this.deps.store.pendingVersion(input.reviewId);
    const replay = this.deps.store.replay(input);
    if (replay?.receipt.outcome === 'aborted')
      throw new ArtifactReviewError('invalid_action', 'Submission was explicitly terminated');
    if (pending) {
      if (fingerprint(pending.input) !== fingerprint(input)) throw new ArtifactReviewError('operation_reused');
      return this.complete(pending, principal, scope, receipt);
    }
    if (!replay) throw new ArtifactReviewError('operation_reused');
    this.assertReceipt(review, input, command, receipt, requestDigest);
    const version = workVersionRecord(command, scope, receipt, requestDigest);
    const result = this.deps.store.finishVersion(input, (current) => current, version);
    await this.deps.onCommitted?.(input.reviewId);
    return {
      status: 'saved' as const,
      reference: { contentRef: receipt.contentRef, ownerRevision: receipt.ownerRevision },
      receipt,
      version,
      review: result,
    };
  }

  private assertReceipt(
    review: ArtifactReview,
    input: ReviewMutation,
    command: SubmitWork,
    receipt: ContentSettlementReceiptV1,
    digest: string,
  ) {
    if (
      receipt.contentRef !== review.contentRef ||
      receipt.contentRef !== command.contentRef ||
      receipt.operationId !== input.operationId ||
      receipt.actor.kind !== input.actor.kind ||
      receipt.actor.actorId !== input.actor.actorId ||
      receipt.previousOwnerRevision !== command.expectedOwnerRevision ||
      receipt.ownerRevision !== command.expectedOwnerRevision + 1 ||
      receipt.operationContext?.kind !== 'work:submit' ||
      receipt.operationContext.requestDigest !== digest
    )
      throw new ArtifactReviewError('operation_reused');
  }

  /** Ordinary authorized reads can only complete an observed fact. They never resume a publication. */
  async recover(review: ArtifactReview, principal: WorkPrincipal): Promise<ReviewMutationResult | null> {
    const pending = this.deps.store.pendingVersion(review.reviewId);
    if (!pending || !isWorkResponseIntent(pending.payload)) return null;
    await this.deps.authorize({ review, principal, permission: 'read' });
    const receipt = (await this.deps.owner.listOutbox(review.contentRef)).find(
      (item) => item.operationId === pending.input.operationId,
    );
    if (!receipt) return null;
    const description = await this.deps.owner.describe(review.contentRef, receipt.ownerRevision);
    if (!isWorkPublicationScope(description.publicationScope)) throw new ArtifactReviewError('access_denied');
    return (await this.complete(pending, principal, description.publicationScope, receipt)).review;
  }

  private async complete(
    pending: PendingReviewVersion,
    viewer: WorkPrincipal,
    scope: WorkPublicationScopeV1,
    receipt: ContentSettlementReceiptV1,
  ) {
    const accepted = readAcceptedWorkResponse(pending);
    const review = this.review(pending.input.reviewId, viewer);
    await this.deps.authorize({ review, principal: viewer, permission: 'read' });
    this.assertReceipt(review, pending.input, accepted.command, receipt, accepted.requestDigest);
    const asset = await this.deps.readAsset(review, receipt.ownerRevision, viewer);
    if (
      accepted.ownerUserId !== viewer.userId ||
      accepted.ownerUserId !== scope.ownerUserId ||
      accepted.threadId !== scope.threadId ||
      asset.ownerReceiptRef !== receipt.receiptId ||
      asset.blobDigest !== accepted.blobDigest ||
      receipt.blobDigest !== accepted.blobDigest ||
      !isDeepStrictEqual(asset.sourcePublication, accepted.publication) ||
      !isDeepStrictEqual(asset.media, accepted.media)
    )
      throw new ArtifactReviewError('operation_reused');
    await this.deps.authorize({ review: this.review(review.reviewId, viewer), principal: viewer, permission: 'read' });
    const result = this.deps.store.finishVersion(
      pending.input,
      (current) =>
        appendRespondedVersion(current, {
          asset,
          sourceRound: accepted.command.reviewResponse.sourceRound,
          sourceRequestId: accepted.command.reviewResponse.requestId,
          responses: accepted.command.reviewResponse.responses,
          actor: accepted.actor,
          now: pending.input.now,
        }),
      workVersionRecord(accepted.command, scope, receipt, accepted.requestDigest),
    );
    await this.deps.onCommitted?.(pending.input.reviewId);
    return {
      status: 'saved' as const,
      reference: { contentRef: receipt.contentRef, ownerRevision: receipt.ownerRevision },
      receipt,
      version: this.deps.store.works.get(scope.ownerUserId, receipt.contentRef, receipt.ownerRevision)!,
      review: result,
    };
  }

  async resolve(command: Resolution, principal: WorkPrincipal) {
    if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
      throw new ArtifactReviewError('human_required');
    const review = this.review(command.reviewId, principal);
    await this.deps.authorize({ review, principal, permission: 'read' });
    const resolution: ReviewMutation = {
      reviewId: command.reviewId,
      expectedRevision: command.expectedReviewRevision + 1,
      operationId: command.operationId,
      actor: principal.actor,
      now: this.now(),
      round: command.sourceRound,
      kind: 'cancel_work_submission',
      request: command,
    };
    const replay = this.deps.store.replay(resolution);
    if (replay) return { status: 'aborted' as const, review: replay };
    return this.deps.owner.reconcileWorkOperation(
      { contentRef: review.contentRef, ownerUserId: principal.userId, operationId: command.pendingOperationId },
      async (receipt) => {
        await this.deps.authorize({ review: this.review(command.reviewId, principal), principal, permission: 'read' });
        const pending = this.deps.store.pendingVersion(command.reviewId);
        if (!pending && receipt)
          return completedWorkResponseResolution(
            this.deps.store,
            this.review(command.reviewId, principal),
            command,
            receipt,
          );
        if (
          !pending ||
          pending.input.operationId !== command.pendingOperationId ||
          pending.input.round !== command.sourceRound ||
          pending.input.expectedRevision !== command.expectedReviewRevision ||
          !isWorkResponseIntent(pending.payload)
        )
          throw new ArtifactReviewError('revision_conflict');
        const accepted = readAcceptedWorkResponse(pending);
        if (receipt) {
          const description = await this.deps.owner.describe(review.contentRef, receipt.ownerRevision);
          if (!isWorkPublicationScope(description.publicationScope)) throw new ArtifactReviewError('access_denied');
          return this.complete(pending, principal, description.publicationScope, receipt);
        }
        if (accepted.command.contentRef !== review.contentRef) throw new ArtifactReviewError('operation_reused');
        // All work-response effects recheck this reservation inside this same owner lock.
        return { status: 'aborted' as const, review: this.deps.store.abortWorkVersion(pending.input, resolution) };
      },
    );
  }
}
