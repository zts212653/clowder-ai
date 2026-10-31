import type { ArtifactReview, ArtifactReviewAuditActor, ArtifactReviewReceipt } from '@cat-cafe/shared';
import type { ReviewReturnTarget } from './return-store.js';

export interface ReviewMutation {
  reviewId: string;
  expectedRevision: number;
  operationId: string;
  actor: ArtifactReviewAuditActor;
  now: string;
  round: number;
  kind: string;
  request: unknown;
  returnTarget?: ReviewReturnTarget;
}
export interface ReviewMutationResult {
  review: ArtifactReview;
  receipt: ArtifactReviewReceipt;
  replayed: boolean;
}
export interface PendingReviewVersion {
  input: ReviewMutation;
  payload: unknown;
}
