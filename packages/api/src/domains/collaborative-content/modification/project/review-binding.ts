import type { ContentModificationRecord } from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../../workspace-review/errors.js';
import { applyProjectReviewAction } from '../../workspace-review/video-project-review-actions.js';
import { modificationOperationKeys } from '../journal.js';
import type { ProjectMessageTakeoverDeps } from './types.js';

/** One Cat acknowledgement on the already imported opinions, atomic with journal binding on the same SQLite DB. */
export function bindProjectTakeoverReview(deps: ProjectMessageTakeoverDeps, record: ContentModificationRecord) {
  const source = record.payload.source;
  if (
    source.kind !== 'video-project' ||
    !record.progress.task ||
    !record.progress.sourceMessageId ||
    !record.progress.sourceMessageRevision
  )
    throw new WorkspaceContentReviewError('invalid_action');
  const review = deps.store.ledgers.get(source.reviewId);
  if (!review) throw new WorkspaceContentReviewError('not_found');
  const operationId = modificationOperationKeys(record.requestId).request;
  const actor = { kind: 'cat' as const, actorId: record.payload.targetCatId };
  const existing = deps.store.ledgers.operationReceipt(source.reviewId, operationId);
  const mutation = {
    reviewId: source.reviewId,
    expectedRevision: existing ? existing.revision - 1 : review.revision,
    operationId,
    actor,
    now: new Date().toISOString(),
    kind: 'takeover:video-project',
    request: {
      requestId: record.requestId,
      sourceMessageId: record.progress.sourceMessageId,
      taskId: record.progress.task.taskId,
      annotationIds: source.annotationIds,
    },
    preparationSource: {
      kind: 'human_message' as const,
      threadId: record.payload.threadId,
      messageId: record.progress.sourceMessageId,
      messageRevision: record.progress.sourceMessageRevision,
    },
  };
  const result =
    deps.store.ledgers.replay(mutation) ??
    deps.store.ledgers.mutate(mutation, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: mutation.now,
      annotations: current.annotations.map((annotation) =>
        source.annotationIds.includes(annotation.id)
          ? applyProjectReviewAction(
              annotation,
              {
                kind: 'replied',
                annotationId: annotation.id,
                replyId: `${record.requestId}:${annotation.id}`,
                body: '已接下这条审片修改。',
              },
              actor,
              mutation.now,
              operationId,
            )
          : annotation,
      ),
    }));
  return { reviewId: source.reviewId, receiptRef: result.receipt.receiptRef };
}
