import { describe, expect, it } from 'vitest';

import { normalizeQueueMessageReceiptProjections } from '../queue-message-receipt-normalizer';

describe('normalizeQueueMessageReceiptProjections', () => {
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
