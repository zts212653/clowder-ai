// @ts-check
/**
 * F128 Phase Y P1-2 — proposal card MUST surface reportingMode.
 *
 * reportingMode is a create-time contract, fixed and NOT editable on approve
 * (C-Y1). The user approves the card, so the card MUST show which reporting
 * contract they are signing off on (default `none` → shown as autonomous, C-Y4).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildProposalCardBlock } = await import('../dist/routes/callback-propose-thread-routes.js');

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
  it('default (no reportingMode) → card surfaces 回报模式 = autonomous', () => {
    const card = buildProposalCardBlock(/** @type {any} */ (baseProposal()));
    const field = modeField(card);
    assert.ok(field, 'card must surface a 回报模式 field even when proposal omits reportingMode');
    assert.ok(field.value.includes('autonomous'), `default none must show as autonomous; got ${field.value}`);
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
});
