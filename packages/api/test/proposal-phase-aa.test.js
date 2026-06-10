// @ts-check
/**
 * F128 Phase AA — source attribution + crossPost metadata in seed message.
 *
 * Covers:
 *   AC-AA4: Seed message catId = proposal.sourceCatId (not null / not approver)
 *   AC-AA5: Seed message extra.crossPost = { sourceThreadId, sourceInvocationId }
 *   AC-AA1: Default reportingMode is now 'final-only' (header-level, validated
 *           in proposal-enrich-header.test.js; this file validates dispatch
 *           passes it through correctly).
 *
 * Split from proposal-approve-dispatch.test.js to honor AC-X1 ≤350-line cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 Phase AA — seed message source attribution', () => {
  test('AC-AA4: seed message catId = sourceCatId (proposing cat, not approver)', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext() {
        return { started: true };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    // Cat 'codex' proposes, user 'alice' approves
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Discussing architecture', preferredCats: ['opus'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.ok(entries.length > 0, 'message was enqueued');
    const stored = await ctx.messageStore.getById(entries[0].messageId);

    // AC-AA4: the seed message author should be the proposing cat, not the approver
    assert.equal(
      stored.catId,
      'codex',
      'AC-AA4: seed message catId must be proposal.sourceCatId (codex), not null or the approving user',
    );
  });

  test('AC-AA5: seed message has extra.crossPost with sourceThreadId + sourceInvocationId', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext() {
        return { started: true };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source Thread');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Research task', preferredCats: ['opus'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    const entries = invocationQueue.list(body.threadId, 'alice');
    const stored = await ctx.messageStore.getById(entries[0].messageId);

    // AC-AA5: crossPost metadata for frontend pill + jump-to-source
    assert.ok(stored.extra?.crossPost, 'AC-AA5: seed message must have extra.crossPost');
    assert.equal(
      stored.extra.crossPost.sourceThreadId,
      source.id,
      'AC-AA5: crossPost.sourceThreadId must match the source thread',
    );
    assert.ok(
      stored.extra.crossPost.sourceInvocationId,
      'AC-AA5: crossPost.sourceInvocationId must be present (from proposal)',
    );
  });

  test('AC-AA4 fallback: no-router path still attributes to source cat', async () => {
    // When router/invocationQueue/queueProcessor are unavailable (fallback path),
    // the seed message must still carry sourceCatId attribution.
    const ctx = await createProposalTestContext({
      // No router/queue overrides → hits the fallback path in dispatch
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Quick note', preferredCats: ['opus'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // In fallback path, message is stored directly (no invocationQueue)
    // so we need to look it up from the thread's messages
    const messages = await ctx.messageStore.getByThread(body.threadId, 10);
    const seedMsg = messages.find((m) => m.content.includes('Quick note'));
    assert.ok(seedMsg, 'seed message must exist in the thread');
    assert.equal(
      seedMsg.catId,
      'codex',
      'AC-AA4 fallback: even without router, seed message catId must be sourceCatId',
    );
    assert.ok(
      seedMsg.extra?.crossPost?.sourceThreadId,
      'AC-AA5 fallback: crossPost metadata must be present even in fallback path',
    );
  });
});
