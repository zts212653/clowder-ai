import { expect, it } from 'vitest';
import {
  classifyFreshnessCarrierSupport,
  humanCarrierLabel,
  parseFreshnessCarrierCapability,
} from '../message-disposition-presentation';

const capability = {
  provider: 'anthropic',
  carrier: 'claude_agent_sdk',
  deliverySemantics: 'queued_internal_turn',
  activeInvocationGuidance: 'supported',
} as const;

it('keeps SDK current-invocation guidance separate from exact provider-turn read proof', () => {
  expect(parseFreshnessCarrierCapability(capability)).toEqual(capability);
  expect(classifyFreshnessCarrierSupport([capability])).toBe('queued');
  expect(humanCarrierLabel(capability)).toBe('支持引导当前运行（下一内部轮次，非精确同轮读取）');
});

it('fails closed for absent guidance declaration, unsupported adapters and unknown carriers', () => {
  const undeclared = {
    provider: capability.provider,
    carrier: capability.carrier,
    deliverySemantics: capability.deliverySemantics,
  };
  expect(parseFreshnessCarrierCapability(undeclared)).toBeUndefined();
  expect(classifyFreshnessCarrierSupport([undefined])).toBe('undeclared');
  expect(classifyFreshnessCarrierSupport([{ ...capability, activeInvocationGuidance: 'unsupported' }])).toBe(
    'unsupported',
  );
  expect(parseFreshnessCarrierCapability({ ...capability, carrier: 'unregistered-carrier' })).toBeUndefined();
});
