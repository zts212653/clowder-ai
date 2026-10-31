import { createHash } from 'node:crypto';
import { RECALL_OPPORTUNITY_CATALOG_VERSION, type RecallScopeV1 } from '@cat-cafe/shared';
import type { MemoryCueEpisodeStore } from '../cue/MemoryCueEpisodeStore.js';

export const NATIVE_CAPSULE_ANCHOR = 'profile:opening-capsule';
export interface NativeProfileOpeningDelivery {
  scope: RecallScopeV1;
  consumerCatId: string;
  sourceRevision: string;
  requestGenerationId: string;
  observedAt: number;
}

/** Existing delivery ledger projection after F299 observes the exact native request. */
export function recordNativeProfileOpening(
  store: Pick<MemoryCueEpisodeStore, 'append'>,
  delivery: NativeProfileOpeningDelivery,
) {
  const id = createHash('sha256')
    .update(
      JSON.stringify([delivery.scope, delivery.consumerCatId, delivery.requestGenerationId, delivery.sourceRevision]),
    )
    .digest('hex');
  store.append({
    eventId: `native-profile-${id}`,
    idempotencyKey: `native-profile-${id}`,
    cueId: `native-profile-${id}`,
    opportunityId: `native-profile-${delivery.requestGenerationId}`,
    scope: delivery.scope,
    consumerCatId: delivery.consumerCatId,
    resolverFamily: 'profile',
    sourceAnchor: NATIVE_CAPSULE_ANCHOR,
    sourceRevision: delivery.sourceRevision,
    catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
    resolverVersion: 3,
    axis: 'consumption',
    consumptionOutcome: 'presented',
    occurredAt: delivery.observedAt,
  });
}
