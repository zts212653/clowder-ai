import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

const boundary = {
  review: {
    lastCommentCursor: 0,
    lastInlineCommentCursor: 0,
    lastConversationCommentCursor: 0,
    lastDecisionCursor: 0,
  },
  ci: {
    headSha: 'abc123',
    lastBucket: 'pending',
  },
};

async function proposeFormal(ctx, source, preferredCats = ['opus']) {
  const response = await ctx.propose({
    userId: 'alice',
    threadId: source.id,
    body: {
      title: 'Formal exact-HEAD review for clowder-ai PR #1210',
      reason: 'Review https://github.com/zts212653/clowder-ai/pull/1210 in an owner child.',
      initialMessage: 'Perform an independent exact-HEAD review; findings return to the external author.',
      preferredCats,
    },
  });
  assert.equal(response.statusCode, 200);
  return JSON.parse(response.body).proposalId;
}

describe('F128 → F140 formal external PR transition', () => {
  test('approved single-owner review child gets canonical metadata and owner-valid actor-aware tracking', async () => {
    const ctx = await createProposalTestContext({
      fetchPrTrackingBoundaryOverride: async () => boundary,
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeFormal(ctx, source);

    const approved = await ctx.approve('alice', proposalId);
    assert.equal(approved.statusCode, 200);
    const { threadId, warnings } = JSON.parse(approved.body);
    assert.equal(
      (warnings ?? []).some((warning) => /formal PR/i.test(warning)),
      false,
    );

    assert.deepEqual(await ctx.threadStore.getThreadMetadata(threadId), {
      v: 1,
      prs: [{ repo: 'zts212653/clowder-ai', number: 1210 }],
    });
    assert.deepEqual((await ctx.threadStore.get(threadId)).preferredCats, ['opus']);
    assert.equal((await ctx.taskStore.listByThread(source.id)).length, 0);

    const task = await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210');
    assert.ok(task);
    assert.equal(task.threadId, threadId);
    assert.equal(task.ownerCatId, 'opus');
    assert.equal(task.kind, 'pr_tracking');
    assert.equal(task.status, 'todo');
    assert.equal(task.userId, 'alice');
    assert.equal(task.automationState.intent, 'review');
    assert.equal(task.automationState.wakePolicy, 'human_participant_activity');
    assert.deepEqual(task.automationState.review, boundary.review);
    assert.deepEqual(task.automationState.ci, boundary.ci);
  });

  test('zero or multiple approved owners preserve metadata but fail closed without assigning a tracker', async () => {
    for (const preferredCats of [[], ['opus', 'codex']]) {
      const ctx = await createProposalTestContext({
        fetchPrTrackingBoundaryOverride: async () => boundary,
      });
      const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
      const proposalId = await proposeFormal(ctx, source, preferredCats);

      const approved = await ctx.approve('alice', proposalId);
      assert.equal(approved.statusCode, 200);
      const { threadId, warnings } = JSON.parse(approved.body);
      assert.ok(warnings.some((warning) => /exactly one.*owner/i.test(warning)));
      assert.deepEqual(await ctx.threadStore.getThreadMetadata(threadId), {
        v: 1,
        prs: [{ repo: 'zts212653/clowder-ai', number: 1210 }],
      });
      assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
    }
  });

  test('advisory and arbitrary URL proposals create neither PR metadata nor tracking', async () => {
    for (const reason of [
      'Advisory discussion of https://github.com/zts212653/clowder-ai/pull/1210.',
      'Keep https://github.com/zts212653/clowder-ai/pull/1210 as reference material.',
    ]) {
      const ctx = await createProposalTestContext({
        fetchPrTrackingBoundaryOverride: async () => boundary,
      });
      const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
      const response = await ctx.propose({
        userId: 'alice',
        threadId: source.id,
        body: { title: 'Community context', reason, preferredCats: ['opus'] },
      });
      const approved = await ctx.approve('alice', JSON.parse(response.body).proposalId);
      const { threadId } = JSON.parse(approved.body);

      assert.equal(await ctx.threadStore.getThreadMetadata(threadId), null);
      assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
    }
  });

  test('duplicate approval retries reconciliation and preserves one active task with monotonic cursors', async () => {
    let attempts = 0;
    const ctx = await createProposalTestContext({
      fetchPrTrackingBoundaryOverride: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary GitHub outage');
        return boundary;
      },
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeFormal(ctx, source);

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    assert.ok(JSON.parse(first.body).warnings.some((warning) => /boundary/i.test(warning)));
    assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);

    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    assert.equal(JSON.parse(second.body).deduped, true);
    const task = await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210');
    assert.ok(task);
    const originalId = task.id;

    await ctx.taskStore.patchAutomationState(task.id, {
      review: { lastInlineCommentCursor: 42 },
    });
    await ctx.taskStore.update(task.id, { status: 'doing' });
    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const reconciled = await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210');
    assert.equal(reconciled.id, originalId);
    assert.equal(reconciled.status, 'doing', 'external-author repair custody must keep the active tracker');
    assert.equal(reconciled.automationState.review.lastInlineCommentCursor, 42);
    assert.equal((await ctx.taskStore.listByKind('pr_tracking')).length, 1);
  });

  test('stale approval recovery reconciles the already-created formal child without duplicating it', async () => {
    const ctx = await createProposalTestContext({
      fetchPrTrackingBoundaryOverride: async () => boundary,
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeFormal(ctx, source);
    ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
    const orphanedThread = await ctx.threadStore.create('alice', 'Recovered formal review', 'default');
    ctx.proposalStore.recordCreatedThread(proposalId, orphanedThread.id);
    ctx.proposalStore.proposals.get(proposalId).claimedAt = Date.now() - 60_000;
    const countBefore = ctx.threadStore.size;

    const recovered = await ctx.approve('alice', proposalId);
    assert.equal(recovered.statusCode, 200);
    assert.equal(JSON.parse(recovered.body).recovered, true);
    assert.equal(ctx.threadStore.size, countBefore);
    assert.deepEqual(await ctx.threadStore.getThreadMetadata(orphanedThread.id), {
      v: 1,
      prs: [{ repo: 'zts212653/clowder-ai', number: 1210 }],
    });
    assert.deepEqual((await ctx.threadStore.get(orphanedThread.id)).preferredCats, ['opus']);
    const task = await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210');
    assert.equal(task.threadId, orphanedThread.id);
    assert.equal(task.ownerCatId, 'opus');
  });

  test('stale reject recovery finalizes and reconciles an already-created formal child', async () => {
    const ctx = await createProposalTestContext({
      fetchPrTrackingBoundaryOverride: async () => boundary,
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeFormal(ctx, source);
    ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
    const orphanedThread = await ctx.threadStore.create('alice', 'Recovered formal review', 'default');
    ctx.proposalStore.recordCreatedThread(proposalId, orphanedThread.id);
    ctx.proposalStore.proposals.get(proposalId).claimedAt = Date.now() - 60_000;

    const recovered = await ctx.reject('alice', proposalId);
    assert.equal(recovered.statusCode, 409);
    assert.equal(JSON.parse(recovered.body).status, 'approved');
    assert.deepEqual(await ctx.threadStore.getThreadMetadata(orphanedThread.id), {
      v: 1,
      prs: [{ repo: 'zts212653/clowder-ai', number: 1210 }],
    });
    assert.deepEqual((await ctx.threadStore.get(orphanedThread.id)).preferredCats, ['opus']);
    const task = await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210');
    assert.equal(task.threadId, orphanedThread.id);
    assert.equal(task.ownerCatId, 'opus');
  });

  test('does not steal an existing subject owned by another user', async () => {
    const ctx = await createProposalTestContext({
      fetchPrTrackingBoundaryOverride: async () => boundary,
    });
    await ctx.taskStore.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey: 'pr:zts212653/clowder-ai#1210',
      threadId: 'thread-bob',
      ownerCatId: 'codex',
      title: 'Bob tracker',
      why: 'Different user owns this subject',
      createdBy: 'codex',
      userId: 'bob',
      automationState: boundary,
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeFormal(ctx, source);

    const approved = await ctx.approve('alice', proposalId);
    assert.equal(approved.statusCode, 200);
    assert.ok(JSON.parse(approved.body).warnings.some((warning) => /ownership conflict/i.test(warning)));
    const task = await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210');
    assert.equal(task.threadId, 'thread-bob');
    assert.equal(task.ownerCatId, 'codex');
    assert.equal(task.userId, 'bob');
  });
});
