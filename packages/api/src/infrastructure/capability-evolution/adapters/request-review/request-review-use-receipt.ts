import { createHash, randomBytes } from 'node:crypto';
import { type ExactAssetVersionRefV1, ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../../../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { readDurableLocalReviewFact } from '../../../../domains/cats/services/local-review-artifact.js';
import type { IMessageStore } from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import {
  isRequestReviewAssetVersionRef,
  REQUEST_REVIEW_LOCAL_REVIEW_CONSUMER_REF,
} from './request-review-owner-identity.js';
import type {
  RequestReviewOwnerEvent,
  RequestReviewOwnerLedger,
  RequestReviewUseDispatchBoundEvent,
  RequestReviewUseRecordedEvent,
  RequestReviewUseReservationEvent,
} from './request-review-owner-ledger-contract.js';
import { bindingFor, receiptFrom, reservationFor, terminalFor } from './request-review-use-projection.js';

export interface RequestReviewUseScope {
  userId: string;
  threadId: string;
  invocationId: string;
  catId: string;
  ownerAuthProvenance?: InvocationRecord['ownerAuthProvenance'];
  originMessageId?: string;
}

interface ServiceOptions {
  ledger: RequestReviewOwnerLedger;
  messageStore: Pick<IMessageStore, 'getById'>;
  invocationRegistry: { peekRecord(invocationId: string): Promise<InvocationRecord | null> };
  versionAttestor: {
    deliver(
      ref: ExactAssetVersionRefV1,
      invocationId: string,
    ): Promise<{
      status: 'attested' | 'unconfirmed';
      deliveredAssetVersionRef?: ExactAssetVersionRefV1;
      deliveredPackageRevision?: string;
    }>;
  };
  now?: () => string;
  randomToken?: () => string;
}

function reservationId(handle: string): string {
  return createHash('sha256').update(handle).digest('hex');
}

function originMessageId(record: InvocationRecord): string | undefined {
  return record.originTriggerMessageId ?? record.a2aTriggerMessageId;
}

function streamInvocationId(message: Awaited<ReturnType<IMessageStore['getById']>>): string | undefined {
  return message?.extra?.stream?.turnInvocationId ?? message?.extra?.stream?.invocationId;
}

function matchesOwnerScope(reservation: RequestReviewUseReservationEvent, scope: RequestReviewUseScope): boolean {
  return (
    reservation.userId === scope.userId &&
    reservation.threadId === scope.threadId &&
    reservation.authorCatId === scope.catId
  );
}

function matchesLocalReview(
  message: Awaited<ReturnType<IMessageStore['getById']>>,
  reservation: RequestReviewUseReservationEvent,
  reviewerInvocationId: string,
): boolean {
  const fact = message ? readDurableLocalReviewFact(message) : null;
  return Boolean(
    message &&
      fact &&
      fact.threadId === reservation.threadId &&
      fact.reviewerCatId === reservation.reviewerCatId &&
      fact.reviewerCatId !== reservation.authorCatId &&
      fact.reviewSubjectRef === reservation.reviewSubjectRef &&
      fact.reviewedHeadSha === reservation.reviewedHeadSha &&
      fact.acceptedSourceRef === reservation.acceptedSourceRef &&
      fact.acceptedRevision === reservation.acceptedRevision &&
      streamInvocationId(message) === reviewerInvocationId,
  );
}

export class RequestReviewUseReceiptService {
  private readonly now: () => string;
  private readonly randomToken: () => string;

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async prepare(input: {
    scope: RequestReviewUseScope;
    assetVersionRef: ExactAssetVersionRefV1;
    reviewerCatId: string;
    reviewSubjectRef: string;
    reviewedHeadSha: string;
    acceptedSourceRef: string;
    acceptedRevision: string;
  }) {
    if (input.scope.ownerAuthProvenance !== 'strict' || !input.scope.originMessageId) {
      return { ok: false as const, reason: 'author_origin_unverified' as const };
    }
    if (input.scope.catId === input.reviewerCatId) return { ok: false as const, reason: 'self_review' as const };
    if (!isRequestReviewAssetVersionRef(input.assetVersionRef)) {
      return { ok: false as const, reason: 'invalid_asset_version' as const };
    }
    const handle = this.randomToken();
    const id = reservationId(handle);
    const event: RequestReviewUseReservationEvent = {
      schemaVersion: 1,
      eventId: `use-reservation:${id}`,
      type: 'use_reserved',
      occurredAt: this.now(),
      reservationId: id,
      assetVersionRef: input.assetVersionRef,
      userId: input.scope.userId,
      invocationId: input.scope.invocationId,
      threadId: input.scope.threadId,
      authorCatId: input.scope.catId,
      reviewerCatId: input.reviewerCatId,
      reviewSubjectRef: input.reviewSubjectRef,
      reviewedHeadSha: input.reviewedHeadSha,
      acceptedSourceRef: input.acceptedSourceRef,
      acceptedRevision: input.acceptedRevision,
      consumerRef: REQUEST_REVIEW_LOCAL_REVIEW_CONSUMER_REF,
    };
    const appended = await this.options.ledger.append(event);
    if (appended.outcome === 'idempotency_collision') {
      return { ok: false as const, reason: 'idempotency_collision' as const };
    }
    return {
      ok: true as const,
      preparation: { handle, assetVersionRef: event.assetVersionRef, consumerRef: event.consumerRef },
    };
  }

  async bindCurrentReviewer(input: { handle: string; scope: RequestReviewUseScope }) {
    const id = reservationId(input.handle);
    const events = await this.options.ledger.read();
    const reservation = reservationFor(events, id);
    if (!reservation) return { ok: false as const, reason: 'reservation_not_found' as const };
    if (
      reservation.userId !== input.scope.userId ||
      reservation.threadId !== input.scope.threadId ||
      reservation.reviewerCatId !== input.scope.catId
    ) {
      return { ok: false as const, reason: 'reservation_scope_mismatch' as const };
    }
    const invocation = await this.options.invocationRegistry.peekRecord(input.scope.invocationId);
    const requestMessageId = invocation ? originMessageId(invocation) : undefined;
    if (
      !invocation ||
      invocation.ownerAuthProvenance !== 'strict' ||
      invocation.userId !== reservation.userId ||
      invocation.threadId !== reservation.threadId ||
      invocation.catId !== reservation.reviewerCatId ||
      !requestMessageId
    ) {
      return { ok: false as const, reason: 'reviewer_invocation_mismatch' as const };
    }
    const requestMessage = await this.options.messageStore.getById(requestMessageId);
    const routedTargets = new Set([...(requestMessage?.extra?.targetCats ?? []), ...(requestMessage?.mentions ?? [])]);
    const requiredPacketLines = new Set([
      `Review-Subject-Ref: ${reservation.reviewSubjectRef}`,
      `Reviewed-Head-Sha: ${reservation.reviewedHeadSha}`,
      `Request-Review-Consumption-Handle: ${input.handle}`,
      `Accepted-Source-Ref: ${reservation.acceptedSourceRef}`,
      `Accepted-Revision: ${reservation.acceptedRevision}`,
    ]);
    const packetLines = new Set(requestMessage?.content.split('\n').map((line) => line.trim()) ?? []);
    if (
      !requestMessage ||
      requestMessage.threadId !== reservation.threadId ||
      requestMessage.catId !== reservation.authorCatId ||
      streamInvocationId(requestMessage) !== reservation.invocationId ||
      !routedTargets.has(reservation.reviewerCatId) ||
      [...requiredPacketLines].some((line) => !packetLines.has(line))
    ) {
      return { ok: false as const, reason: 'request_message_mismatch' as const };
    }
    const delivery = await this.options.versionAttestor.deliver(reservation.assetVersionRef, input.scope.invocationId);
    return this.appendReviewerBinding(id, requestMessageId, input.scope.invocationId, delivery, events);
  }

  private async appendReviewerBinding(
    id: string,
    requestMessageId: string,
    reviewerInvocationId: string,
    delivery: Awaited<ReturnType<ServiceOptions['versionAttestor']['deliver']>>,
    events: readonly RequestReviewOwnerEvent[],
  ) {
    const current = bindingFor(events, id);
    if (current) {
      return current.requestMessageId === requestMessageId && current.reviewerInvocationId === reviewerInvocationId
        ? { ok: true as const, outcome: 'duplicate' as const }
        : { ok: false as const, reason: 'idempotency_collision' as const };
    }
    const event: RequestReviewUseDispatchBoundEvent = {
      schemaVersion: 1,
      eventId: `use-dispatch:${id}`,
      type: 'use_dispatch_bound',
      occurredAt: this.now(),
      reservationId: id,
      requestMessageId,
      reviewerInvocationId,
      deliveryStatus: delivery.status,
      ...(delivery.deliveredAssetVersionRef ? { deliveredAssetVersionRef: delivery.deliveredAssetVersionRef } : {}),
      ...(delivery.deliveredPackageRevision ? { deliveredPackageRevision: delivery.deliveredPackageRevision } : {}),
      deliveryProofRef: ownerTruthRefV1Schema.parse({
        ownerFeatureId: 'F100',
        ownerStateRef: `request-review-delivery:${id}:${reviewerInvocationId}`,
      }),
    };
    const appended = await this.options.ledger.append(event);
    return appended.outcome === 'idempotency_collision'
      ? { ok: false as const, reason: 'idempotency_collision' as const }
      : { ok: true as const, outcome: appended.outcome === 'duplicate' ? ('duplicate' as const) : ('bound' as const) };
  }

  async recordLocalReview(input: { handle: string; scope: RequestReviewUseScope; reviewMessageId: string }) {
    const id = reservationId(input.handle);
    const events = await this.options.ledger.read();
    const reservation = reservationFor(events, id);
    if (!reservation) return { ok: false as const, reason: 'reservation_not_found' as const };
    const reviewerScope =
      input.scope.userId === reservation.userId &&
      input.scope.threadId === reservation.threadId &&
      input.scope.catId === reservation.reviewerCatId &&
      input.scope.invocationId === bindingFor(events, id)?.reviewerInvocationId;
    if (!matchesOwnerScope(reservation, input.scope) && !reviewerScope) {
      return { ok: false as const, reason: 'reservation_scope_mismatch' as const };
    }
    const binding = bindingFor(events, id);
    if (!binding) return { ok: false as const, reason: 'reviewer_invocation_unbound' as const };
    const existing = terminalFor(events, id);
    if (existing) {
      return existing.reviewMessageId === input.reviewMessageId
        ? { ok: true as const, outcome: 'duplicate' as const, receipt: receiptFrom(reservation, binding, existing) }
        : { ok: false as const, reason: 'idempotency_collision' as const };
    }
    const message = await this.options.messageStore.getById(input.reviewMessageId);
    if (!matchesLocalReview(message, reservation, binding.reviewerInvocationId)) {
      return { ok: false as const, reason: 'local_review_mismatch' as const };
    }
    const attested =
      binding.deliveryStatus === 'attested' &&
      binding.deliveredAssetVersionRef !== undefined &&
      refIdentity(binding.deliveredAssetVersionRef) === refIdentity(reservation.assetVersionRef);
    const proofRef = ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F100',
      ownerStateRef: `request-review-use:${id}:${input.reviewMessageId}`,
    });
    const event: RequestReviewUseRecordedEvent = {
      schemaVersion: 1,
      eventId: `use-terminal:${id}`,
      type: 'use_recorded',
      occurredAt: this.now(),
      reservationId: id,
      reviewMessageId: input.reviewMessageId,
      use: attested ? 'applied' : 'unconfirmed',
      proofRef,
    };
    const appended = await this.options.ledger.append(event);
    if (appended.outcome === 'idempotency_collision') {
      return { ok: false as const, reason: 'idempotency_collision' as const };
    }
    const terminal = appended.outcome === 'duplicate' ? terminalFor(await this.options.ledger.read(), id) : event;
    if (!terminal) throw new Error('request-review use receipt disappeared after append');
    return {
      ok: true as const,
      outcome: appended.outcome === 'duplicate' ? ('duplicate' as const) : ('recorded' as const),
      receipt: receiptFrom(reservation, binding, terminal),
    };
  }

  async dismiss(input: {
    handle: string;
    scope: RequestReviewUseScope;
    reason: 'outside_local_review_scope' | 'request_not_reviewable' | 'route_replaced';
  }) {
    const id = reservationId(input.handle);
    const events = await this.options.ledger.read();
    const reservation = reservationFor(events, id);
    const binding = bindingFor(events, id);
    if (!reservation) return { ok: false as const, reason: 'reservation_not_found' as const };
    if (!binding) return { ok: false as const, reason: 'reviewer_invocation_unbound' as const };
    if (
      input.scope.userId !== reservation.userId ||
      input.scope.threadId !== reservation.threadId ||
      input.scope.catId !== reservation.reviewerCatId ||
      input.scope.invocationId !== binding.reviewerInvocationId
    ) {
      return { ok: false as const, reason: 'reservation_scope_mismatch' as const };
    }
    const existing = terminalFor(events, id);
    if (existing) {
      return existing.use === 'dismissed' && existing.dismissalReason === input.reason
        ? { ok: true as const, outcome: 'duplicate' as const, receipt: receiptFrom(reservation, binding, existing) }
        : { ok: false as const, reason: 'idempotency_collision' as const };
    }
    const event: RequestReviewUseRecordedEvent = {
      schemaVersion: 1,
      eventId: `use-terminal:${id}`,
      type: 'use_recorded',
      occurredAt: this.now(),
      reservationId: id,
      use: 'dismissed',
      dismissalReason: input.reason,
      proofRef: ownerTruthRefV1Schema.parse({
        ownerFeatureId: 'F100',
        ownerStateRef: `request-review-use:${id}:dismissed`,
      }),
    };
    const appended = await this.options.ledger.append(event);
    if (appended.outcome === 'idempotency_collision') {
      return { ok: false as const, reason: 'idempotency_collision' as const };
    }
    return {
      ok: true as const,
      outcome: appended.outcome === 'duplicate' ? ('duplicate' as const) : ('recorded' as const),
      receipt: receiptFrom(reservation, binding, event),
    };
  }
}
