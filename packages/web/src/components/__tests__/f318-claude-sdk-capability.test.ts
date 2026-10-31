import { parseFreshnessCarrierCapability, supportsActiveInvocationGuidance } from '@cat-cafe/shared';
import { expect, it } from 'vitest';

const capability = {
  provider: 'anthropic',
  carrier: 'claude_agent_sdk',
  deliverySemantics: 'queued_internal_turn',
  activeInvocationGuidance: 'supported',
} as const;

it('SDK guidance capability does not claim exact provider-turn reading', () => {
  const parsed = parseFreshnessCarrierCapability(capability);
  expect(parsed).toEqual(capability);
  expect(supportsActiveInvocationGuidance(parsed)).toBe(true);
  expect(parsed?.deliverySemantics).toBe('queued_internal_turn');
});

it('rejects absent guidance declaration and unknown carriers, and respects declared unsupported guidance', () => {
  const undeclared = {
    provider: capability.provider,
    carrier: capability.carrier,
    deliverySemantics: capability.deliverySemantics,
  };
  expect(parseFreshnessCarrierCapability(undeclared)).toBeUndefined();
  expect(supportsActiveInvocationGuidance(undefined)).toBe(false);
  expect(supportsActiveInvocationGuidance({ ...capability, activeInvocationGuidance: 'unsupported' })).toBe(false);
  expect(parseFreshnessCarrierCapability({ ...capability, carrier: 'unregistered-carrier' })).toBeUndefined();
});
