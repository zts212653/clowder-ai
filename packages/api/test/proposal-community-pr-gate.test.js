import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 open-source PR maintainer gate', () => {
  test('injects the maintainer inbound contract for a clowder-ai PR proposal', async () => {
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
    assert.ok(proposal.initialMessage);
    assert.deepEqual(proposal.communityPrContext, {
      repoFullName: 'zts212653/clowder-ai',
      prNumber: 1192,
      mode: 'formal_review',
    });
    assert.match(proposal.initialMessage, /加载 `opensource-ops`/);
    assert.match(proposal.initialMessage, /它对我们自己的家有益吗/);
    assert.match(proposal.initialMessage, /它实际改了什么/);
    assert.match(proposal.initialMessage, /值得 merge/);
    assert.match(proposal.initialMessage, /值得 intake/);
    assert.match(proposal.initialMessage, /更优雅的解法或架构切片/);
    assert.match(proposal.initialMessage, /真实 GitHub author/);
    assert.match(proposal.initialMessage, /禁止把 finding 默认派给家里的猫修/);
    assert.match(proposal.initialMessage, /Formal review tracking transition/);
    assert.match(proposal.initialMessage, /不猜等待条件/);
    assert.match(proposal.initialMessage, /显式注册 typed continuation/);
    assert.match(proposal.initialMessage, /Own this PR and close the loop\./);
  });

  test('creates a guarded initial message even when the caller omitted one', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'clowder-ai PR #1189 intake review',
        reason: 'Evaluate the existing community contribution.',
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.match(proposal.initialMessage, /clowder-ai#1189/);
    assert.match(proposal.initialMessage, /Maintainer Inbound Gate/);
  });

  test('guards canonical repo-qualified shorthand when the proposal says it is a PR review', async () => {
    for (const reference of ['clowder-ai#1185', 'zts212653/clowder-ai#1185']) {
      const ctx = await createProposalTestContext();
      const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

      const res = await ctx.propose({
        userId: 'alice',
        threadId: source.id,
        body: {
          title: `Review ${reference}`,
          reason: 'Open a dedicated thread for the inbound PR.',
        },
      });

      assert.equal(res.statusCode, 200);
      const { proposalId } = JSON.parse(res.body);
      const proposal = await ctx.proposalStore.get(proposalId);
      assert.match(proposal.initialMessage, /clowder-ai#1185/);
      assert.match(proposal.initialMessage, /Maintainer Inbound Gate/);
    }
  });

  test('guards a clowder-ai PR when review intent and repository context are split across proposal fields', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Review PR #1192',
        reason: 'Evaluate the zts212653/clowder-ai inbound contribution.',
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.match(proposal.initialMessage, /clowder-ai#1192/);
    assert.match(proposal.initialMessage, /Maintainer Inbound Gate/);
  });

  test('does not treat a repo-qualified issue shorthand as a PR without review context', async () => {
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

  test('injects the maintainer gate but does not persist formal context for advisory, triage, or URL-only proposals', async () => {
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
    ]) {
      const ctx = await createProposalTestContext();
      const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
      const res = await ctx.propose({ userId: 'alice', threadId: source.id, body });

      assert.equal(res.statusCode, 200);
      const proposal = await ctx.proposalStore.get(JSON.parse(res.body).proposalId);
      assert.match(proposal.initialMessage, /Maintainer Inbound Gate/);
      assert.equal(proposal.communityPrContext, undefined);
    }
  });

  test('fails closed on ambiguous multi-PR formal review proposals', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Formal review batch',
        reason:
          'Review https://github.com/zts212653/clowder-ai/pull/1199 and https://github.com/zts212653/clowder-ai/pull/1200.',
      },
    });

    assert.equal(res.statusCode, 200);
    const proposal = await ctx.proposalStore.get(JSON.parse(res.body).proposalId);
    assert.match(proposal.initialMessage, /clowder-ai#1199, clowder-ai#1200/);
    assert.equal(proposal.communityPrContext, undefined);
  });

  test('fails closed when the required gate would overflow the stored message contract', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        reason: 'Review clowder-ai PR #1192',
        initialMessage: 'x'.repeat(3900),
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /maintainer gate was added/);
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
  });
});
