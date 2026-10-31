import { createHash } from 'node:crypto';
import type { RoutingAdmissionProvenanceV1, RoutingQueueAdmissionReceiptV1 } from '@cat-cafe/shared';

type ObservedTarget = RoutingQueueAdmissionReceiptV1['targets'][number];

function factsRef(target: Pick<ObservedTarget, 'availabilityObservation' | 'capacityFacts' | 'reasons'>): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        availability: target.availabilityObservation,
        currentCapacity: target.capacityFacts?.current ?? null,
        reasonCodes: [...new Set(target.reasons.map((reason) => reason.code))].sort(),
      }),
    )
    .digest('hex')}`;
}

export function routingAdmissionProvenance(receipt: RoutingQueueAdmissionReceiptV1): RoutingAdmissionProvenanceV1 {
  return {
    stage: 'queue_admitted',
    observedAt: receipt.observedAt,
    ...(receipt.snapshotRef ? { snapshotRef: receipt.snapshotRef } : {}),
    targets: receipt.targets.map((target) => ({ targetCatId: target.targetCatId, factsRef: factsRef(target) })),
  };
}
