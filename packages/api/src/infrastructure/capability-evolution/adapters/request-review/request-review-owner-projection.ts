import type { EvolutionResolvedAssetReviewV1 } from '@cat-cafe/shared';
import { type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import type {
  RequestReviewOwnerEvent,
  RequestReviewUseDispatchBoundEvent,
  RequestReviewUseReservationEvent,
} from './request-review-owner-ledger-contract.js';

type Selected = NonNullable<EvolutionResolvedAssetReviewV1['selected']>;
type EvidenceEvent = Extract<RequestReviewOwnerEvent, { type: 'evidence_linked' }>;

function sameVersion(left: ExactAssetVersionRefV1, right: ExactAssetVersionRefV1): boolean {
  return refIdentity(left) === refIdentity(right);
}

function useReservations(events: readonly RequestReviewOwnerEvent[]) {
  return new Map(
    events
      .filter((event): event is RequestReviewUseReservationEvent => event.type === 'use_reserved')
      .map((event) => [event.reservationId, event]),
  );
}

function useBindings(events: readonly RequestReviewOwnerEvent[]) {
  return new Map(
    events
      .filter((event): event is RequestReviewUseDispatchBoundEvent => event.type === 'use_dispatch_bound')
      .map((event) => [event.reservationId, event]),
  );
}

export function projectRequestReviewVersionFacts(
  events: readonly RequestReviewOwnerEvent[],
  versionRef: ExactAssetVersionRefV1,
): Pick<Selected, 'evidence' | 'uses'> {
  const evidence: Selected['evidence'] = events
    .filter(
      (event): event is EvidenceEvent =>
        event.type === 'evidence_linked' && sameVersion(event.assetVersionRef, versionRef),
    )
    .map((event) => ({
      role: event.role,
      assetVersionRef: event.assetVersionRef,
      evidenceRef: event.evidenceRef,
      proofRef: event.proofRef,
      status: event.status,
      ...(event.label ? { label: event.label } : {}),
    }))
    .slice(-128);
  const reservations = useReservations(events);
  const bindings = useBindings(events);
  const uses: Selected['uses'] = [];
  for (const event of events) {
    if (event.type !== 'use_recorded') continue;
    const reservation = reservations.get(event.reservationId);
    const binding = bindings.get(event.reservationId);
    if (!reservation || !binding || !sameVersion(reservation.assetVersionRef, versionRef)) continue;
    uses.push({
      receiptRef: event.proofRef,
      assetVersionRef: reservation.assetVersionRef,
      invocationRef: { ownerFeatureId: 'F299', ownerStateRef: `inv:${binding.reviewerInvocationId}` },
      consumerRef: reservation.consumerRef,
      use: event.use,
      occurredAt: event.occurredAt,
    });
  }
  return { evidence, uses: uses.slice(-128) };
}

export function hasRequestReviewAdoptionProof(
  events: readonly RequestReviewOwnerEvent[],
  versionRef: ExactAssetVersionRefV1,
): boolean {
  return events.some(
    (event) =>
      (event.type === 'intervention_changed' && sameVersion(event.assetVersionRef, versionRef)) ||
      (event.type === 'rollback_recorded' && sameVersion(event.restoredVersionRef, versionRef)),
  );
}

export function hasRequestReviewAppliedUse(
  events: readonly RequestReviewOwnerEvent[],
  versionRef: ExactAssetVersionRefV1,
): boolean {
  return projectRequestReviewVersionFacts(events, versionRef).uses.some((use) => use.use === 'applied');
}
