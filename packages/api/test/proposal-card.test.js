// @ts-check
/**
 * F128 Phase Y P1-2 — proposal card MUST surface reportingMode.
 *
 * reportingMode is part of the approval contract. The proposal card MUST show
 * which contract the cat proposed, and the frontend lets the user override it
 * before creation (post-creation dynamic switching is still unsupported).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildProposalCardBlock } = await import('../dist/routes/proposal-card-block.js');

function baseProposal(overrides = {}) {
  return {
    proposalId: 'p1',
    status: 'pending',
    sourceThreadId: 'thread_src',
    sourceInvocationId: 'inv',
    sourceCatId: 'opus',
    title: 'Test',
    reason: 'why',
    parentThreadId: 'thread_src',
    preferredCats: ['codex'],
    projectPath: '/tmp',
    createdBy: 'alice',
    createdAt: 1700000000000,
    ...overrides,
  };
}

/** @param {any} card */
function modeField(card) {
  return card.fields?.find((/** @type {{label:string}} */ f) => f.label === '回报模式');
}

describe('F128 proposal card — reportingMode visibility (Phase Y P1-2)', () => {
  // AC-AA1: default is now final-only (supersedes Phase Y default none/autonomous).
  it('default (no reportingMode) → card surfaces 回报模式 = final-only（默认）', () => {
    const card = buildProposalCardBlock(/** @type {any} */ (baseProposal()));
    const field = modeField(card);
    assert.ok(field, 'card must surface a 回报模式 field even when proposal omits reportingMode');
    assert.ok(field.value.includes('final-only'), `AC-AA1: default must show final-only; got ${field.value}`);
    assert.ok(field.value.includes('默认'), `AC-AA1: default must include 默认 label; got ${field.value}`);
  });

  it('explicit final-only → card surfaces final-only', () => {
    const card = buildProposalCardBlock(/** @type {any} */ (baseProposal({ reportingMode: 'final-only' })));
    assert.ok(modeField(card)?.value.includes('final-only'), 'final-only must be surfaced on the approval card');
  });

  it('all 4 modes have a non-empty user-facing card label', () => {
    for (const mode of ['none', 'final-only', 'state-transitions', 'blocking-ack']) {
      const card = buildProposalCardBlock(/** @type {any} */ (baseProposal({ reportingMode: mode })));
      const field = modeField(card);
      assert.ok(field && field.value.length > 0, `${mode} must have a card label`);
    }
  });

  // F225 猫猫化: title no longer embeds a raw 📥 emoji — the frontend renders an inbox SVG icon.
  it('title carries no raw 📥 emoji prefix but keeps the readable label', () => {
    const card = buildProposalCardBlock(/** @type {any} */ (baseProposal({ title: '通知卡片猫猫化' })));
    assert.ok(!card.title.includes('📥'), `title must not embed 📥; got ${card.title}`);
    assert.ok(
      card.title.includes('提议新建 thread：通知卡片猫猫化'),
      `title keeps the readable label; got ${card.title}`,
    );
  });
});
