import {
  type CatOwnedSeedCueCarrierV1,
  catOwnedSeedCueCarrierV1Schema,
  type DeliveryDecisionCueCarrierV1,
  deliveryDecisionCueCarrierV1Schema,
} from '@cat-cafe/shared';
import type { MemoryCueOpportunitySeed } from './MemoryCueInvocationPromptService.js';

export { catOwnedSeedCueCarrierV1Schema, deliveryDecisionCueCarrierV1Schema };
export type { CatOwnedSeedCueCarrierV1, DeliveryDecisionCueCarrierV1 };

export function deliveryDecisionSeedFromTrustedCarrier(
  value: unknown,
  sourceMessageId: string,
): Extract<MemoryCueOpportunitySeed, { kind: 'delivery_decision' }> | null {
  const parsed = deliveryDecisionCueCarrierV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const { occurredAt, v: _v, producer: _producer, producerProvenance: _provenance, ...payload } = parsed.data;
  return {
    kind: 'delivery_decision',
    producer: 'github_ci',
    occurredAt,
    payload: { ...payload, sourceMessageId },
  };
}

export function catOwnedSeedSeedFromTrustedCarrier(
  value: unknown,
  sourceMessageId: string,
  expectedTargetCatIds: readonly string[],
): Extract<MemoryCueOpportunitySeed, { kind: 'owned_seed_available' }> | null {
  const parsed = catOwnedSeedCueCarrierV1Schema.safeParse(value);
  if (!parsed.success || !expectedTargetCatIds.includes(parsed.data.producingCatId)) return null;
  const { occurredAt, v: _v, producer: _producer, producerProvenance: _provenance, ...payload } = parsed.data;
  return {
    kind: 'owned_seed_available',
    producer: 'present_loop',
    occurredAt,
    payload: { ...payload, sourceMessageId },
  };
}
