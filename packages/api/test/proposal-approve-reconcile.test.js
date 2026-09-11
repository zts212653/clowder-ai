// @ts-check
/**
 * F128 / #1406 B1: proposal seed reconcile — exactly-once dispatch.
 *
 * Sol's hard requirement: queue-full, processNext-throw, and processNext
 * started:false must each reconcile on retry, drive the single seed through
 * Queue exactly once, and never produce duplicate thread messages or
 * duplicate invocations. Published agent speech keeps its timeline visibility
 * separate from owner-delivery projection; Queue terminalization is not allowed
 * to rewrite it to a user-delivery terminal.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

const router = {
  async resolveTargetsAndIntent() {
    return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
  },
};

/**
 * Simulate one successful Queue execution by terminalizing its durable entry.
 * The production QueueProcessor records response/lifecycle evidence before
 * doing this; this proposal test only owns exactly-once seed admission and must
 * not emulate retired owner-delivery projection on published agent speech.
 *
 * Crucially, we only terminalize when the message already has Queue custody.
 * Part 2's `ensureExistingSeedAdmitted` is what creates that custody for a
 * queue-full seed; without it this helper would be a no-op and the queue-full
 * test would fail with repeated redispatches.
 */
async function simulateDelivery(ctx, invocationQueue, threadId, userId) {
  const entry = invocationQueue.list(threadId, userId)[0];
  if (entry?.payload.messageId) {
    const source = await ctx.messageStore.getById(entry.payload.messageId);
    assert.equal(source?.lifecycle?.kind, 'input');
    const targetId = entry.targets[0];
    assert.ok(targetId);
    const dispatched = await ctx.messageStore.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      ...(source.lifecycle.producerInvocationId ? { producerInvocationId: source.lifecycle.producerInvocationId } : {}),
      targetId,
      phase: 'dispatched',
      statusMessageId: `proposal-response:${entry.id}`,
      dispatchedAt: Date.now(),
    });
    assert.ok(['applied', 'replayed'].includes(dispatched.kind));
    const settled = await ctx.messageStore.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      ...(source.lifecycle.producerInvocationId ? { producerInvocationId: source.lifecycle.producerInvocationId } : {}),
      targetId,
      phase: 'settled',
      statusMessageId: `proposal-response:${entry.id}`,
    });
    assert.ok(['applied', 'replayed'].includes(settled.kind));
    await invocationQueue.terminalizeEntryDurable(threadId, userId, entry.id, 'handled');
  }
  return { started: true };
}

const threadReadOptions = {
  includeQueuedCatMessages: true,
  includeQueuedUserMessages: true,
};

