import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// F231 Phase C: profile-update confirmation card (operator's approve entry point).
describe('buildProfileUpdateCardBlock', () => {
  const proposal = {
    proposalId: 'prop_1',
    status: 'pending',
    sourceCatId: 'codex',
    sourceThreadId: 'thread_1',
    targetLayer: 'primer',
    targetPath: 'relationship/codex-primer.md',
    beforeContent: 'OLD relationship notes',
    afterContent: 'NEW relationship notes',
    rationale: 'landy prefers concise updates',
    signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
    createdBy: 'alice',
    createdAt: 1,
  };

  it('renders a card with before/after + approve/reject actions targeting profile-update', async () => {
    const mod = await import('../dist/routes/profile-update-card-block.js');
    const card = mod.buildProfileUpdateCardBlock(proposal);
    assert.equal(card.kind, 'card');
    assert.equal(card.v, 1);
    assert.equal(card.id, 'profile-update-prop_1');
    assert.match(card.title, /codex/);
    assert.ok(card.bodyMarkdown.includes('OLD relationship notes'), 'shows before content');
    assert.ok(card.bodyMarkdown.includes('NEW relationship notes'), 'shows after content');
    assert.ok(card.bodyMarkdown.includes('landy prefers concise updates'), 'shows rationale');

    const approveAction = card.actions.find((a) => a.action === 'profile-update:approve');
    const rejectAction = card.actions.find((a) => a.action === 'profile-update:reject');
    assert.ok(approveAction, 'has approve action');
    assert.equal(approveAction.payload.proposalId, 'prop_1');
    assert.ok(rejectAction, 'has reject action');
    assert.equal(rejectAction.payload.proposalId, 'prop_1');
  });

  it('surfaces signal provenance (whitelist source — KD-9)', async () => {
    const mod = await import('../dist/routes/profile-update-card-block.js');
    const card = mod.buildProfileUpdateCardBlock(proposal);
    const provField = card.fields.find((f) => /来源|source/i.test(f.label));
    assert.ok(provField, 'has a provenance field');
    assert.ok(/cat-declared/.test(provField.value));
  });

  it('P2: lengthens Markdown fences when primer content contains backticks', async () => {
    const mod = await import('../dist/routes/profile-update-card-block.js');
    const card = mod.buildProfileUpdateCardBlock({
      ...proposal,
      beforeContent: 'OLD note with ``` inline fence',
      afterContent: 'NEW note with ```` inline fence',
    });

    const fenceLines = card.bodyMarkdown.split('\n').filter((line) => /^`+$/.test(line));
    assert.equal(fenceLines.length, 4, 'wraps before and after content with fences');
    assert.ok(
      fenceLines.every((line) => line === '`````'),
      'outer fence exceeds longest content fence',
    );
    assert.ok(card.bodyMarkdown.includes('OLD note with ``` inline fence'));
    assert.ok(card.bodyMarkdown.includes('NEW note with ```` inline fence'));
  });
});
