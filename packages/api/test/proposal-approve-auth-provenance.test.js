// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F275 proposal approval owner-auth provenance', () => {
  test('trusted-browser compatibility approval stays compatibility_fallback on the queued carrier', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const ctx = await createProposalTestContext({
      routerOverride: {
        async resolveTargetsAndIntent() {
          return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
        },
      },
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: {
        async processNext() {
          return { started: true };
        },
      },
    });
    const source = await ctx.threadStore.create('default-user', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'default-user',
          threadId: source.id,
          body: { initialMessage: 'Start from the approved proposal', preferredCats: ['opus'] },
        })
      ).body,
    );

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/approve`,
      headers: { origin: 'http://localhost:3003', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(response.statusCode, 200);
    const { threadId } = JSON.parse(response.body);
    const [entry] = invocationQueue.list(threadId, 'default-user');
    assert.equal(entry.ownerAuthProvenance, 'compatibility_fallback');
  });
});
