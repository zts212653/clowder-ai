import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScheduleMutationCardBlock } from '../../dist/routes/schedule-mutation-card-block.js';
import { createProposal, NOW, task } from './schedule-proposal-decision-fixture.js';

describe('schedule mutation approval card', () => {
  it('shows an approval-relative delay instead of the proposal-time fireAt', () => {
    const delayMs = 600_000;
    const proposal = createProposal({
      proposalId: 'schedule-card-relative-once',
      mutation: {
        kind: 'create',
        task: task({ trigger: { type: 'once', fireAt: NOW + delayMs } }),
        relativeOnceDelayMs: delayMs,
      },
    });

    const block = buildScheduleMutationCardBlock(proposal);
    const triggerField = block.fields?.find((field) => field.label === 'Trigger');

    assert.equal(triggerField?.value, JSON.stringify({ type: 'once', delayMs, relativeTo: 'approval' }));
    assert.doesNotMatch(triggerField?.value ?? '', /fireAt/);
  });
});
