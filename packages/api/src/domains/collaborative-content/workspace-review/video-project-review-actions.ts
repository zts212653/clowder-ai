import type {
  VideoProjectReviewAction,
  VideoProjectReviewAnchor,
  VideoProjectReviewHistory,
  WorkspaceContentActor,
  WorkspaceContentAnnotation,
} from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from './errors.js';

/** A later location replaces the effective set; original and older anchors remain history. */
export function effectiveProjectReviewTargets(annotation: WorkspaceContentAnnotation): VideoProjectReviewAnchor[] {
  if (!('kind' in annotation.anchor) || annotation.anchor.kind !== 'video-project')
    throw new WorkspaceContentReviewError('unsupported_content');
  const location = annotation.projectHistory
    ?.slice()
    .reverse()
    .find((event) => event.kind === 'located');
  if (!location) return [annotation.anchor];
  if (!location.targets?.length) throw new WorkspaceContentReviewError('invalid_action');
  return location.targets;
}

/** Appended with the state/reply change in the canonical store transaction. */
export function applyProjectReviewAction(
  annotation: WorkspaceContentAnnotation,
  action: VideoProjectReviewAction,
  actor: WorkspaceContentActor,
  at: string,
  operationId: string,
): WorkspaceContentAnnotation {
  if (!('kind' in annotation.anchor) || annotation.anchor.kind !== 'video-project' || !annotation.projectHistory)
    throw new WorkspaceContentReviewError('unsupported_content');
  const event = projectHistoryEvent(action, actor, at, operationId);
  let next = { ...annotation, updatedAt: at };
  switch (action.kind) {
    case 'located':
      event.targets = action.targets;
      break;
    case 'replied': {
      next = appendProjectReply(next, action, actor, at);
      event.replyId = action.replyId;
      break;
    }
    case 'addressed':
      event.result = action.result;
      break;
    case 'reopened':
      if (annotation.state === 'open' && !annotation.projectHistory.some((item) => item.kind === 'addressed'))
        throw new WorkspaceContentReviewError('invalid_action');
      next = { ...next, state: 'open' };
      break;
    case 'resolved':
      if (annotation.state === 'resolved') throw new WorkspaceContentReviewError('invalid_action');
      next = { ...next, state: 'resolved' };
      break;
  }
  return { ...next, projectHistory: [...annotation.projectHistory, event] };
}

function projectHistoryEvent(
  action: VideoProjectReviewAction,
  actor: WorkspaceContentActor,
  at: string,
  operationId: string,
): VideoProjectReviewHistory {
  const event: VideoProjectReviewHistory = { kind: action.kind, actor, at, operationId };
  if ('reason' in action && action.reason !== undefined) event.reason = action.reason;
  return event;
}

function appendProjectReply(
  annotation: WorkspaceContentAnnotation,
  action: Extract<VideoProjectReviewAction, { kind: 'replied' }>,
  actor: WorkspaceContentActor,
  at: string,
): WorkspaceContentAnnotation {
  const replies = annotation.replies ?? [];
  if (replies.length >= 100 || replies.some((reply) => reply.id === action.replyId))
    throw new WorkspaceContentReviewError('invalid_action');
  return {
    ...annotation,
    replies: [...replies, { id: action.replyId, body: action.body, author: actor, createdAt: at, updatedAt: at }],
  };
}
