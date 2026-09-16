import type { ArtifactReview, ArtifactReviewAction, ArtifactReviewActor, ArtifactReviewRound } from '@cat-cafe/shared';
import { assertMediaAnchor } from './anchors.js';
import { ArtifactReviewError } from './errors.js';

interface AnnotationContext {
  actor: ArtifactReviewActor;
  now: string;
  ownerCatId: string | null;
}

export function annotate(
  review: ArtifactReview,
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'annotate' }>,
  context: AnnotationContext,
): void {
  assertMediaAnchor(action.anchor, round.asset.media);
  if (round.annotations.some((item) => item.id === action.annotationId))
    throw new ArtifactReviewError('invalid_action');
  if (action.reanchoredFrom) {
    const source = review.rounds.find((item) => item.number === action.reanchoredFrom?.round);
    if (
      !source ||
      source.number >= round.number ||
      !source.annotations.some((item) => item.id === action.reanchoredFrom?.annotationId)
    ) {
      throw new ArtifactReviewError('invalid_action');
    }
  }
  round.annotations.push({
    id: action.annotationId,
    anchor: action.anchor,
    body: action.body,
    author: context.actor,
    createdAt: context.now,
    updatedAt: context.now,
    state: 'open',
    replies: [],
    ...(action.reanchoredFrom ? { reanchoredFrom: action.reanchoredFrom } : {}),
  });
}

export function replyToAnnotation(
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'reply' }>,
  context: AnnotationContext,
): void {
  const annotation = round.annotations.find((item) => item.id === action.annotationId);
  if (!annotation || annotation.replies.some((reply) => reply.id === action.replyId))
    throw new ArtifactReviewError('invalid_action');
  annotation.replies.push({
    id: action.replyId,
    body: action.body,
    author: context.actor,
    createdAt: context.now,
    updatedAt: context.now,
  });
  annotation.updatedAt = context.now;
}

export function editAnnotationBody(
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'edit' }>,
  context: AnnotationContext,
): void {
  const annotation = round.annotations.find((item) => item.id === action.annotationId);
  const target = action.replyId ? annotation?.replies.find((reply) => reply.id === action.replyId) : annotation;
  if (!target) throw new ArtifactReviewError('not_found');
  if (target.author.kind !== context.actor.kind || target.author.actorId !== context.actor.actorId)
    throw new ArtifactReviewError('access_denied');
  target.body = action.body;
  target.updatedAt = context.now;
}

export function setAnnotationState(
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'set_annotation_state' }>,
  context: AnnotationContext,
): void {
  const annotation = round.annotations.find((item) => item.id === action.annotationId);
  if (!annotation) throw new ArtifactReviewError('not_found');
  const actor = context.actor;
  const isOwner = actor.kind === 'cat' && actor.actorId === context.ownerCatId;
  if (
    actor.kind !== 'human' &&
    !isOwner &&
    (annotation.author.kind !== actor.kind || annotation.author.actorId !== actor.actorId)
  )
    throw new ArtifactReviewError('access_denied');
  annotation.state = action.state;
  annotation.updatedAt = context.now;
}
