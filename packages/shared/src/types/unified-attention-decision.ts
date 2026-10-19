import { collectiveAccountabilityAttentionItemSchema } from './collective-accountability-attention.js';
import { entrustedWorkOwnerReadV1Schema } from './entrusted-work-owner-read.js';
import type { ProducerAttentionReceiptV1 } from './growing.js';
import type { UnifiedAttentionItemV1, UnifiedAttentionReceipt } from './unified-attention.js';

/** One decision-membership contract for API counts and Web row grouping. */
export function isUnifiedAttentionDecision(item: UnifiedAttentionItemV1): boolean {
  return (
    item.approval?.resolution === 'open' ||
    item.runtimeInteraction !== undefined ||
    item.choiceRequest !== undefined ||
    exactCollectiveAccountabilityDecision(item) ||
    exactCollectiveResultDecision(item) ||
    exactContentReviewDecision(item)
  );
}

function exactCollectiveAccountabilityDecision(item: UnifiedAttentionItemV1): boolean {
  if (item.kind !== 'judgment' || !item.collectiveAccountabilityRequest || item.linkedNeedsMe.length !== 0)
    return false;
  const parsed = collectiveAccountabilityAttentionItemSchema.safeParse(item.collectiveAccountabilityRequest);
  return Boolean(
    parsed.success &&
      item.decisionRef === `${parsed.data.producerId}:${parsed.data.subjectRef}` &&
      !item.approval &&
      !item.runtimeInteraction &&
      !item.choiceRequest,
  );
}

function exactCollectiveResultDecision(item: UnifiedAttentionItemV1): boolean {
  if (item.kind !== 'judgment') return false;
  return item.linkedNeedsMe.some(({ ownerRead, receipt }) => {
    const parsedOwnerRead = entrustedWorkOwnerReadV1Schema.safeParse(ownerRead);
    if (!parsedOwnerRead.success || !receipt.eligible) return false;
    const { producer, taskRef, action } = receipt;
    return Boolean(
      receipt.kind === 'judgment' &&
        producer.producerId === 'f290.collective_work_result' &&
        producer.ownerRef === producer.subjectRef &&
        Number.isInteger(producer.revision) &&
        producer.revision > 0 &&
        item.decisionRef === `${producer.producerId}:${producer.subjectRef}` &&
        receipt.reasonCode === 'collective_result_ready' &&
        action?.expectedProducerRevision === producer.revision &&
        exactCollectiveResultAction(action?.actionRef, producer.subjectRef, producer.revision) &&
        receipt.reEvaluateActionRef === `${producer.subjectRef}#reevaluate` &&
        taskRef.subjectRef === ownerRead.envelope.subjectRef &&
        taskRef.observedRevision === ownerRead.envelope.revision &&
        ownerRead.envelope.freshness?.state === 'current' &&
        ownerRead.envelope.freshness.observedRevision === ownerRead.envelope.revision &&
        parsedOwnerRead.data.attentionReceipts.some((candidate) => sameEligibleReceipt(candidate, receipt)),
    );
  });
}

function sameEligibleReceipt(candidate: ProducerAttentionReceiptV1, receipt: UnifiedAttentionReceipt): boolean {
  return Boolean(
    candidate.eligible &&
      receipt.eligible &&
      candidate.kind === receipt.kind &&
      candidate.reasonCode === receipt.reasonCode &&
      candidate.recommendation === receipt.recommendation &&
      candidate.salience === receipt.salience &&
      candidate.producer.producerId === receipt.producer.producerId &&
      candidate.producer.ownerRef === receipt.producer.ownerRef &&
      candidate.producer.subjectRef === receipt.producer.subjectRef &&
      candidate.producer.revision === receipt.producer.revision &&
      candidate.taskRef.subjectRef === receipt.taskRef.subjectRef &&
      candidate.taskRef.observedRevision === receipt.taskRef.observedRevision &&
      candidate.action.actionRef === receipt.action?.actionRef &&
      candidate.action.expectedProducerRevision === receipt.action?.expectedProducerRevision &&
      candidate.reEvaluateActionRef === receipt.reEvaluateActionRef,
  );
}

function exactCollectiveResultAction(actionRef: string | undefined, subjectRef: string, revision: number): boolean {
  const subject = /^collective-result:(con_[A-Za-z0-9_-]+):(work_[A-Za-z0-9_-]+)$/u.exec(subjectRef);
  if (!actionRef || !subject?.[1] || !subject[2] || !URL.canParse(actionRef, 'https://cat-cafe.invalid')) return false;
  const url = new URL(actionRef, 'https://cat-cafe.invalid');
  const allowed = ['connectionId', 'workId', 'workRevision', 'channelId', 'resultEventId', 'resultRevision'];
  const channelId = url.searchParams.get('channelId');
  const resultEventId = url.searchParams.get('resultEventId');
  const resultRevision = Number(url.searchParams.get('resultRevision'));
  return Boolean(
    actionRef.startsWith('/collective?') &&
      url.origin === 'https://cat-cafe.invalid' &&
      url.pathname === '/collective' &&
      !url.hash &&
      [...url.searchParams.keys()].every((key) => allowed.includes(key)) &&
      allowed.every((key) => url.searchParams.getAll(key).length === 1) &&
      url.searchParams.get('connectionId') === subject[1] &&
      url.searchParams.get('workId') === subject[2] &&
      url.searchParams.get('workRevision') === String(revision) &&
      resultEventId !== null &&
      /^evt_[A-Za-z0-9_-]+$/u.test(resultEventId) &&
      channelId !== null &&
      channelId.length > 0 &&
      channelId.length <= 160 &&
      channelId.trim() === channelId &&
      Number.isSafeInteger(resultRevision) &&
      resultRevision > 0 &&
      String(resultRevision) === url.searchParams.get('resultRevision'),
  );
}

function exactContentReviewDecision(item: UnifiedAttentionItemV1): boolean {
  if (item.kind !== 'judgment') return false;
  return item.linkedNeedsMe.some(({ ownerRead, receipt }) => {
    const { producer, taskRef, action } = receipt;
    const ownerRef = `content-review:${producer.subjectRef}`;
    return Boolean(
      receipt.eligible &&
        receipt.kind === 'judgment' &&
        producer.producerId === 'f309.content_review' &&
        producer.ownerRef === ownerRef &&
        Number.isInteger(producer.revision) &&
        producer.revision > 0 &&
        receipt.reasonCode === 'content_review_requested' &&
        action?.actionRef === ownerRef &&
        action.expectedProducerRevision === producer.revision &&
        receipt.reEvaluateActionRef === `${ownerRef}#reevaluate` &&
        taskRef.subjectRef === ownerRead.envelope.subjectRef &&
        taskRef.observedRevision === ownerRead.envelope.revision &&
        ownerRead.envelope.freshness?.state === 'current' &&
        ownerRead.envelope.freshness.observedRevision === ownerRead.envelope.revision,
    );
  });
}
