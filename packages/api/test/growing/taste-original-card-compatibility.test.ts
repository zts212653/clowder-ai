import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RichCardBlock } from '@cat-cafe/shared';
import { informationalOriginalFixture } from './informational-original-card.fixture.js';

// Frozen publication from the pre-M3 builder (96527977ac^). Do not use the current serializer.
const legacyCard: RichCardBlock = {
  id: 'taste-proposal-taste-one',
  kind: 'card',
  v: 1,
  title: '提议捕捉品味信号',
  bodyMarkdown:
    '**猫的判断（假设）：** Prefer verifiable outcomes\n\n**场景：** The source context\n\n> Show me the real result',
  tone: 'info',
  fields: [
    { label: '维度', value: '认知诚实' },
    { label: '标签', value: 'outcome, clarity' },
    { label: '隐私', value: '公开' },
    { label: '捕捉猫', value: 'codex-sol' },
  ],
};

for (const quotes of [['First retained quotation', 'Second retained quotation'], []]) {
  test(`F221 correction preserves all ${quotes.length} resolved quotes in its original proof`, async (t) => {
    const fixture = await informationalOriginalFixture('F221', true, {
      tasteInput: { resolvedQuotes: quotes, quote: quotes[0] ?? '', scene: 'A corrected scene' },
    });
    t.after(fixture.close);
    const read = await fixture.project();
    assert.deepEqual(read.items[0]?.originalApprovalCard?.block, fixture.block);
    assert.deepEqual(read.items[0]?.approval?.detail.quotes, quotes);
    assert.equal(read.consistency.state, 'verified');
    const altered = await fixture.project((message) => ({
      ...message,
      extra: {
        rich: { v: 1, blocks: [{ ...fixture.block, bodyMarkdown: `${fixture.block.bodyMarkdown}\nForged quote` }] },
      },
    }));
    assert.equal(altered.items[0]?.originalApprovalCard, undefined);
  });
}

for (const longScene of [false, true]) {
  test(`F221 pre-M3 ${longScene ? 'truncated' : 'short'} publication keeps full current review available`, async (t) => {
    const scene = longScene ? `${'完整场景'.repeat(70)}END_OF_FULL_SCENE` : 'The source context';
    const old = structuredClone(legacyCard);
    assert.ok(old.bodyMarkdown);
    if (longScene) old.bodyMarkdown = old.bodyMarkdown.replace('The source context', `${scene.slice(0, 197)}…`);
    const fixture = await informationalOriginalFixture('F221', false, {
      tasteInput: { scene },
      tasteCard: () => old,
    });
    t.after(fixture.close);
    const read = await fixture.project();
    assert.deepEqual(read.items[0]?.originalApprovalCard?.block, fixture.block);
    assert.equal(read.items[0]?.approval?.detail.scene, scene);
    assert.match(String(read.items[0]?.approval?.detail.decisionDigest), /^[0-9a-f]{64}$/);
    assert.equal(read.items[0]?.approval?.inlineApprovable, true);
    assert.equal(read.consistency.state, 'verified');
    for (const change of [
      { bodyMarkdown: `${old.bodyMarkdown}\nDifferent content` },
      { fields: old.fields?.slice(0, 2) },
      { actions: [] },
    ]) {
      const altered = await fixture.project((message) => ({
        ...message,
        extra: { rich: { v: 1, blocks: [{ ...fixture.block, ...change }] } },
      }));
      assert.equal(altered.items[0]?.originalApprovalCard, undefined);
    }
    const deleted = await fixture.project((message) => ({ ...message, deletedAt: Date.now() }));
    assert.equal(deleted.items[0]?.originalApprovalCard, undefined);
  });
}
