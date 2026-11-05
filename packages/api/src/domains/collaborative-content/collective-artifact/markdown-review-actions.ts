import { createHash } from 'node:crypto';
import { collectiveArtifactReviewActionCommandSchema, type WorkspaceContentReviewAction } from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewStore, WorkspaceReviewMutation } from '../workspace-review/store.js';
import { applyWorkspaceReviewAction } from '../workspace-review/workspace-review-actions.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import type { CollectiveMarkdownReviews } from './markdown-reviews.js';

/** Existing public discussion + original F309 CAS; a reply is not a modification or an adoption. */
export async function actOnCollectiveMarkdownReview(
  admitted: AdmittedCollectiveMarkdown,
  unsafe: unknown,
  store: WorkspaceContentReviewStore,
  reviews: CollectiveMarkdownReviews,
) {
  const input = collectiveArtifactReviewActionCommandSchema.parse(unsafe);
  const { action } = input;
  const review = reviews.prepare(admitted);
  const annotation = review.annotations.find((item) => item.id === action.annotationId);
  if (!annotation) throw new WorkspaceContentReviewError('not_found');
  const actor = { kind: 'human' as const, actorId: admitted.constraint.humanId };
  const now = new Date().toISOString();
  let operationId = admitted.operationId;
  let command: WorkspaceContentReviewAction;
  if (action.kind === 'reply') {
    if (
      admitted.constraint.reviewReply?.annotationId !== action.annotationId ||
      admitted.constraint.reviewReply.messageEventId !== action.messageEventId
    )
      throw new WorkspaceContentReviewError('access_denied');
    const source = annotation.collectiveMessage;
    if (
      !source ||
      source.serviceInstanceId !== admitted.scope.serviceInstanceId ||
      source.collectiveId !== admitted.scope.collectiveId ||
      source.ownerRevision !== admitted.content.ownerRevision ||
      source.blobDigest !== admitted.content.blobDigest ||
      action.replyToEventId !== source.eventId ||
      action.location.channelId !== source.channelId ||
      action.location.rootEventId !== source.rootEventId
    )
      throw new WorkspaceContentReviewError('access_denied');
    // The immutable message is the effect identity even if a browser recovers through a new transport UUID/CAS.
    operationId = `collective-reply:${createHash('sha256')
      .update(JSON.stringify([review.reviewId, annotation.id, action.messageEventId]))
      .digest('hex')}`;
    command = { kind: 'reply', annotationId: annotation.id, replyId: operationId, body: action.body };
  } else {
    if (
      admitted.content.ownerRevision !== admitted.content.currentOwnerRevision ||
      review.source.revision !== admitted.content.blobDigest
    )
      throw new WorkspaceContentReviewError('source_changed');
    command = action;
  }
  const mutation: WorkspaceReviewMutation = {
    reviewId: review.reviewId,
    expectedRevision: input.expectedReviewRevision,
    fingerprintRevision: action.kind === 'reply' ? 1 : input.expectedReviewRevision,
    operationId,
    actor,
    now,
    kind: `collective:${action.kind}`,
    request: { action, ownerRevision: admitted.content.ownerRevision, blobDigest: admitted.content.blobDigest },
  };
  await admitted.authorize();
  const replay = store.replay(mutation);
  if (replay)
    return { receipt: replay.receipt, annotationId: annotation.id, ownerRevision: admitted.content.ownerRevision };
  const result = store.mutate(mutation, (current) => ({
    ...applyWorkspaceReviewAction({ review: current, source: reviews.source(admitted), actor, action: command, now }),
    revision: current.revision + 1,
    updatedAt: now,
  }));
  return { receipt: result.receipt, annotationId: annotation.id, ownerRevision: admitted.content.ownerRevision };
}
