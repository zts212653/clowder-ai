import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { saveThreadAttentionPreference } from '../dist/config/user-preferences-thread-attention.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

test('an ungrouped source suggests an exact title feature match and respects an explicit opt-out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-group-suggestion-'));
  const ctx = await createProposalTestContext({ projectRoot: root });
  try {
    const source = ctx.threadStore.create('alice', '每日漫谈');
    const members = [ctx.threadStore.create('alice', '建模'), ctx.threadStore.create('alice', '地形')];
    for (const [order, thread] of members.entries())
      await ctx.threadStore.atomicMergeThreadMetadata(thread.id, {
        attentionGroup: { v: 1, groupId: 'attention_planet', order },
      });
    saveThreadAttentionPreference(root, { anchor: 'group:attention_planet', alias: 'F329「猫猫星球」游戏' });
    for (const [body, group, reason] of [
      [{ title: 'F329 溪村地形第二轮' }, 'attention_planet', 'feature-title'],
      [{ title: 'F3290 另一个项目' }, undefined, 'none'],
      [{ title: 'F329 溪村地形第二轮', suggestedGroupId: null }, undefined, 'none'],
    ]) {
      const response = await ctx.propose({ userId: 'alice', threadId: source.id, body });
      assert.equal(response.statusCode, 200, response.body);
      const proposal = await ctx.proposalStore.get(response.json().proposalId);
      assert.equal(proposal.suggestedGroupId, group);
      assert.equal(proposal.groupSuggestionReason, reason);
    }
    assert.equal(ctx.threadStore.list('alice').length, 3, 'suggestions do not create or move conversations');
  } finally {
    await ctx.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
