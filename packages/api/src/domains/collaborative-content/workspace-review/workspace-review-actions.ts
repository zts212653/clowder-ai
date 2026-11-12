import {
  reviewDrawingFitsMedia,
  type WorkspaceContentActor,
  type WorkspaceContentReview,
  type WorkspaceContentReviewAction,
  type WorkspaceContentSource,
  workspaceContentReviewActionSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { WorkspaceContentReviewError } from './errors.js';

/**
 * Server-only: the author takes back an annotation nobody has replied to yet. Used by F335 一键提议的「撤销」
 * (the person undoing comments a suggestion added for them). Not part of the public review action contract, so no
 * route or page can send it.
 */
export const withdrawAnnotationActionSchema = z
  .object({ kind: z.literal('withdraw_annotation'), annotationId: z.string().trim().min(1).max(256) })
  .strict();
export type WorkspaceReviewServerAction = WorkspaceContentReviewAction | z.infer<typeof withdrawAnnotationActionSchema>;

export function applyWorkspaceReviewAction(input: {
  readonly review: WorkspaceContentReview;
  readonly source: WorkspaceContentSource;
  readonly actor: WorkspaceContentActor;
  readonly action: WorkspaceReviewServerAction;
  readonly now: string;
}): WorkspaceContentReview {
  if (input.action.kind === 'withdraw_annotation') {
    return withdrawAnnotation(input, withdrawAnnotationActionSchema.parse(input.action).annotationId);
  }
  const action = workspaceContentReviewActionSchema.parse(input.action);
  switch (action.kind) {
    case 'add_visual_marks':
      return addVisualMarks(input, action.marks);
    case 'delete_visual_mark':
      return deleteVisualMark(input, action.markId);
    case 'reply':
      return reply(input, action.annotationId, action.replyId, action.body);
    case 'set_annotation_state':
      return setAnnotationState(input, action.annotationId, action.state);
  }
}

/** Only the author, and only before anyone replied: the annotation is taken back as if it had not been added. */
function withdrawAnnotation(
  input: Parameters<typeof applyWorkspaceReviewAction>[0],
  annotationId: string,
): WorkspaceContentReview {
  const annotation = input.review.annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation || (annotation.replies?.length ?? 0) > 0 || !sameActor(annotation.author, input.actor))
    throw new WorkspaceContentReviewError('invalid_action');
  return {
    ...input.review,
    annotations: input.review.annotations.filter((candidate) => candidate.id !== annotationId),
  };
}

function addVisualMarks(
  input: Parameters<typeof applyWorkspaceReviewAction>[0],
  marks: Extract<WorkspaceContentReviewAction, { kind: 'add_visual_marks' }>['marks'],
): WorkspaceContentReview {
  if (
    input.source.kind === 'text' ||
    input.source.kind === 'video-project' ||
    input.source.kind === 'collective-artifact'
  )
    throw new WorkspaceContentReviewError('unsupported_content');
  const existing = new Set((input.review.visualMarks ?? []).map((mark) => mark.drawing.id));
  const requested = new Set<string>();
  for (const drawing of marks) {
    if (existing.has(drawing.id) || requested.has(drawing.id) || !reviewDrawingFitsMedia(drawing, input.source.media))
      throw new WorkspaceContentReviewError('invalid_action');
    requested.add(drawing.id);
  }
  return {
    ...input.review,
    visualMarks: [
      ...(input.review.visualMarks ?? []),
      ...marks.map((drawing) => ({
        drawing,
        baseRevision: input.source.revision,
        author: input.actor,
        createdAt: input.now,
        state: 'active' as const,
      })),
    ],
  };
}

function deleteVisualMark(
  input: Parameters<typeof applyWorkspaceReviewAction>[0],
  markId: string,
): WorkspaceContentReview {
  const mark = (input.review.visualMarks ?? []).find((candidate) => candidate.drawing.id === markId);
  if (!mark || mark.state !== 'active' || !sameActor(mark.author, input.actor))
    throw new WorkspaceContentReviewError('invalid_action');
  return {
    ...input.review,
    visualMarks: (input.review.visualMarks ?? []).map((candidate) =>
      candidate.drawing.id === markId ? { ...candidate, state: 'deleted' as const, deletedAt: input.now } : candidate,
    ),
  };
}

function reply(
  input: Parameters<typeof applyWorkspaceReviewAction>[0],
  annotationId: string,
  replyId: string,
  body: string,
): WorkspaceContentReview {
  const annotation = input.review.annotations.find((candidate) => candidate.id === annotationId);
  if (
    !annotation ||
    (annotation.replies ?? []).length >= 100 ||
    (annotation.replies ?? []).some((candidate) => candidate.id === replyId)
  )
    throw new WorkspaceContentReviewError('invalid_action');
  return {
    ...input.review,
    annotations: input.review.annotations.map((candidate) =>
      candidate.id === annotationId
        ? {
            ...candidate,
            replies: [
              ...(candidate.replies ?? []),
              { id: replyId, body, author: input.actor, createdAt: input.now, updatedAt: input.now },
            ],
            updatedAt: input.now,
          }
        : candidate,
    ),
  };
}

function setAnnotationState(
  input: Parameters<typeof applyWorkspaceReviewAction>[0],
  annotationId: string,
  state: 'open' | 'resolved',
): WorkspaceContentReview {
  const annotation = input.review.annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation || annotation.state === state) throw new WorkspaceContentReviewError('invalid_action');
  return {
    ...input.review,
    annotations: input.review.annotations.map((candidate) =>
      candidate.id === annotationId ? { ...candidate, state, updatedAt: input.now } : candidate,
    ),
  };
}

function sameActor(first: WorkspaceContentActor, second: WorkspaceContentActor): boolean {
  return first.kind === second.kind && first.actorId === second.actorId;
}
