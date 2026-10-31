import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import {
  hydrateProposal,
  serializeProposal,
} from '../dist/domains/cats/services/stores/redis/RedisProposalStoreHelpers.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

function makeTempProjectPath() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cat-cafe-proposal-transition-')));
}

async function proposeExternal(ctx, source, preferredCats = ['opus'], projectPath) {
  const response = await ctx.propose({
    userId: 'alice',
    threadId: source.id,
    body: {
      title: 'Exact-HEAD review for clowder-ai PR #1210',
      reason: 'Review https://github.com/zts212653/clowder-ai/pull/1210 in an owner child.',
      initialMessage: 'Perform an independent exact-HEAD review; findings return to the external author.',
      preferredCats,
      projectPath,
      reportingMode: 'final-only',
    },
  });
  assert.equal(response.statusCode, 200);
  return JSON.parse(response.body).proposalId;
}

describe('F128 approval — no automatic external PR metadata or tracking', () => {
  test('approval creates the thread but does not write PR metadata or tracking', async () => {
    const projectPath = makeTempProjectPath();
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeExternal(ctx, source, ['opus'], projectPath);

    const approved = await ctx.approve('alice', proposalId);
    assert.equal(approved.statusCode, 200);
    const { threadId, warnings } = JSON.parse(approved.body);
    assert.ok(threadId);
    assert.equal(await ctx.threadStore.getThreadMetadata(threadId), null);
    assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
    assert.ok(
      !warnings ||
        warnings.length === 0 ||
        warnings.every((w) => /routing dependencies unavailable|no target cats resolved/i.test(w)),
      `unexpected warnings: ${JSON.stringify(warnings)}`,
    );

    const thread = await ctx.threadStore.get(threadId);
    assert.deepEqual(thread.preferredCats, ['opus']);
    assert.equal(thread.projectPath, projectPath);
    rmSync(projectPath, { recursive: true, force: true });
  });

  test('zero or multiple preferredCats are passed through without owner-custody warnings', async () => {
    const projectPath = makeTempProjectPath();
    try {
      for (const preferredCats of [[], ['opus', 'codex']]) {
        const ctx = await createProposalTestContext();
        const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
        const proposalId = await proposeExternal(ctx, source, preferredCats, projectPath);
        const approved = await ctx.approve('alice', proposalId);
        const { threadId, warnings } = JSON.parse(approved.body);
        assert.ok(threadId);
        assert.ok(!warnings || !warnings.some((w) => /exactly one.*owner/i.test(w)));
        assert.equal(await ctx.threadStore.getThreadMetadata(threadId), null);
        assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
      }
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('advisory and formal-looking proposals are approved identically with no tracking side effects', async () => {
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

  test('legacy communityPrContext field is ignored during Redis proposal hydration', () => {
    const proposal = hydrateProposal({
      proposalId: 'prop_legacy_001',
      status: 'pending',
      sourceThreadId: 'thread_src',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'opus',
      sourceMessageId: 'msg_1',
      title: 'Legacy proposal',
      reason: 'Has an obsolete communityPrContext field.',
      parentThreadId: 'thread_src',
      preferredCats: '[]',
      projectPath: 'default',
      createdBy: 'alice',
      createdAt: '1700000000000',
      communityPrContext: JSON.stringify({ repo: 'zts212653/clowder-ai', number: 42 }),
    });
    assert.equal(proposal.communityPrContext, undefined, 'obsolete field must be dropped');
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.title, 'Legacy proposal');
    assert.equal(proposal.sourceMessageId, 'msg_1');
  });

  test('current Redis rows remain readable by the legacy decoder after a legacy-to-current rewrite', () => {
    const legacyRow = {
      proposalId: 'prop_mixed_version_001',
      status: 'pending',
      sourceThreadId: 'thread_src',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'opus',
      sourceMessageId: 'msg_1',
      title: 'Mixed-version proposal',
      reason: 'Exercise current and legacy proposal readers.',
      parentThreadId: 'thread_src',
      preferredCats: JSON.stringify(['opus']),
      projectPath: 'default',
      createdBy: 'alice',
      createdAt: '1700000000000',
      communityPrContext: JSON.stringify({ repo: 'zts212653/clowder-ai', number: 1406 }),
    };

    const current = hydrateProposal(legacyRow);
    const fields = serializeProposal(current);
    assert.equal(fields.length % 2, 0, 'serialized Redis fields must be key/value pairs');
    const rewrittenRow = Object.fromEntries(
      Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
    );
    const legacyAfterRewrite = {
      proposalId: rewrittenRow.proposalId,
      status: rewrittenRow.status ?? 'pending',
      sourceThreadId: rewrittenRow.sourceThreadId,
      sourceInvocationId: rewrittenRow.sourceInvocationId,
      sourceCatId: rewrittenRow.sourceCatId,
      sourceMessageId: rewrittenRow.sourceMessageId || undefined,
      title: rewrittenRow.title,
      reason: rewrittenRow.reason,
      parentThreadId: rewrittenRow.parentThreadId,
      preferredCats: JSON.parse(rewrittenRow.preferredCats ?? '[]'),
      projectPath: rewrittenRow.projectPath,
      createdBy: rewrittenRow.createdBy,
      createdAt: Number(rewrittenRow.createdAt),
      communityPrContext: rewrittenRow.communityPrContext ? JSON.parse(rewrittenRow.communityPrContext) : undefined,
    };

    assert.equal('communityPrContext' in current, false, 'current reader drops the retired inference field');
    assert.equal(rewrittenRow.communityPrContext, undefined, 'current writer does not resurrect retired policy state');
    assert.deepEqual(legacyAfterRewrite, {
      proposalId: legacyRow.proposalId,
      status: legacyRow.status,
      sourceThreadId: legacyRow.sourceThreadId,
      sourceInvocationId: legacyRow.sourceInvocationId,
      sourceCatId: legacyRow.sourceCatId,
      sourceMessageId: legacyRow.sourceMessageId,
      title: legacyRow.title,
      reason: legacyRow.reason,
      parentThreadId: legacyRow.parentThreadId,
      preferredCats: ['opus'],
      projectPath: legacyRow.projectPath,
      createdBy: legacyRow.createdBy,
      createdAt: Number(legacyRow.createdAt),
      communityPrContext: undefined,
    });
  });
});
