import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

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

describe('F128 → F280 formal external PR transition', () => {
  test('approval persists canonical metadata and owner without guessing a wait', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeFormal(ctx, source);

    const approved = await ctx.approve('alice', proposalId);
    assert.equal(approved.statusCode, 200);
    const { threadId } = JSON.parse(approved.body);
    assert.deepEqual(await ctx.threadStore.getThreadMetadata(threadId), {
      v: 1,
      prs: [{ repo: 'zts212653/clowder-ai', number: 1210 }],
    });
    assert.deepEqual((await ctx.threadStore.get(threadId)).preferredCats, ['opus']);
    assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
  });

  test('zero or multiple owners fail closed without creating a tracker', async () => {
    for (const preferredCats of [[], ['opus', 'codex']]) {
      const ctx = await createProposalTestContext();
      const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
      const proposalId = await proposeFormal(ctx, source, preferredCats);
      const approved = await ctx.approve('alice', proposalId);
      const { threadId, warnings } = JSON.parse(approved.body);
      assert.ok(warnings.some((warning) => /exactly one.*owner/i.test(warning)));
      assert.deepEqual(await ctx.threadStore.getThreadMetadata(threadId), {
        v: 1,
        prs: [{ repo: 'zts212653/clowder-ai', number: 1210 }],
      });
      assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
    }
  });

  test('advisory proposals create neither formal metadata nor a wait', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const response = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Community context',
        reason: 'Advisory discussion of https://github.com/zts212653/clowder-ai/pull/1210 only.',
        preferredCats: ['opus'],
      },
    });
    const approved = await ctx.approve('alice', JSON.parse(response.body).proposalId);
    const { threadId } = JSON.parse(approved.body);
    assert.equal(await ctx.threadStore.getThreadMetadata(threadId), null);
    assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
  });
});
