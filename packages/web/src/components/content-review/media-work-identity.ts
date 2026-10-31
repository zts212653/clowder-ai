import type { MediaContextAttachment } from '@cat-cafe/shared';
import { type MediaChatTarget, sameMediaSource } from './media-chat-selection';

function taskWithForwardReview(
  previous: MediaContextAttachment['taskContext'],
  next: MediaContextAttachment['taskContext'],
): MediaContextAttachment['taskContext'] {
  if (!previous || !next || next.expectedReviewRevision <= previous.expectedReviewRevision) return previous;
  return { ...previous, expectedReviewRevision: next.expectedReviewRevision };
}

/** Review-only advancement leaves the immutable content and Task/round identity intact. */
export function sameMediaContentWithAdvancedReview(previous: MediaContextAttachment, target: MediaChatTarget): boolean {
  if (previous.mediaType !== target.mediaType) return false;
  const source = previous.source;
  const next = target.source;
  if (source.kind === 'publication' && next.kind === 'publication') {
    const taskContext = taskWithForwardReview(previous.taskContext, target.taskContext);
    return (
      next.expectedLedgerRevision > source.expectedLedgerRevision &&
      sameMediaSource(
        {
          ...previous,
          source: { ...source, expectedLedgerRevision: next.expectedLedgerRevision },
          ...(taskContext ? { taskContext } : {}),
        },
        target,
      )
    );
  }
  if ('expectedReviewRevision' in source && 'expectedReviewRevision' in next) {
    const task = previous.taskContext;
    const taskContext =
      source.kind === 'artifact-review' &&
      next.kind === 'artifact-review' &&
      task?.reviewId === source.reviewId &&
      task.round === source.round &&
      task.expectedReviewRevision === source.expectedReviewRevision
        ? { ...task, expectedReviewRevision: next.expectedReviewRevision }
        : task;
    return (
      next.expectedReviewRevision > source.expectedReviewRevision &&
      sameMediaSource(
        {
          ...previous,
          source: { ...source, expectedReviewRevision: next.expectedReviewRevision },
          ...(taskContext ? { taskContext } : {}),
        },
        target,
      )
    );
  }
  return false;
}
