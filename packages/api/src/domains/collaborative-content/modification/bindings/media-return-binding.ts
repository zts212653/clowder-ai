import type { ContentModificationRecord, TurnExecutionRecord } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ContentReturnIntent, ReviewReturnIntent } from '../../artifact-review/return-store.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import { type ContentModificationJournal, modificationMessageRequestId } from '../journal.js';

/** A media outbox can name Human only through the same committed journal and canonical review receipt. */
export function isBoundMediaModificationReturn(
  store: Pick<ArtifactReviewStore, 'reviewReceipt'> | undefined,
  record: ContentModificationRecord | null | undefined,
  intent: ContentReturnIntent | null | undefined,
): intent is ReviewReturnIntent {
  if (
    !store ||
    !record ||
    !intent ||
    (intent.kind !== 'request_image_edit' &&
      intent.kind !== 'request_media_edit' &&
      intent.kind !== 'supersede_request')
  )
    return false;
  const prepared = record.progress.prepared;
  const receipt = store.reviewReceipt(intent.reviewId, intent.receiptRef);
  return Boolean(
    prepared?.kind === 'media' &&
      record.progress.sourceMessageId &&
      record.requestId === intent.requestId &&
      record.ownerUserId === intent.ownerUserId &&
      record.payload.threadId === intent.threadId &&
      record.payload.targetCatId === intent.targetCatId &&
      record.progress.task?.taskId === intent.taskId &&
      record.progress.task.revision === intent.expectedTaskRevision &&
      record.progress.review?.reviewId === intent.reviewId &&
      record.progress.review.round === intent.round &&
      record.progress.review.receiptRef === intent.receiptRef &&
      prepared.contentRef === intent.contentRef &&
      prepared.ownerRevision === intent.ownerRevision &&
      receipt?.receiptRef === intent.receiptRef &&
      receipt.revision === intent.reviewRevision,
  );
}

/** Exact causal/outbox bindings, including retired requests; never infer an image's request from one open Task. */
export async function hasUniqueMediaProducerRequest(
  deps: {
    requests: Pick<ContentModificationJournal, 'get'>;
    messages: Pick<IMessageStore, 'getById'>;
    producer: (record: ContentModificationRecord) => Promise<TurnExecutionRecord | undefined>;
  },
  record: ContentModificationRecord,
  child: TurnExecutionRecord,
): Promise<boolean> {
  if ((await deps.producer(record))?.invocationId !== child.invocationId) return false;
  const bound = new Set([record.requestId]);
  const causes = new Set([child.causal?.triggerMessageId, ...(child.causal?.coveredMessageIds ?? [])]);
  for (const id of causes) {
    if (!id) continue;
    let candidate = deps.requests.get(modificationMessageRequestId(record.ownerUserId, id), record.ownerUserId);
    if (!candidate) {
      const message = await deps.messages.getById(id);
      const requestId = message?.source?.meta?.requestId ?? message?.extra?.contentModificationRequestV1?.requestId;
      if (typeof requestId === 'string') candidate = deps.requests.get(requestId, record.ownerUserId);
    }
    if (
      candidate?.progress.prepared?.kind === 'media' &&
      (await deps.producer(candidate))?.invocationId === child.invocationId
    )
      bound.add(candidate.requestId);
  }
  return bound.size === 1;
}
