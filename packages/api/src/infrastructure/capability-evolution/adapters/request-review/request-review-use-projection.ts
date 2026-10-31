import { type ExactAssetVersionRefV1, type OwnerTruthRefV1, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import type {
  RequestReviewOwnerEvent,
  RequestReviewUseDispatchBoundEvent,
  RequestReviewUseRecordedEvent,
  RequestReviewUseReservationEvent,
} from './request-review-owner-ledger-contract.js';

export interface RequestReviewUseReceipt {
  receiptRef: OwnerTruthRefV1;
  assetVersionRef: ExactAssetVersionRefV1;
  invocationRef: OwnerTruthRefV1;
  consumerRef: OwnerTruthRefV1;
  use: 'applied' | 'dismissed' | 'unconfirmed';
  occurredAt: string;
}

export function reservationFor(events: readonly RequestReviewOwnerEvent[], id: string) {
  return events.find(
    (event): event is RequestReviewUseReservationEvent => event.type === 'use_reserved' && event.reservationId === id,
  );
}

export function bindingFor(events: readonly RequestReviewOwnerEvent[], id: string) {
  return events.find(
    (event): event is RequestReviewUseDispatchBoundEvent =>
      event.type === 'use_dispatch_bound' && event.reservationId === id,
  );
}

export function terminalFor(events: readonly RequestReviewOwnerEvent[], id: string) {
  return events.find(
    (event): event is RequestReviewUseRecordedEvent => event.type === 'use_recorded' && event.reservationId === id,
  );
}

export function receiptFrom(
  reservation: RequestReviewUseReservationEvent,
  binding: RequestReviewUseDispatchBoundEvent,
  terminal: RequestReviewUseRecordedEvent,
): RequestReviewUseReceipt {
  return {
    receiptRef: ownerTruthRefV1Schema.parse(terminal.proofRef),
    assetVersionRef: reservation.assetVersionRef,
    invocationRef: ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F299',
      ownerStateRef: `inv:${binding.reviewerInvocationId}`,
    }),
    consumerRef: ownerTruthRefV1Schema.parse(reservation.consumerRef),
    use: terminal.use,
    occurredAt: terminal.occurredAt,
  };
}
