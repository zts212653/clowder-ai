import {
  type ArtifactReview,
  type ArtifactReviewAction,
  type ArtifactReviewActor,
  type ArtifactReviewResponse,
  type ArtifactReviewRound,
  artifactReviewSchema,
  type ReviewedMediaAsset,
} from '@cat-cafe/shared';
import { annotate, editAnnotationBody, replyToAnnotation, setAnnotationState } from './annotation-actions.js';
import { addVisualMarks, deleteVisualMark, requestImageEdit } from './artwork-actions.js';
import { ArtifactReviewError } from './errors.js';

interface ReviewActionContext {
  action: ArtifactReviewAction;
  actor: ArtifactReviewActor;
  round: number;
  ownerCatId: string | null;
  now: string;
  receiptRef: string;
}

/** Pure transitions; the store supplies CAS, durable history and one operation receipt. */
export function applyArtifactReviewAction(current: ArtifactReview, context: ReviewActionContext): ArtifactReview {
  const next = structuredClone(current);
  const round = next.rounds.find((candidate) => candidate.number === context.round);
  const latest = next.rounds.at(-1);
  if (!round || !latest) throw new ArtifactReviewError('not_found');
  const { action, now } = context;
  if (round !== latest && action.kind !== 'reply') throw new ArtifactReviewError('asset_changed');
  if (
    (round.state === 'approved' || round.state === 'superseded') &&
    action.kind !== 'reply' &&
    action.kind !== 'reopen'
  ) {
    throw new ArtifactReviewError('invalid_action', 'Reopen this round before changing its reviewed content');
  }

  switch (action.kind) {
    case 'add_visual_marks':
      addVisualMarks(round, action, context);
      next.version = 2;
      break;
    case 'delete_visual_mark':
      deleteVisualMark(round, action, context);
      next.version = 2;
      break;
    case 'request_image_edit': {
      const explanation = requestImageEdit(next, round, action, context);
      decideRound(round, { kind: 'submit_feedback', explanation }, context);
      next.version = 2;
      break;
    }
    case 'annotate':
      annotate(next, round, action, context);
      if (action.anchor.kind === 'image-point' || (action.anchor.kind === 'video-range' && action.anchor.framePoint))
        next.version = 2;
      break;
    case 'reply':
      replyToAnnotation(round, action, context);
      break;
    case 'edit':
      editAnnotationBody(round, action, context);
      break;
    case 'set_annotation_state':
      setAnnotationState(round, action, context);
      break;
    case 'request_judgment':
      requestJudgment(round, action, context);
      break;
    case 'submit_feedback':
    case 'decide':
      decideRound(round, action, context);
      break;
    case 'reopen':
      reopenRound(round, context);
      break;
  }
  next.revision += 1;
  next.updatedAt = now;
  const checked = artifactReviewSchema.safeParse(next);
  if (!checked.success) throw new ArtifactReviewError('limit_reached');
  return checked.data;
}

function requestJudgment(
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'request_judgment' }>,
  context: ReviewActionContext,
) {
  if (context.actor.kind !== 'cat' || context.actor.actorId !== context.ownerCatId)
    throw new ArtifactReviewError('owner_required');
  if (round.state === 'awaiting_human' && !round.attentionRetiredReason)
    throw new ArtifactReviewError('invalid_action');
  round.state = 'awaiting_human';
  round.judgmentRequest = {
    summary: action.summary,
    judgmentNeeded: action.judgmentNeeded,
    requestedBy: context.actor,
    requestedAt: context.now,
  };
  delete round.decision;
  delete round.attentionRetiredReason;
}

function decideRound(
  round: ArtifactReviewRound,
  action: Extract<ArtifactReviewAction, { kind: 'decide' | 'submit_feedback' }>,
  context: ReviewActionContext,
) {
  if (context.actor.kind !== 'human') throw new ArtifactReviewError('human_required');
  if (action.kind === 'decide' && (round.state !== 'awaiting_human' || round.attentionRetiredReason))
    throw new ArtifactReviewError('invalid_action');
  const outcome = action.kind === 'submit_feedback' ? 'changes_requested' : action.outcome;
  round.state = outcome;
  round.decision = {
    outcome,
    explanation: action.explanation,
    actor: context.actor,
    decidedAt: context.now,
    receiptRef: context.receiptRef,
  };
  delete round.attentionRetiredReason;
}

function reopenRound(round: ArtifactReviewRound, context: ReviewActionContext) {
  if (context.actor.kind !== 'human') throw new ArtifactReviewError('human_required');
  if (round.state !== 'approved' && round.state !== 'changes_requested')
    throw new ArtifactReviewError('invalid_action');
  round.state = 'draft';
  delete round.decision;
  delete round.judgmentRequest;
  delete round.attentionRetiredReason;
}

/** New file = a new round, with responses to the previous round; no inferred anchor migration. */
export function appendRespondedVersion(
  current: ArtifactReview,
  input: {
    asset: ReviewedMediaAsset;
    responses: ArtifactReviewResponse[];
    actor: ArtifactReviewActor;
    now: string;
  },
): ArtifactReview {
  const next = structuredClone(current);
  const previous = next.rounds.at(-1);
  if (
    !previous ||
    input.asset.contentRef !== current.contentRef ||
    input.asset.ownerRevision <= previous.asset.ownerRevision ||
    input.asset.mediaType !== previous.asset.mediaType
  )
    throw new ArtifactReviewError('asset_changed');
  assertVersionResponses(previous, input.responses);
  if (previous.state !== 'approved' && previous.state !== 'changes_requested') previous.state = 'superseded';
  next.rounds.push({
    number: previous.number + 1,
    asset: input.asset,
    openedAt: input.now,
    state: 'draft',
    annotations: [],
    responses: input.responses,
    responseAuthor: input.actor,
  });
  next.revision += 1;
  next.updatedAt = input.now;
  const checked = artifactReviewSchema.safeParse(next);
  if (!checked.success) throw new ArtifactReviewError('limit_reached');
  return checked.data;
}

export function assertVersionResponses(previous: ArtifactReviewRound, responses: ArtifactReviewResponse[]): void {
  const responseIds = new Set(responses.map((item) => item.annotationId));
  if (
    responseIds.size !== responses.length ||
    responses.some((item) => !previous.annotations.some((annotation) => annotation.id === item.annotationId)) ||
    previous.annotations.some((item) => item.state === 'open' && !responseIds.has(item.id))
  )
    throw new ArtifactReviewError('invalid_action');
}
