// @ts-check
/**
 * F128 legacy pre-idempotency seed deduplication.
 *
 * These tests verify that proposal reconcile recognizes an existing child message
 * written before the `proposal-initial:<id>` idempotency-key index, does not
 * append a duplicate seed, and does not mistake an ordinary cross-post for a
 * legacy seed.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

function forceApprovedState(ctx, proposalId, createdThreadId) {
  // Simulate an already-approved proposal whose seed may or may not exist.
  const proposal = ctx.proposalStore.proposals.get(proposalId);
  assert.ok(proposal);
  proposal.status = 'approved';
  proposal.approvedBy = 'alice';
  proposal.approvedAt = Date.now();
  proposal.createdThreadId = createdThreadId;
  delete proposal.claimedAt;
}

async function createDispatchContext() {
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const invocationQueue = new InvocationQueue();
  return createProposalTestContext({
    routerOverride: {
      async resolveTargetsAndIntent() {
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
      },
    },
    invocationQueueOverride: invocationQueue,
  });
}

describe('F128 legacy seed deduplication', () => {
  test('legacy pre-idempotency seeds are deduped instead of duplicated', async () => {
    const ctx = await createDispatchContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Legacy seed', reason: 'Seed predates idempotency-key index' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = ctx.proposalStore.get(proposalId);
    assert.ok(proposal);

    const child = await ctx.threadStore.create('alice', 'Legacy child');
    forceApprovedState(ctx, proposalId, child.id);

    // Seed a legacy child message without the `proposal-initial:<id>` key.
    // It must carry proposal-specific evidence (source cat, source envelope
    // content, crossPost sourceThreadId) to be recognized as the seed.
    const legacySeedContent = '**来源**: Legacy seed\n\nSeed predates idempotency-key index';
    await ctx.messageStore.append({
      userId: 'alice',
      catId: proposal.sourceCatId,
      content: legacySeedContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: child.id,
      extra: { crossPost: { sourceThreadId: source.id, sourceMessageId: proposal.sourceMessageId } },
    });

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.equal(body.legacySeed, true);

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'must not append a second seed for a legacy pre-index seed');
    assert.equal(timeline[0].content, legacySeedContent);
  });

  test('legacy seed scan reaches beyond the most recent ten messages', async () => {
    const ctx = await createDispatchContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Deep legacy seed', reason: 'Seed is older than the default page size' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = ctx.proposalStore.get(proposalId);
    assert.ok(proposal);

    const child = await ctx.threadStore.create('alice', 'Legacy child');
    forceApprovedState(ctx, proposalId, child.id);

    const legacySeedContent = '**来源**: Deep legacy seed\n\nSeed is older than the default page size';
    await ctx.messageStore.append({
      userId: 'alice',
      catId: proposal.sourceCatId,
      content: legacySeedContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: child.id,
      extra: { crossPost: { sourceThreadId: source.id } },
    });

    // Push the seed outside any fixed "recent N" window.
    for (let i = 0; i < 15; i += 1) {
      await ctx.messageStore.append({
        userId: 'alice',
        catId: null,
        content: `filler message ${i}`,
        mentions: [],
        timestamp: Date.now() + i + 1,
        threadId: child.id,
      });
    }

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.equal(body.legacySeed, true);

    const timeline = await ctx.messageStore.getByThread(child.id, 100, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 16, 'must not append a second seed when the legacy seed is deep in history');
    assert.ok(timeline.some((m) => m.content === legacySeedContent));
  });

  test('ordinary cross-post from source thread is not mistaken for legacy seed', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Cross-post false positive', reason: 'crossPost.sourceThreadId alone must not dedupe' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = ctx.proposalStore.get(proposalId);
    assert.ok(proposal);

    const child = await ctx.threadStore.create('alice', 'Child');
    forceApprovedState(ctx, proposalId, child.id);

    // An unrelated cross-post that happens to share sourceThreadId but lacks the
    // proposal-specific source envelope content must not block seed reconciliation.
    await ctx.messageStore.append({
      userId: 'alice',
      catId: proposal.sourceCatId,
      content: 'Ordinary cross-post from source thread',
      mentions: [],
      timestamp: Date.now(),
      threadId: child.id,
      extra: { crossPost: { sourceThreadId: source.id } },
    });

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.notEqual(body.legacySeed, true, 'must not treat an ordinary cross-post as the proposal seed');

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 2, 'must append the real seed when the cross-post is not proposal-specific');
    assert.ok(timeline.some((m) => m.content.includes('**来源**: Cross-post false positive')));
    assert.ok(timeline.some((m) => m.content === 'Ordinary cross-post from source thread'));
  });
});
