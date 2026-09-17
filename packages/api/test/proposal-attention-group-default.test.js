import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F277 explicit conversation-group birth boundary', () => {
  test('proposal approval never inherits a parent Group without a user drag/menu command', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'f277-proposal-group-'));
    const ctx = await createProposalTestContext({ projectRoot });
    try {
      const parent = await ctx.threadStore.create('alice', 'F277 parent');
      const sibling = await ctx.threadStore.create('alice', 'F277 sibling');
      const groupId = 'attention_manual';
      await ctx.threadStore.atomicMergeThreadMetadata(parent.id, { attentionGroup: { v: 1, groupId, order: 0 } });
      await ctx.threadStore.atomicMergeThreadMetadata(sibling.id, { attentionGroup: { v: 1, groupId, order: 1 } });

      for (const declaredWorkMode of ['parallel', 'standalone', undefined]) {
        const proposed = await ctx.propose({
          userId: 'alice',
          threadId: parent.id,
          body: declaredWorkMode ? { declaredWorkMode } : {},
        });
        const approved = await ctx.approve('alice', proposed.json().proposalId);
        assert.equal(approved.statusCode, 200, approved.body);
        assert.equal((await ctx.threadStore.getThreadMetadata(approved.json().threadId))?.attentionGroup, undefined);
      }

      assert.deepEqual((await ctx.threadStore.getThreadMetadata(parent.id))?.attentionGroup, {
        v: 1,
        groupId,
        order: 0,
      });
      assert.deepEqual((await ctx.threadStore.getThreadMetadata(sibling.id))?.attentionGroup, {
        v: 1,
        groupId,
        order: 1,
      });
    } finally {
      await ctx.app.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
