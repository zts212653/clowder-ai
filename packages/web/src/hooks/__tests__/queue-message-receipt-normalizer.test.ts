import {
  FRESHNESS_CARRIER_DELIVERY_SEMANTICS,
  FRESHNESS_CARRIER_PROVIDERS,
  FRESHNESS_CARRIERS,
} from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';

import { normalizeQueueMessageReceiptProjections } from '../queue-message-receipt-normalizer';

describe('normalizeQueueMessageReceiptProjections', () => {
  const agyCapability = {
    provider: 'google',
    carrier: 'agy_stream_json',
    deliverySemantics: 'queued_internal_turn',
  };

  function normalizeCarrierReceipt(carrierCapability: unknown) {
    return normalizeQueueMessageReceiptProjections([
      {
        messageId: 'queued-agy-source',
        queueReceipt: {
          version: 1,
          entryId: 'queued-agy-entry',
          reminderAttempts: [],
          targets: [
            {
              catId: 'gemini38',
              state: 'seen',
              seenAt: 2_000,
              authorIntent: {
                requested: 'continue_current',
                effective: 'next_work',
                fallbackReason: 'unsupported_carrier',
                carrierCapability,
              },
            },
          ],
        },
      },
    ])[0]?.queueReceipt.targets;
  }

  it('preserves the native AGY receipt target and its honest next-work fallback', () => {
    expect(normalizeCarrierReceipt(agyCapability)).toEqual([
      expect.objectContaining({
        catId: 'gemini38',
        state: 'seen',
        seenAt: 2_000,
        authorIntent: expect.objectContaining({
          requested: 'continue_current',
          effective: 'next_work',
          fallbackReason: 'unsupported_carrier',
          carrierCapability: agyCapability,
        }),
      }),
    ]);
  });

  it.each([
    ...FRESHNESS_CARRIER_PROVIDERS.map((provider) => ({ ...agyCapability, provider })),
    ...FRESHNESS_CARRIERS.map((carrier) => ({ ...agyCapability, carrier })),
    ...FRESHNESS_CARRIER_DELIVERY_SEMANTICS.map((deliverySemantics) => ({ ...agyCapability, deliverySemantics })),
  ])('preserves every shared carrier enum through receipt hydration: %j', (capability) => {
    expect(normalizeCarrierReceipt(capability)?.[0]?.authorIntent?.carrierCapability).toEqual(capability);
  });

  it.each([
    { ...agyCapability, provider: 'unregistered-provider' },
    { ...agyCapability, carrier: 'unregistered-carrier' },
    { ...agyCapability, deliverySemantics: 'unregistered-delivery' },
  ])('still drops a receipt target with an unknown carrier field: %j', (capability) => {
    expect(normalizeCarrierReceipt(capability)).toEqual([]);
  });

  it('preserves exact dispatch event evidence without converting it to child success', () => {
    const evidenceRef = {
      kind: 'dispatch_disposition',
      invocationId: 'original-live',
      sourceMessageId: 'source',
      handoffEventId: 'route:source:codex-sol',
      dispositionEventId: 'dispatch-disposition:original-live:source',
      disposition: 'handled',
      dispositionAt: 2000,
    };
    const projection = normalizeQueueMessageReceiptProjections([
      {
        messageId: 'source',
        queueReceipt: {
          version: 1,
          entryId: 'entry',
          reminderAttempts: [],
          targets: [
            {
              catId: 'codex-sol',
              state: 'handled',
              outcome: {
                invocationId: 'original-live',
                disposition: 'dispatch_disposition',
                evidenceRef,
                handledAt: 2100,
              },
            },
          ],
        },
      },
    ]);
    expect(projection[0]?.queueReceipt.targets[0]?.outcome?.evidenceRef).toEqual(evidenceRef);
    expect(projection[0]?.queueReceipt.targets[0]?.outcome?.disposition).toBe('dispatch_disposition');
  });
  it('preserves terminal TurnExecution evidence without upgrading it to visible lineage', () => {
    const projections = normalizeQueueMessageReceiptProjections([
      {
        messageId: 'message-terminal-no-lineage',
        queueReceipt: {
          version: 1,
          entryId: 'entry-terminal-no-lineage',
          targets: [
            {
              catId: 'codex-sol',
              state: 'handled',
              invocationId: 'turn-terminal-no-lineage',
              outcome: {
                invocationId: 'turn-terminal-no-lineage',
                disposition: 'completed_with_turn',
                evidenceRef: { kind: 'turn_execution', invocationId: 'turn-terminal-no-lineage' },
                handledAt: 2_000,
              },
            },
          ],
          reminderAttempts: [],
        },
      },
    ]);

    expect(projections[0]?.queueReceipt.targets[0]?.outcome?.evidenceRef).toEqual({
      kind: 'turn_execution',
      invocationId: 'turn-terminal-no-lineage',
    });
  });

  it('preserves the typed runtime-restart interruption receipt from Queue History', () => {
    const projections = normalizeQueueMessageReceiptProjections([
      {
        messageId: 'message-1',
        queueReceipt: {
          version: 1,
          entryId: 'entry-1',
          targets: [
            {
              catId: 'codex-sol',
              state: 'interrupted',
              invocationId: 'invocation-1',
              attempts: [
                {
                  id: 'entry-1:codex-sol:1',
                  targetCatId: 'codex-sol',
                  sequence: 1,
                  state: 'interrupted',
                  invocationId: 'invocation-1',
                  terminalReason: 'runtime_restart',
                  createdAt: 1_000,
                  updatedAt: 2_000,
                },
              ],
            },
          ],
          reminderAttempts: [],
        },
      },
    ]);

    expect(projections).toHaveLength(1);
    expect(projections[0]?.queueReceipt.targets).toEqual([
      expect.objectContaining({
        catId: 'codex-sol',
        state: 'interrupted',
        attempts: [
          expect.objectContaining({
            state: 'interrupted',
            terminalReason: 'runtime_restart',
          }),
        ],
      }),
    ]);
  });
});
