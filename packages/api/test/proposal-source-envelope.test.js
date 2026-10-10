// @ts-check
/**
 * F128 proposal source-envelope behavior.
 *
 * These tests cover how the proposal's title/reason/sourceMessageId are delivered
 * to the child thread when no explicit initialMessage is provided, and how the
 * envelope survives routing and persistence boundaries.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 proposal source envelope', () => {
  test('delivers a lossless source envelope to the child thread when initialMessage is omitted', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const reason = 'Evaluate the existing community contribution.';

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'clowder-ai PR #1189 intake review',
        reason,
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, undefined);
    assert.equal(proposal.communityPrContext, undefined);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1, 'child thread must receive a seed message even without initialMessage');
    const seed = timeline[0];
    assert.ok(seed.content.includes(reason), 'seed message must include the original reason');
    assert.ok(
      seed.content.includes('clowder-ai PR #1189 intake review'),
      'seed message must include the original title',
    );
    assert.ok(seed.content.includes('## 主 Thread'), 'seed message must still include the fork-and-return header');
    // The proposal record stores the raw (undefined) initialMessage, not the envelope.
    assert.equal(proposal.initialMessage, undefined);
  });

  test('delivers reason-only PR URL to the child thread as a verifiable source envelope', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const url = 'https://github.com/zts212653/clowder-ai/pull/1196';
    const reason = `Advisory review of ${url} only.`;

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Advisory discussion',
        reason,
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes(url), 'child must be able to read the PR URL from the source envelope');
    assert.ok(seed.content.includes('Advisory discussion'), 'seed message must include the original title');
    assert.ok(seed.content.includes('## 主 Thread'), 'seed message must include the fork-and-return header');
  });

  test('treats empty-string initialMessage as absent and falls back to source envelope', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const reason = 'Empty-string override must still deliver the source envelope.';

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Envelope fallback', reason, initialMessage: '' },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    assert.ok(timeline[0].content.includes(reason), 'empty-string initialMessage must fall back to envelope content');
  });

  test('does not let @-mentions or #ideate inside title/reason influence routing', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const resolveCalls = [];
    const router = {
      async resolveTargetsAndIntent(content, threadId, options) {
        resolveCalls.push({ content, threadId, options });
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: new InvocationQueue(),
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: '@opus please review',
        reason: '#ideate discuss this PR',
        preferredCats: ['kimi'],
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);

    assert.equal(resolveCalls.length, 1, 'router must be consulted during approve dispatch');
    assert.equal(
      resolveCalls[0].content,
      '',
      'routing input must be empty when no explicit initialMessage is provided; title/reason must not leak',
    );

    const { threadId } = JSON.parse(approveRes.body);
    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes('@opus'), 'seed content may contain the title text');
    assert.ok(seed.content.includes('#ideate'), 'seed content may contain the reason text');
    // The seed must still be serial (preferredCats[0] only) despite #ideate in reason.
    assert.deepEqual(seed.mentions, ['kimi'], 'preferredCats[0] wins; #ideate in reason must not flip to parallel');
  });

  test('source envelope and crossPost sourceMessageId survive a Redis round-trip', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const url = 'https://github.com/zts212653/clowder-ai/pull/1197';
    const initialMessage = 'Review this external PR.';

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Redis round-trip intake',
        reason: `Advisory review of ${url}.`,
        initialMessage,
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.ok(proposal.sourceMessageId, 'proposal must record the source message id');

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    // Re-fetch from Redis (not the in-memory cache) to verify round-trip persistence.
    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes(initialMessage), 'round-tripped seed must include explicit initialMessage');
    assert.ok(seed.content.includes(url), 'round-tripped seed must include the PR URL from the source envelope');
    assert.ok(
      seed.content.includes('Redis round-trip intake'),
      'round-tripped seed must include the proposal title from the source envelope',
    );
    assert.equal(
      seed.extra?.crossPost?.sourceMessageId,
      proposal.sourceMessageId,
      'round-tripped crossPost.sourceMessageId must match the proposal sourceMessageId',
    );
  });
});
