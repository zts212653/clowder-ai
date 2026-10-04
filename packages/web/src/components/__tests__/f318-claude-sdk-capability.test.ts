import { expect, it } from 'vitest';
import { normalizeQueueMessageReceiptProjections } from '../../hooks/queue-message-receipt-normalizer';
import {
  classifyFreshnessCarrierSupport,
  humanCarrierLabel,
  parseFreshnessCarrierCapability,
} from '../message-disposition-presentation';

const capability = {
  provider: 'anthropic',
  carrier: 'claude_agent_sdk',
  deliverySemantics: 'queued_internal_turn',
} as const;

it('recognizes SDK capability while keeping precise current-turn support unavailable', () => {
  expect(parseFreshnessCarrierCapability(capability)).toEqual(capability);
  expect(classifyFreshnessCarrierSupport([capability])).toBe('unsupported');
  expect(humanCarrierLabel(capability)).toBe('排队内部轮次（非精确读取）');
  expect(parseFreshnessCarrierCapability({ ...capability, carrier: 'unregistered-carrier' })).toBeUndefined();
});

it('preserves SDK capability and independently observed read evidence during receipt hydration', () => {
  const normalized = normalizeQueueMessageReceiptProjections([
    {
      messageId: 'source-message',
      queueReceipt: {
        version: 1,
        entryId: 'entry',
        reminderAttempts: [],
        targets: [
          {
            catId: 'opus',
            state: 'seen',
            invocationId: 'primary',
            seenAt: 1000,
            authorIntent: { requested: 'next_work', effective: 'next_work', carrierCapability: capability },
          },
        ],
      },
    },
  ]);
  expect(normalized[0]?.queueReceipt.targets[0]?.authorIntent?.carrierCapability).toEqual(capability);
  expect(normalized[0]?.queueReceipt.targets[0]?.seenAt).toBe(1000);
});
