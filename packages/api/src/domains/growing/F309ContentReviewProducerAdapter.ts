import {
  type ArtifactReview,
  type ArtifactReviewView,
  type ProducerAttentionReceiptV1,
  producerAttentionReceiptV1Schema,
} from '@cat-cafe/shared';
import { ArtifactReviewError } from '../collaborative-content/artifact-review/errors.js';
import type { ArtifactReviewService } from '../collaborative-content/artifact-review/service.js';
import type { ArtifactReviewStore } from '../collaborative-content/artifact-review/store.js';
import { MediaOwnerError } from '../video-studio/content-owner/media-errors.js';
import type {
  NeedsMeProducerAdapter,
  NeedsMeProducerReadInput,
  NeedsMeProducerReevaluateInput,
  NeedsMeProducerReevaluationResult,
} from './NeedsMeProducerAdapter.js';

type RetirementReason = NonNullable<ArtifactReview['rounds'][number]['attentionRetiredReason']>;
interface CurrentReviewAttention {
  review: ArtifactReview;
  authority: ArtifactReviewView['authority'] | null;
  retirementReason: RetirementReason | null;
}

/** Only an explicit current owner request for human judgment enters Needs Me. Comments never do. */
export class F309ContentReviewProducerAdapter implements NeedsMeProducerAdapter {
  readonly producerId = 'f309.content_review' as const;
  constructor(
    private readonly deps: {
      reviews: ArtifactReviewService;
      store: ArtifactReviewStore;
      onChanged: (ownerUserId: string, reviewId: string) => void;
      now?: () => string;
    },
  ) {}

  async listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]> {
    const receipts: ProducerAttentionReceiptV1[] = [];
    for (const reviewId of this.deps.store.listReviewIds(ownerUserId)) {
      const review = this.deps.store.get(reviewId);
      if (review?.rounds.at(-1)?.state !== 'awaiting_human') continue;
      const receipt = await this.readCurrentReceipt({ ownerUserId, producerSubjectRef: reviewId });
      if (receipt?.eligible) receipts.push(receipt);
    }
    return receipts;
  }

  async readCurrentReceipt(input: NeedsMeProducerReadInput): Promise<ProducerAttentionReceiptV1 | null> {
    const current = await this.readAttention(input);
    if (!current || current.retirementReason === 'access_revoked') return null;
    return this.projectReceipt(current.review, current.authority);
  }

  private async readAttention(input: NeedsMeProducerReadInput): Promise<CurrentReviewAttention | null> {
    let review = this.deps.store.get(input.producerSubjectRef);
    if (!review || review.task.ownerUserId !== input.ownerUserId) return null;
    let authority: ArtifactReviewView['authority'] | null = null;
    let reason: RetirementReason | null = null;
    try {
      const view = await this.deps.reviews.readCurrent(review.reviewId, {
        userId: input.ownerUserId,
        actor: { kind: 'human', actorId: input.ownerUserId },
      });
      review = view.review;
      authority = view.authority;
      if (authority.state !== 'current') reason = authority.state;
    } catch (error) {
      if (!(error instanceof MediaOwnerError) && !(error instanceof ArtifactReviewError)) throw error;
      if (error.code === 'revision_conflict' || error.code === 'version_pending') return null;
      if (!['access_denied', 'publication_changed', 'not_found'].includes(error.code)) throw error;
      reason = 'access_revoked';
    }
    return { review, authority, retirementReason: reason };
  }

  private retireAttention(review: ArtifactReview, reason: RetirementReason): ArtifactReview | null {
    const round = review.rounds.at(-1);
    if (!round) return null;
    if (
      round.state === 'awaiting_human' &&
      !round.attentionRetiredReason &&
      !this.deps.store.pendingVersion(review.reviewId)
    ) {
      try {
        review = this.deps.store.mutate(
          {
            reviewId: review.reviewId,
            expectedRevision: review.revision,
            operationId: `retire-attention-${review.revision}`,
            actor: { kind: 'owner', actorId: 'content-review' },
            round: round.number,
            kind: 'retire_attention',
            request: { reason },
            now: this.deps.now?.() ?? new Date().toISOString(),
          },
          (current) => {
            const next = structuredClone(current);
            const latest = next.rounds.at(-1);
            if (latest) latest.attentionRetiredReason = reason;
            next.revision += 1;
            next.updatedAt = this.deps.now?.() ?? new Date().toISOString();
            return next;
          },
        ).review;
        this.deps.onChanged(review.task.ownerUserId, review.reviewId);
      } catch (error) {
        if (
          !(error instanceof ArtifactReviewError) ||
          (error.code !== 'revision_conflict' && error.code !== 'version_pending')
        )
          throw error;
        return null;
      }
    }
    return review;
  }

  private projectReceipt(
    review: ArtifactReview,
    authority: ArtifactReviewView['authority'] | null,
  ): ProducerAttentionReceiptV1 {
    const latest = review.rounds.at(-1);
    const request = latest?.judgmentRequest;
    const eligible =
      authority?.state === 'current' &&
      authority.canWrite &&
      latest?.state === 'awaiting_human' &&
      !latest.attentionRetiredReason &&
      Boolean(request);
    return producerAttentionReceiptV1Schema.parse({
      eligible,
      producer: {
        producerId: this.producerId,
        ownerRef: `content-review:${review.reviewId}`,
        subjectRef: review.reviewId,
        revision: review.revision,
      },
      taskRef: { subjectRef: `task:work:${review.task.taskId}`, observedRevision: review.task.observedRevision },
      reEvaluateActionRef: `content-review:${review.reviewId}#reevaluate`,
      ...(eligible
        ? {
            kind: 'judgment',
            reasonCode: 'content_review_requested',
            recommendation: request?.judgmentNeeded,
            salience: 'normal',
            action: { actionRef: `content-review:${review.reviewId}`, expectedProducerRevision: review.revision },
          }
        : {}),
    });
  }

  async reEvaluate(input: NeedsMeProducerReevaluateInput): Promise<NeedsMeProducerReevaluationResult> {
    const review = this.deps.store.get(input.producerSubjectRef);
    if (!review || review.task.ownerUserId !== input.ownerUserId) return { state: 'retired', producerRevision: null };
    if (!this.matchesExpected(review, input) || this.deps.store.pendingVersion(review.reviewId)) {
      return { state: 'stale', producerRevision: review.revision };
    }
    const current = await this.readAttention(input);
    if (!current) return { state: 'retired', producerRevision: null };
    if (!this.matchesExpected(current.review, input) || this.deps.store.pendingVersion(review.reviewId)) {
      return { state: 'stale', producerRevision: current.review.revision };
    }
    if (current.retirementReason) {
      const retired = this.retireAttention(current.review, current.retirementReason);
      return retired
        ? { state: 'retired', producerRevision: retired.revision }
        : { state: 'stale', producerRevision: this.deps.store.get(review.reviewId)?.revision ?? null };
    }
    const receipt = this.projectReceipt(current.review, current.authority);
    return { state: receipt.eligible ? 'unchanged' : 'retired', producerRevision: receipt.producer.revision };
  }

  private matchesExpected(review: ArtifactReview, input: NeedsMeProducerReevaluateInput): boolean {
    return (
      review.revision === input.expectedProducerRevision &&
      `task:work:${review.task.taskId}` === input.taskRef.subjectRef &&
      review.task.observedRevision === input.taskRef.observedRevision &&
      `content-review:${review.reviewId}#reevaluate` === input.reEvaluateActionRef
    );
  }
}
