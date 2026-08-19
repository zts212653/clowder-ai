import { type DeliveryDecisionCueCarrierV1, deliveryDecisionCueCarrierV1Schema } from '@cat-cafe/shared';
import type { MemoryCueOpportunitySeed } from './MemoryCueInvocationPromptService.js';

export { deliveryDecisionCueCarrierV1Schema };
export type { DeliveryDecisionCueCarrierV1 };

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
