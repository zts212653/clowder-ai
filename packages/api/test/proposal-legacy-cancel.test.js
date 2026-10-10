// @ts-check
/**
 * #1406 B1: legacy/undefined-deliveryStatus seeds must reach a terminal canceled
 * state when dispatch cannot wake them (no routing dependencies or zero targets).
 *
 * MessageStore.markCanceled is a queued -> canceled CAS transition, so a legacy
 * row must first be adopted into queued state via prepareQueueAdmission.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

async function createApprovedProposalWithLegacySeed(
  ctx,
  { initialMessage = 'Kick this off', preferredCats = ['opus'] } = {},
) {
  const source = await ctx.threadStore.create('alice', 'Source');
  const proposeRes = await ctx.propose({
    userId: 'alice',
    catId: 'codex',
    threadId: source.id,
    body: { initialMessage, preferredCats },
  });
  const { proposalId } = JSON.parse(proposeRes.body);

  const child = await ctx.threadStore.create('alice', 'Child');
  ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
  ctx.proposalStore.finalizeApproval({ proposalId, createdThreadId: child.id });

  const proposal = ctx.proposalStore.get(proposalId);

  // Legacy seed: written before the idempotency-key index, no deliveryStatus.
  const seed = ctx.messageStore.append({
    userId: 'alice',
    catId: 'codex',
    content: `**来源**: ${proposal.title}\n\n${proposal.reason}`,
    mentions: preferredCats,
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

  return { proposalId, childId: child.id, proposal, seedId: seed.id };
}

describe('F128 proposal legacy seed cancel — terminal state', () => {
  test('legacy seed is canceled when routing dependencies are unavailable', async () => {
    const ctx = await createProposalTestContext({});
    const { proposalId, childId, seedId } = await createApprovedProposalWithLegacySeed(ctx);

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.deduped, true);
    assert.equal(firstBody.legacySeed, true);
    assert.ok(
      firstBody.warnings?.some(
        (w) => w.includes('routing dependencies unavailable') && w.includes('existing seed canceled'),
      ),
      'must surface the real cancel outcome',
    );

    const seedAfter = await ctx.messageStore.getById(seedId);
    assert.equal(seedAfter?.deliveryStatus, 'canceled', 'legacy seed must be terminal canceled');

    // A canceled seed is not visible to the legacy scan, so the next reconcile
    // materializes a fallback delivered seed instead of looping on the old row.
    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);
    assert.notEqual(secondBody.legacySeed, true);
    assert.ok(
      secondBody.warnings?.some(
        (w) => w.includes('routing dependencies unavailable') && !w.includes('existing seed canceled'),
      ),
      'must surface fallback skip, not a stale cancel loop',
    );

    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'fallback delivered seed must be visible');
    assert.equal(timeline[0].deliveryStatus, 'delivered');

    // The fallback seed now owns the idempotency key, so further reconciles are quiet.
    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);
    assert.ok(!thirdBody.warnings || thirdBody.warnings.length === 0);
  });

  test('legacy seed is canceled when no target cats resolve', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue(undefined, {
      onAdmitted: ({ threadId, entries }) => {
        void queueProcessor.processNext(threadId, entries[0].owner.userId).catch(() => {});
      },
    });
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
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
    });
    const { proposalId, childId, seedId } = await createApprovedProposalWithLegacySeed(ctx, {
      initialMessage: 'No targets here',
      preferredCats: [],
    });

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.deduped, true);
    assert.equal(firstBody.legacySeed, true);
    assert.ok(
      firstBody.warnings?.some((w) => w.includes('no target cats resolved') && w.includes('existing seed canceled')),
      'must surface the real cancel outcome',
    );

    const seedAfter = await ctx.messageStore.getById(seedId);
    assert.equal(seedAfter?.deliveryStatus, 'canceled', 'legacy seed must be terminal canceled');

    // Once canceled, the legacy scan no longer sees the row; reconcile writes a
    // fallback delivered seed with the idempotency key and stops.
    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);
    assert.notEqual(secondBody.legacySeed, true);
    assert.ok(
      secondBody.warnings?.some((w) => w.includes('no target cats resolved') && !w.includes('existing seed canceled')),
      'must surface fallback skip, not a stale cancel loop',
    );

    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'fallback delivered seed must be visible');
    assert.equal(timeline[0].deliveryStatus, 'delivered');

    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);
    assert.ok(!thirdBody.warnings || thirdBody.warnings.length === 0);
  });
});