describe('F128 proposal seed reconcile — exactly-once dispatch', () => {
  test('queue-full seed is reconciled and processed exactly once', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let proposalEnqueueAttempt = 0;
    const originalEnqueue = invocationQueue.appendAndEnqueueDurable.bind(invocationQueue);
    invocationQueue.appendAndEnqueueDurable = (...args) => {
      const input = args[2];
      if (input.idempotencyKey?.startsWith('proposal-initial:')) {
        proposalEnqueueAttempt += 1;
        if (proposalEnqueueAttempt === 1) {
          return { outcome: 'full' };
        }
      }
      return originalEnqueue(...args);
    };

    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        return simulateDelivery(ctx, invocationQueue, threadId, userId);
      },
    };

    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });

    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
        })
      ).body,
    );

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.ok(firstBody.warnings?.some((w) => w.includes('queue is full')));

    const childId = firstBody.threadId;

    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);
    assert.ok(!secondBody.warnings || secondBody.warnings.length === 0, JSON.stringify(secondBody));

    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);
    assert.ok(!thirdBody.warnings || thirdBody.warnings.length === 0);

    // Exactly one seed message, one successful processNext, no residual queue entry.
    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must materialize exactly one seed message');
    assert.equal(
      timeline[0].deliveryStatus,
      undefined,
      'published agent seed must not be rewritten as owner-delivered content',
    );
    assert.equal(processCalls.length, 1, 'must wake the target exactly once');
    assert.equal(invocationQueue.size(childId, 'alice'), 0, 'queue must be empty after delivery');
  });

  test('processNext throw leaves a reconcilable seed with no duplicate invocation', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let shouldThrow = true;
    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        if (shouldThrow) {
          throw new Error('simulated processNext failure');
        }
        return simulateDelivery(ctx, invocationQueue, threadId, userId);
      },
    };

    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });

    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
        })
      ).body,
    );

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.ok(firstBody.warnings?.some((w) => w.includes('auto-start failed')));
    const childId = firstBody.threadId;

    // The seed is materialized and queued, but the queue processor failed to wake.
    const timelineBefore = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timelineBefore.length, 1);
    assert.equal(timelineBefore[0].deliveryStatus, 'queued');
    assert.equal(invocationQueue.size(childId, 'alice'), 1);

    shouldThrow = false;
    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);

    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);

    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must keep exactly one seed message');
    assert.equal(timeline[0].deliveryStatus, 'queued');
    assert.equal(processCalls.length, 2, 'first throw + one successful redispatch');
    assert.equal(invocationQueue.size(childId, 'alice'), 0);
  });

  test('processNext started:false leaves a reconcilable seed with no duplicate invocation', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let shouldStart = false;
    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        if (!shouldStart) {
          return { started: false };
        }
        return simulateDelivery(ctx, invocationQueue, threadId, userId);
      },
    };

    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });

    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
        })
      ).body,
    );

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.ok(firstBody.warnings?.some((w) => w.includes('did not start automatically')));
    const childId = firstBody.threadId;

    shouldStart = true;
    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);

    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);

    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must keep exactly one seed message');
    assert.equal(timeline[0].deliveryStatus, 'queued');
    assert.equal(processCalls.length, 2, 'first no-start + one successful redispatch');
    assert.equal(invocationQueue.size(childId, 'alice'), 0);
  });

  test('legacy queue-full seed is repaired and processed exactly once', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        return simulateDelivery(ctx, invocationQueue, threadId, userId);
      },
    };

    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });

    const source = await ctx.threadStore.create('alice', 'Source');
    const proposeRes = await ctx.propose({
      userId: 'alice',
      catId: 'codex',
      threadId: source.id,
      body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
    });
    const { proposalId } = JSON.parse(proposeRes.body);

    // Create a child thread and finalize the proposal as if the first approve
    // succeeded before dispatch existed (legacy row with no idempotency key).
    const child = await ctx.threadStore.create('alice', 'Child');
    ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
    ctx.proposalStore.finalizeApproval({ proposalId, createdThreadId: child.id });

    const proposal = ctx.proposalStore.get(proposalId);

    // Materialize a legacy seed: no idempotency key, no deliveryStatus, and no
    // lifecycle dispatch refs, but with the proposal source envelope and cross-post.
    ctx.messageStore.append({
      from: { kind: 'agent', catId: 'codex' },
      userId: 'alice',
      content: `**来源**: ${proposal.title}\n\n${proposal.reason}`,
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: child.id,
      extra: {
        crossPost: {
          sourceThreadId: proposal.sourceThreadId,
          sourceInvocationId: proposal.sourceInvocationId,
          sourceMessageId: proposal.sourceMessageId,
        },
      },
    });

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.deduped, true);
    assert.equal(firstBody.legacySeed, true);
    assert.ok(!firstBody.warnings || firstBody.warnings.length === 0, JSON.stringify(firstBody));

    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);
    assert.equal(secondBody.legacySeed, true);

    // Exactly one seed message, one successful processNext, no residual queue entry.
    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must keep exactly one legacy seed message');
    assert.equal(
      timeline[0].deliveryStatus,
      undefined,
      'published legacy agent seed must not be rewritten as owner-delivered content',
    );
    assert.equal(processCalls.length, 1, 'must wake the target exactly once');
    assert.equal(invocationQueue.size(child.id, 'alice'), 0, 'queue must be empty after delivery');
  });
});
