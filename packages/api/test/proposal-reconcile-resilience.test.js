// @ts-check
/**
 * F128 proposal reconcile resilience.
 *
 * These tests verify that seed reconciliation degrades safely when transient
 * storage reads fail, rather than risking duplicate seeds or silent omissions.
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

describe('F128 reconcile resilience', () => {
  test('reconcile skips append when seed-existence reads fail', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Failing dedupe reads', reason: 'Cannot establish seed existence safely' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const child = await ctx.threadStore.create('alice', 'Child');
    forceApprovedState(ctx, proposalId, child.id);

    const originalGetByIdempotencyKey = ctx.messageStore.getByIdempotencyKey.bind(ctx.messageStore);
    ctx.messageStore.getByIdempotencyKey = async (...args) => {
      if (args[2] === `proposal-initial:${proposalId}`) {
        throw new Error('simulated transient dedupe read failure');
      }
      return originalGetByIdempotencyKey(...args);
    };

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.ok(body.warnings?.some((w) => w.includes('cannot verify proposal seed existence')));

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 0, 'must not append a seed when existence cannot be verified safely');
  });

  test('reconcile survives a transient source-thread title lookup failure', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Failing source title lookup', reason: 'Title lookup must be best-effort' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const child = await ctx.threadStore.create('alice', 'Child');
    forceApprovedState(ctx, proposalId, child.id);

    const originalGet = ctx.threadStore.get.bind(ctx.threadStore);
    ctx.threadStore.get = async (id) => {
      if (id === source.id) {
        throw new Error('simulated transient source-thread get failure');
      }
      return originalGet(id);
    };

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'seed must be reconciled even when source-thread title lookup fails');
    assert.ok(timeline[0].content.includes('Failing source title lookup'));
  });
});
