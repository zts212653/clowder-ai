// @ts-check
/**
 * F128 proposal seed materialization.
 *
 * These tests cover how source content blocks are preserved into the child seed
 * and how a missing seed is repaired exactly once after a transient dispatch
 * failure.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 proposal seed materialization', () => {
  test('carries structured content blocks from the source message into the child seed', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const ctx = await createProposalTestContext({
      invocationQueueOverride: new InvocationQueue(),
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const contentBlocks = [
      {
        type: 'file',
        url: 'https://example.com/fix.patch',
        fileName: 'fix.patch',
        mimeType: 'text/x-diff',
        fileSize: 123,
      },
    ];

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Patch review', reason: 'Please review the attached patch.' },
      originContentBlocks: contentBlocks,
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.ok(proposal.sourceMessageId, 'proposal must record the source message id');

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes('Patch review'), 'seed text must include title');
    assert.deepEqual(seed.contentBlocks, contentBlocks, 'seed must preserve source message content blocks losslessly');
    assert.ok(
      seed.content.includes(proposal.sourceMessageId),
      'seed text must expose the exact sourceMessageId so the child can dereference it',
    );
  });

  test('preserves source content blocks even when an explicit initialMessage overrides the seed text', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const ctx = await createProposalTestContext({
      invocationQueueOverride: new InvocationQueue(),
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const contentBlocks = [
      {
        type: 'file',
        url: 'https://example.com/design.md',
        fileName: 'design.md',
        mimeType: 'text/markdown',
        fileSize: 456,
      },
    ];
    const initialMessage = 'Own this PR and review the attached design doc.';

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'External PR intake',
        reason: 'Please review the attached design doc and decide on adoption.',
        initialMessage,
      },
      originContentBlocks: contentBlocks,
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.ok(proposal.sourceMessageId, 'proposal must record the source message id');

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes(initialMessage), 'seed must use the explicit initialMessage as the text body');
    // #1387: explicit initialMessage must not hide the source envelope from the child prompt.
    assert.ok(
      seed.content.includes('External PR intake'),
      'child prompt must still include the proposal title when explicit initialMessage is used',
    );
    assert.ok(
      seed.content.includes('Please review the attached design doc and decide on adoption.'),
      'child prompt must still include the proposal reason when explicit initialMessage is used',
    );
    assert.deepEqual(
      seed.contentBlocks,
      contentBlocks,
      'explicit initialMessage must not discard source message content blocks',
    );
    assert.equal(
      seed.extra?.crossPost?.sourceMessageId,
      proposal.sourceMessageId,
      'seed crossPost metadata must expose the exact sourceMessageId for child dereferencing',
    );
  });

  test('repairs a missing child seed when the first dispatch fails after finalize, exactly once', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Repairable intake',
        reason: 'Transient dispatch failure after finalize must be recoverable.',
      },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const originalAppend = ctx.messageStore.append.bind(ctx.messageStore);
    let childAppendAttempts = 0;
    ctx.messageStore.append = async (input) => {
      // Fail only the child seed append, not source-thread messages.
      if (input.threadId !== source.id) {
        childAppendAttempts += 1;
        if (childAppendAttempts === 1) {
          throw new Error('simulated transient child-seed append failure');
        }
      }
      return originalAppend(input);
    };

    const firstApprove = await ctx.approve('alice', proposalId);
    assert.equal(firstApprove.statusCode, 200);
    const firstBody = JSON.parse(firstApprove.body);
    assert.ok(firstBody.threadId, 'thread must be created even when seed append fails');
    assert.ok(
      firstBody.warnings?.some((w) => w.includes('initialMessage append failed')),
      'first approve must surface the seed failure as a warning',
    );

    let timeline = await ctx.messageStore.getByThread(firstBody.threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 0, 'child seed must not exist after dispatch failure');

    const secondApprove = await ctx.approve('alice', proposalId);
    assert.equal(secondApprove.statusCode, 200);
    const secondBody = JSON.parse(secondApprove.body);
    assert.equal(secondBody.threadId, firstBody.threadId);
    assert.equal(secondBody.deduped, true);

    timeline = await ctx.messageStore.getByThread(firstBody.threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'reconciled seed must exist exactly once');
    assert.ok(
      timeline[0].content.includes('Repairable intake'),
      'reconciled seed must carry the source envelope title',
    );

    const thirdApprove = await ctx.approve('alice', proposalId);
    assert.equal(thirdApprove.statusCode, 200);
    const thirdBody = JSON.parse(thirdApprove.body);
    assert.equal(thirdBody.deduped, true);

    timeline = await ctx.messageStore.getByThread(firstBody.threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'further approves must not duplicate the seed');
  });
});
