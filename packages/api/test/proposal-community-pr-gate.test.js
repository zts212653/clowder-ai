// @ts-check
/**
 * F128 proposal runtime — no server-side PR inference.
 *
 * These tests verify that the proposal layer does not guess community-PR intent
 * from title/reason text; the caller's explicit initialMessage and proposal
 * fields are preserved verbatim.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 proposal runtime — no server-side PR inference', () => {
  test('preserves the caller-supplied initialMessage verbatim for clowder-ai PR references', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        reason: 'Review https://github.com/zts212653/clowder-ai/pull/1192 in a dedicated thread',
        initialMessage: 'Own this PR and close the loop.',
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, 'Own this PR and close the loop.');
    assert.equal(proposal.communityPrContext, undefined);
  });

  test('does not rewrite an unrelated internal proposal', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Internal work');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { initialMessage: 'Investigate the internal queue race.' },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, 'Investigate the internal queue race.');
    assert.equal(proposal.communityPrContext, undefined);
  });

  test('does not treat repo-qualified shorthand as a PR without explicit review intent', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Triage clowder-ai#1195',
        reason: 'Inspect the new community issue.',
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, undefined);
    assert.equal(proposal.communityPrContext, undefined);
  });

  test('leaves advisory, triage, arbitrary-link, and multi-PR proposals untouched', async () => {
    for (const body of [
      {
        title: 'Advisory discussion',
        reason: 'Advisory review of https://github.com/zts212653/clowder-ai/pull/1196 only.',
      },
      {
        title: 'Triage inbound link',
        reason: 'Triage https://github.com/zts212653/clowder-ai/pull/1197 before deciding whether review is needed.',
      },
      {
        title: 'Reference material',
        reason: 'Keep https://github.com/zts212653/clowder-ai/pull/1198 as context.',
      },
      {
        title: 'Formal review batch',
        reason:
          'Review https://github.com/zts212653/clowder-ai/pull/1199 and https://github.com/zts212653/clowder-ai/pull/1200.',
      },
    ]) {
      const ctx = await createProposalTestContext();
      const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
      const res = await ctx.propose({ userId: 'alice', threadId: source.id, body });

      assert.equal(res.statusCode, 200);
      const proposal = await ctx.proposalStore.get(JSON.parse(res.body).proposalId);
      assert.equal(proposal.initialMessage, undefined);
      assert.equal(proposal.communityPrContext, undefined);
    }
  });
});
