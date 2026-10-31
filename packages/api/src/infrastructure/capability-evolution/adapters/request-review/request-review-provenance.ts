import { createHash } from 'node:crypto';
import { readDurableLocalReviewFact } from '../../../../domains/cats/services/local-review-artifact.js';
import {
  canonicalGrowingSourceJson,
  deriveGrowingSourceMessageRevision,
  type IMessageStore,
  type StoredMessage,
} from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import type {
  RequestReviewOwnerLedger,
  RequestReviewUseReservationEvent,
} from './request-review-owner-ledger-contract.js';
import { bindingFor, reservationFor } from './request-review-use-projection.js';

export interface RecordedReviewQuery {
  userId: string;
  threadId: string;
  authorCatId: string;
  reviewMessageId: string;
}
export interface RecordedReviewProof {
  revision: string;
  recordedAt: number;
}

function original(message: StoredMessage | null, query: RecordedReviewQuery): message is StoredMessage {
  return (
    !!message &&
    message.userId === query.userId &&
    message.threadId === query.threadId &&
    !message.deletedAt &&
    !message._tombstone &&
    !message.source
  );
}

function invocation(message: StoredMessage) {
  return message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId;
}

function matchesRequestPacket(request: StoredMessage, reservation: RequestReviewUseReservationEvent): boolean {
  const lines = new Set(request.content.split('\n').map((line) => line.trim()));
  const handles = [...lines].filter((line) => line.startsWith('Request-Review-Consumption-Handle: '));
  const [handleLine] = handles;
  return (
    handles.length === 1 &&
    handleLine !== undefined &&
    createHash('sha256').update(handleLine.slice('Request-Review-Consumption-Handle: '.length)).digest('hex') ===
      reservation.reservationId &&
    lines.has(`Review-Subject-Ref: ${reservation.reviewSubjectRef}`) &&
    lines.has(`Reviewed-Head-Sha: ${reservation.reviewedHeadSha}`) &&
    lines.has(`Accepted-Source-Ref: ${reservation.acceptedSourceRef}`) &&
    lines.has(`Accepted-Revision: ${reservation.acceptedRevision}`)
  );
}

/** Read only server-written reservation/binding/receipt events; a verdict alone is not provenance. */
export async function readRecordedRequestReview(
  ledger: Pick<RequestReviewOwnerLedger, 'read'>,
  messages: Pick<IMessageStore, 'getById'>,
  query: RecordedReviewQuery,
): Promise<RecordedReviewProof | null> {
  const review = await messages.getById(query.reviewMessageId);
  if (!original(review, query)) return null;
  const fact = readDurableLocalReviewFact(review);
  if (!fact) return null;
  const events = await ledger.read();
  for (const recorded of events) {
    if (recorded.type !== 'use_recorded' || recorded.use === 'dismissed' || recorded.reviewMessageId !== review.id)
      continue;
    const reservation = reservationFor(events, recorded.reservationId);
    const binding = bindingFor(events, recorded.reservationId);
    if (
      !reservation ||
      !binding ||
      reservation.userId !== query.userId ||
      reservation.threadId !== query.threadId ||
      reservation.authorCatId !== query.authorCatId ||
      reservation.reviewerCatId === query.authorCatId ||
      reservation.reviewerCatId !== fact.reviewerCatId ||
      reservation.reviewSubjectRef !== fact.reviewSubjectRef ||
      reservation.reviewedHeadSha !== fact.reviewedHeadSha ||
      reservation.acceptedSourceRef !== fact.acceptedSourceRef ||
      reservation.acceptedRevision !== fact.acceptedRevision ||
      invocation(review) !== binding.reviewerInvocationId
    )
      continue;
    const request = await messages.getById(binding.requestMessageId);
    if (
      !original(request, query) ||
      request.catId !== query.authorCatId ||
      invocation(request) !== reservation.invocationId ||
      ![...request.mentions, ...(request.extra?.targetCats ?? [])].includes(reservation.reviewerCatId)
    )
      continue;
    if (!matchesRequestPacket(request, reservation)) continue;
    const order = [
      Date.parse(reservation.occurredAt),
      request.timestamp,
      Date.parse(binding.occurredAt),
      review.timestamp,
      Date.parse(recorded.occurredAt),
    ];
    if (order.some((value, index) => !Number.isFinite(value) || value < (order[index - 1] ?? Number.NEGATIVE_INFINITY)))
      continue;
    return {
      recordedAt: Date.parse(recorded.occurredAt),
      revision: `sha256:${createHash('sha256')
        .update(
          canonicalGrowingSourceJson({
            reservation,
            binding,
            recorded,
            requestRevision: deriveGrowingSourceMessageRevision(request),
          }),
        )
        .digest('hex')}`,
    };
  }
  return null;
}
