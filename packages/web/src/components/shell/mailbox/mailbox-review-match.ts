import {
  type ArtifactReviewView,
  type UnifiedAttentionItemV1,
  unifiedAttentionWorkSourceSchema,
} from '@cat-cafe/shared';
import { isRecord } from './work-detail';

/** Exact source coordinates, never a substitute for the original owner-auth read. */
export interface MailboxReviewSource {
  ownerUserId: string;
  reviewId: string;
  reviewRevision: number;
  taskRef: string;
  taskRevision: number;
}

export function sameMailboxReviewSource(a: MailboxReviewSource, b: MailboxReviewSource): boolean {
  return (
    a.ownerUserId === b.ownerUserId &&
    a.reviewId === b.reviewId &&
    a.reviewRevision === b.reviewRevision &&
    a.taskRef === b.taskRef &&
    a.taskRevision === b.taskRevision
  );
}

export function readMailboxReviewSource(item: UnifiedAttentionItemV1, ownerUserId: string): MailboxReviewSource | null {
  if (item.kind !== 'judgment') return null;
  const entries: unknown[] = Array.isArray(item.linkedNeedsMe) ? item.linkedNeedsMe : [];
  const candidates = entries.filter(
    (entry) =>
      isRecord(entry) &&
      isRecord(entry.receipt) &&
      isRecord(entry.receipt.producer) &&
      entry.receipt.producer.producerId === 'f309.content_review',
  );
  // Multiple copies are not an authority choice for the browser to make.
  if (candidates.length !== 1) return null;
  const entry = candidates[0];
  if (!isRecord(entry) || !isRecord(entry.ownerRead)) return null;
  const parsed = unifiedAttentionWorkSourceSchema.safeParse({
    ownerReads: [{ ...entry.ownerRead, attentionReceipts: [entry.receipt] }],
  });
  if (!parsed.success) return null;
  const ownerRead = parsed.data.ownerReads[0];
  const receipt = ownerRead.attentionReceipts[0];
  const { producer, taskRef, action } = receipt;
  if (
    !receipt.eligible ||
    receipt.kind !== 'judgment' ||
    item.decisionRef !== `f309.content_review:${producer.subjectRef}` ||
    ownerRead.envelope.visibility.ownerUserId !== ownerUserId ||
    ownerRead.envelope.subjectRef !== taskRef.subjectRef ||
    ownerRead.envelope.revision !== taskRef.observedRevision ||
    ownerRead.envelope.freshness?.state !== 'current' ||
    ownerRead.envelope.freshness.observedRevision !== taskRef.observedRevision ||
    action?.actionRef !== `content-review:${producer.subjectRef}` ||
    action.expectedProducerRevision !== producer.revision
  )
    return null;
  return {
    ownerUserId,
    reviewId: producer.subjectRef,
    reviewRevision: producer.revision,
    taskRef: taskRef.subjectRef,
    taskRevision: taskRef.observedRevision,
  };
}

export function matchesMailboxReview(source: MailboxReviewSource, view: ArtifactReviewView): boolean {
  const { review, authority } = view;
  const latest = review.rounds.at(-1);
  return (
    review.reviewId === source.reviewId &&
    review.revision === source.reviewRevision &&
    review.task.ownerUserId === source.ownerUserId &&
    `task:work:${review.task.taskId}` === source.taskRef &&
    review.task.observedRevision === source.taskRevision &&
    authority.taskRevision === source.taskRevision &&
    authority.state === 'current' &&
    authority.canWrite &&
    !view.pendingVersion &&
    latest?.state === 'awaiting_human' &&
    Boolean(latest.judgmentRequest) &&
    !latest.attentionRetiredReason
  );
}
