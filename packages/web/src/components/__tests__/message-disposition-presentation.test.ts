import {
  FRESHNESS_CARRIER_DELIVERY_SEMANTICS,
  FRESHNESS_CARRIER_PROVIDERS,
  FRESHNESS_CARRIERS,
} from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';

import {
  classifyFreshnessCarrierSupport,
  humanCarrierLabel,
  parseFreshnessCarrierCapability,
} from '../message-disposition-presentation';

describe('native AGY freshness presentation', () => {
  const agyCapability = {
    provider: 'google',
    carrier: 'agy_stream_json',
    deliverySemantics: 'queued_internal_turn',
  };

  it('recognizes the declared AGY transport without enabling exact current-turn reads', () => {
    const parsed = parseFreshnessCarrierCapability(agyCapability);
    expect(parsed).toEqual(agyCapability);
    expect(classifyFreshnessCarrierSupport([parsed])).toBe('unsupported');
    expect(humanCarrierLabel(parsed)).toBe('排队内部轮次（非精确读取）');
  });

  it.each([
    ...FRESHNESS_CARRIER_PROVIDERS.map((provider) => ({ ...agyCapability, provider })),
    ...FRESHNESS_CARRIERS.map((carrier) => ({ ...agyCapability, carrier })),
    ...FRESHNESS_CARRIER_DELIVERY_SEMANTICS.map((deliverySemantics) => ({ ...agyCapability, deliverySemantics })),
  ])('parses every shared carrier enum at the presentation boundary: %j', (capability) => {
    expect(parseFreshnessCarrierCapability(capability)).toEqual(capability);
  });

  it.each([
    { ...agyCapability, provider: 'unregistered-provider' },
    { ...agyCapability, carrier: 'unregistered-carrier' },
    { ...agyCapability, deliverySemantics: 'unregistered-delivery' },
  ])('keeps unknown carrier values undeclared: %j', (capability) => {
    const parsed = parseFreshnessCarrierCapability(capability);
    expect(parsed).toBeUndefined();
    expect(classifyFreshnessCarrierSupport([parsed])).toBe('undeclared');
    expect(humanCarrierLabel(parsed)).toBe('能力未声明');
  });
});
