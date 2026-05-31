/**
 * F128 Proposal Flow — concurrency + stale-claim recovery tests.
 * Split from proposal-flow.test.js to keep each file under the 350-line hard limit (AC-X1).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 concurrency + stale-claim recovery', () => {
  test('concurrent approve + reject leaves no orphan thread', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class SlowApprovalStore extends InMemoryProposalStore {
      async claimForApproval(input) {
        const claimed = super.claimForApproval(input);
        await new Promise((r) => setTimeout(r, 30));
        return claimed;
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new SlowApprovalStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const threadsBefore = ctx.threadStore.size;
    const [approveRes, rejectRes] = await Promise.all([
      ctx.approve('alice', proposalId),
      new Promise((r) => setTimeout(r, 5)).then(() => ctx.reject('alice', proposalId)),
    ]);
    assert.equal(approveRes.statusCode, 200);
    assert.equal(rejectRes.statusCode, 409);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'approved');
    assert.equal(ctx.threadStore.size, threadsBefore + 1);
  });

  test('reject wins over approve when reject claims first (no orphan thread)', async () => {
    const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
    class SlowApprovalStore extends InMemoryProposalStore {
      async claimForApproval(input) {
        await new Promise((r) => setTimeout(r, 30));
        return super.claimForApproval(input);
      }
    }
    const ctx = await createProposalTestContext({ proposalStoreOverride: new SlowApprovalStore() });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const threadsBefore = ctx.threadStore.size;
    const [approveRes, rejectRes] = await Promise.all([
      ctx.approve('alice', proposalId),
      ctx.reject('alice', proposalId),
    ]);
    assert.equal(rejectRes.statusCode, 200);
    assert.equal(approveRes.statusCode, 409);
    assert.equal(ctx.threadStore.size, threadsBefore, 'reject must not create any thread');
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'rejected');
  });

  test('approving status with stale claim is auto-recovered on next approve', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
    let proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'approving');
    assert.ok(proposal.claimedAt);
    ctx.proposalStore.proposals.get(proposalId).claimedAt = Date.now() - 60_000;
    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
    proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'approved');
    assert.ok(proposal.createdThreadId);
  });

  test('stale claim with createdThreadId recovers via finalize (no duplicate thread)', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
    const orphanedThread = await ctx.threadStore.create('alice', 'Recovered', 'default');
    ctx.proposalStore.recordCreatedThread(proposalId, orphanedThread.id);
    ctx.proposalStore.proposals.get(proposalId).claimedAt = Date.now() - 60_000;
    const threadCountBefore = ctx.threadStore.size;
    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
    assert.equal(body.threadId, orphanedThread.id);
    assert.equal(body.recovered, true);
    assert.equal(ctx.threadStore.size, threadCountBefore, 'must not create a second thread');
  });

  test('reject on stale-claim with createdThreadId refuses (thread already exists)', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
    const orphanedThread = await ctx.threadStore.create('alice', 'Recovered', 'default');
    ctx.proposalStore.recordCreatedThread(proposalId, orphanedThread.id);
    ctx.proposalStore.proposals.get(proposalId).claimedAt = Date.now() - 60_000;
    const res = await ctx.reject('alice', proposalId);
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
    assert.equal(body.threadId, orphanedThread.id);
    const finalProposal = await ctx.proposalStore.get(proposalId);
    assert.equal(finalProposal.status, 'approved');
  });
});
