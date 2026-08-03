/**
 * F128 requester withdrawal — cat-authenticated pending -> withdrawn lifecycle.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

async function proposed(ctx, { userId = 'alice', catId = 'opus' } = {}) {
  const source = await ctx.threadStore.create(userId, 'Source');
  const response = await ctx.propose({ userId, catId, threadId: source.id });
  assert.equal(response.statusCode, 200);
  return { source, proposalId: response.json().proposalId };
}

describe('F128 requester withdraw', () => {
  test('the exact requester withdraws a pending proposal with durable audit and one update event', async () => {
    const ctx = await createProposalTestContext();
    const { source, proposalId } = await proposed(ctx);
    ctx.socketEvents.length = 0;

    const response = await ctx.withdraw({ userId: 'alice', catId: 'opus', threadId: source.id, proposalId });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { proposalId, status: 'withdrawn' });
    const stored = await ctx.proposalStore.get(proposalId);
    assert.equal(stored.status, 'withdrawn');
    assert.equal(stored.withdrawnBy, 'opus');
    assert.ok(Number.isFinite(stored.withdrawnAt));
    assert.equal(
      (await ctx.proposalStore.listPending('alice')).some((item) => item.proposalId === proposalId),
      false,
    );
    assert.equal(ctx.socketEvents.filter((event) => event.event === 'proposal_updated').length, 1);
    assert.equal(ctx.socketEvents.find((event) => event.event === 'proposal_updated').data.status, 'withdrawn');
  });

  test('same-requester retry is idempotent and does not emit a second update', async () => {
    const ctx = await createProposalTestContext();
    const { source, proposalId } = await proposed(ctx);
    ctx.socketEvents.length = 0;
    await ctx.withdraw({ userId: 'alice', catId: 'opus', threadId: source.id, proposalId });
    const first = await ctx.proposalStore.get(proposalId);

    const replay = await ctx.withdraw({ userId: 'alice', catId: 'opus', threadId: source.id, proposalId });

    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), { proposalId, status: 'withdrawn', deduped: true });
    const second = await ctx.proposalStore.get(proposalId);
    assert.equal(second.withdrawnAt, first.withdrawnAt);
    assert.equal(ctx.socketEvents.filter((event) => event.event === 'proposal_updated').length, 1);
  });

  test('withdrawn proposals fail closed for later user approve and reject decisions', async () => {
    const ctx = await createProposalTestContext();
    const { source, proposalId } = await proposed(ctx);
    await ctx.withdraw({ userId: 'alice', catId: 'opus', threadId: source.id, proposalId });

    const approve = await ctx.approve('alice', proposalId);
    const reject = await ctx.reject('alice', proposalId);

    assert.equal(approve.statusCode, 409);
    assert.deepEqual(approve.json(), { error: 'Proposal withdrawn by requester', status: 'withdrawn' });
    assert.equal(reject.statusCode, 409);
    assert.deepEqual(reject.json(), { error: 'Proposal withdrawn by requester', status: 'withdrawn' });
    assert.equal((await ctx.proposalStore.get(proposalId)).status, 'withdrawn');
  });

  test('concurrent transport retries return one canonical success and one deduped success', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    const proposalStore = new InMemoryProposalStore();
    const withdrawPending = proposalStore.withdrawPending.bind(proposalStore);
    let arrivals = 0;
    let releaseBoth;
    const bothAtCas = new Promise((resolve) => {
      releaseBoth = resolve;
    });
    proposalStore.withdrawPending = async (input) => {
      arrivals += 1;
      if (arrivals === 2) releaseBoth();
      await bothAtCas;
      return withdrawPending(input);
    };

    const ctx = await createProposalTestContext({ proposalStoreOverride: proposalStore });
    const { source, proposalId } = await proposed(ctx);
    ctx.socketEvents.length = 0;
    const origin = await ctx.messageStore.append({
      userId: 'alice',
      catId: null,
      content: `Withdraw thread proposal ${proposalId}`,
      mentions: [],
      timestamp: Date.now(),
      threadId: source.id,
    });
    const { invocationId, callbackToken } = await ctx.registry.create('alice', 'opus', source.id, undefined, origin.id);
    const retry = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/callbacks/withdraw-thread-proposal',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { proposalId },
      });

    const responses = await Promise.all([retry(), retry()]);

    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [200, 200],
    );
    assert.deepEqual(
      responses
        .map((response) => response.json())
        .sort((left, right) => Number(Boolean(left.deduped)) - Number(Boolean(right.deduped))),
      [
        { proposalId, status: 'withdrawn' },
        { proposalId, status: 'withdrawn', deduped: true },
      ],
    );
    assert.equal(ctx.socketEvents.filter((event) => event.event === 'proposal_updated').length, 1);
  });

  test('a different cat cannot withdraw the requester proposal', async () => {
    const ctx = await createProposalTestContext();
    const { source, proposalId } = await proposed(ctx);

    const response = await ctx.withdraw({ userId: 'alice', catId: 'codex', threadId: source.id, proposalId });

    assert.equal(response.statusCode, 403);
    assert.equal((await ctx.proposalStore.get(proposalId)).status, 'pending');
  });

  test('the same cat under another user cannot withdraw the proposal', async () => {
    const ctx = await createProposalTestContext();
    const { proposalId } = await proposed(ctx);
    const foreignThread = await ctx.threadStore.create('bob', 'Foreign');

    const response = await ctx.withdraw({ userId: 'bob', catId: 'opus', threadId: foreignThread.id, proposalId });

    assert.equal(response.statusCode, 403);
    assert.equal((await ctx.proposalStore.get(proposalId)).status, 'pending');
  });

  test('approve and withdraw race has one winner and never leaves an orphan thread', async () => {
    const ctx = await createProposalTestContext();
    const { source, proposalId } = await proposed(ctx);
    const threadsBefore = ctx.threadStore.size;

    const [approve, withdraw] = await Promise.all([
      ctx.approve('alice', proposalId),
      ctx.withdraw({ userId: 'alice', catId: 'opus', threadId: source.id, proposalId }),
    ]);

    assert.deepEqual([approve.statusCode, withdraw.statusCode].sort(), [200, 409]);
    const stored = await ctx.proposalStore.get(proposalId);
    assert.ok(stored.status === 'approved' || stored.status === 'withdrawn');
    assert.equal(ctx.threadStore.size, threadsBefore + (stored.status === 'approved' ? 1 : 0));
    assert.equal(Boolean(stored.withdrawnAt), stored.status === 'withdrawn');
  });

  test('reject and withdraw race has one terminal decision and preserves its distinct audit', async () => {
    const ctx = await createProposalTestContext();
    const { source, proposalId } = await proposed(ctx);

    const [reject, withdraw] = await Promise.all([
      ctx.reject('alice', proposalId),
      ctx.withdraw({ userId: 'alice', catId: 'opus', threadId: source.id, proposalId }),
    ]);

    assert.deepEqual([reject.statusCode, withdraw.statusCode].sort(), [200, 409]);
    const stored = await ctx.proposalStore.get(proposalId);
    assert.ok(stored.status === 'rejected' || stored.status === 'withdrawn');
    assert.equal(Boolean(stored.rejectedAt), stored.status === 'rejected');
    assert.equal(Boolean(stored.withdrawnAt), stored.status === 'withdrawn');
  });

  test('approving, approved, and rejected proposals fail closed', async () => {
    for (const target of ['approving', 'approved', 'rejected']) {
      const ctx = await createProposalTestContext();
      const { source, proposalId } = await proposed(ctx);
      if (target === 'approving') {
        await ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
      } else if (target === 'approved') {
        await ctx.approve('alice', proposalId);
      } else {
        await ctx.reject('alice', proposalId);
      }

      const response = await ctx.withdraw({ userId: 'alice', catId: 'opus', threadId: source.id, proposalId });

      assert.equal(response.statusCode, 409, target);
      assert.equal((await ctx.proposalStore.get(proposalId)).status, target);
    }
  });

  test('an unanchored staged proposal cannot be withdrawn', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const proposal = await ctx.proposalStore.create({
      sourceThreadId: source.id,
      sourceInvocationId: 'inv-staged',
      sourceCatId: 'opus',
      sourceMessageId: 'msg-staged',
      title: 'Staged',
      reason: 'Not published',
      parentThreadId: source.id,
      preferredCats: [],
      projectPath: 'default',
      createdBy: 'alice',
    });

    const response = await ctx.withdraw({
      userId: 'alice',
      catId: 'opus',
      threadId: source.id,
      proposalId: proposal.proposalId,
    });

    assert.equal(response.statusCode, 409);
    assert.equal((await ctx.proposalStore.get(proposal.proposalId)).status, 'pending');
  });
});
