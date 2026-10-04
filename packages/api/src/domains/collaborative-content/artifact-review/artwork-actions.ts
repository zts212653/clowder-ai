import {
  type ArtifactReview,
  type ArtifactReviewAction,
  type ArtifactReviewActor,
  type ArtifactReviewRound,
  imageModificationInstruction,
  reviewDrawingFitsMedia,
} from '@cat-cafe/shared';
import { annotate } from './annotation-actions.js';
import { ArtifactReviewError } from './errors.js';

interface ArtworkContext {
  actor: ArtifactReviewActor;
  now: string;
  ownerCatId: string | null;
}

export function addVisualMarks(
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'add_visual_marks' }>,
  context: ArtworkContext,
): void {
  const existing = new Set(round.visualMarks?.map((mark) => mark.drawing.id));
  for (const drawing of action.marks) {
    if (existing.has(drawing.id)) throw new ArtifactReviewError('invalid_action');
    if (!reviewDrawingFitsMedia(drawing, round.asset.media)) throw new ArtifactReviewError('invalid_anchor');
    existing.add(drawing.id);
  }
  round.visualMarks = [
    ...(round.visualMarks ?? []),
    ...action.marks.map((drawing) => ({
      drawing,
      author: context.actor,
      createdAt: context.now,
      state: 'active' as const,
    })),
  ];
}

export function deleteVisualMark(
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'delete_visual_mark' }>,
  context: ArtworkContext,
): void {
  const mark = round.visualMarks?.find((item) => item.drawing.id === action.markId);
  if (!mark || mark.state !== 'active') throw new ArtifactReviewError('not_found');
  if (mark.author.kind !== context.actor.kind || mark.author.actorId !== context.actor.actorId)
    throw new ArtifactReviewError('access_denied');
  mark.state = 'deleted';
  mark.deletedAt = context.now;
}

/** Explicit human editing intent, stored as an actionable annotation on the immutable source round. */
export function requestImageEdit(
  review: ArtifactReview,
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'request_image_edit' }>,
  context: ArtworkContext,
): string {
  if (context.actor.kind !== 'human') throw new ArtifactReviewError('human_required');
  if (round.asset.media.kind !== 'image') throw new ArtifactReviewError('invalid_action');
  const region =
    action.edit.kind === 'erase-region'
      ? action.edit.region
      : {
          x: 0,
          y: 0,
          width: round.asset.media.width,
          height: round.asset.media.height,
        };
  const instruction = imageModificationInstruction(action.edit);
  const body = action.note ? `${instruction}\n${action.note}` : instruction;
  annotate(
    review,
    round,
    { kind: 'annotate', annotationId: action.annotationId, anchor: { kind: 'image-region', ...region }, body },
    context,
  );
  const annotation = round.annotations.at(-1);
  if (!annotation) throw new ArtifactReviewError('invalid_action');
  annotation.imageEdit = action.edit;
  return body;
}

export function requestMediaEdit(
  review: ArtifactReview,
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'request_media_edit' }>,
  context: ArtworkContext,
): string {
  if (context.actor.kind !== 'human') throw new ArtifactReviewError('human_required');
  if (action.mediaType !== round.asset.mediaType) throw new ArtifactReviewError('invalid_action');
  const media = round.asset.media;
  const anchor =
    action.anchor ??
    (media.kind === 'image'
      ? { kind: 'image-region' as const, x: 0, y: 0, width: media.width, height: media.height }
      : {
          kind: 'video-range' as const,
          streamId: media.streamId,
          startTick: media.startTick,
          endTick: media.startTick + media.durationTicks,
        });
  annotate(review, round, { kind: 'annotate', annotationId: action.annotationId, anchor, body: action.body }, context);
  return action.body;
}
