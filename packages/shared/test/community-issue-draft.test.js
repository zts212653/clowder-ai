import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F235: CommunityIssueDraft types', () => {
  describe('generateCommunityIssueDraftId', () => {
    it('generates ID with cid_ prefix', async () => {
      const { generateCommunityIssueDraftId } = await import('../dist/types/community-issue-draft.js');
      const id = generateCommunityIssueDraftId();
      assert.ok(id.startsWith('cid_'), `expected cid_ prefix, got: ${id}`);
    });

    it('generates unique IDs', async () => {
      const { generateCommunityIssueDraftId } = await import('../dist/types/community-issue-draft.js');
      const id1 = generateCommunityIssueDraftId();
      const id2 = generateCommunityIssueDraftId();
      assert.notEqual(id1, id2, 'IDs should be unique');
    });
  });

  describe('createCommunityIssueDraft', () => {
    const validInput = {
      sourceType: 'frustration_issue',
      sourceId: 'fi_abc123',
      title: 'Permission prompts too frequent',
      bodyMarkdown: '## Problem\nUser cancelled 4 times in 60s.',
      targetRepo: 'clowder-ai/cat-cafe',
      labels: ['bug', 'user-reported'],
      threadId: 'thread_xyz',
      userId: 'usr_test',
    };

    it('creates draft with status=draft', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      const draft = createCommunityIssueDraft(validInput);
      assert.equal(draft.status, 'draft');
    });

    it('generates draftId with cid_ prefix', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      const draft = createCommunityIssueDraft(validInput);
      assert.ok(draft.draftId.startsWith('cid_'), `expected cid_ prefix, got: ${draft.draftId}`);
    });

    it('copies all input fields', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      const draft = createCommunityIssueDraft(validInput);
      assert.equal(draft.sourceType, 'frustration_issue');
      assert.equal(draft.sourceId, 'fi_abc123');
      assert.equal(draft.title, 'Permission prompts too frequent');
      assert.equal(draft.bodyMarkdown, '## Problem\nUser cancelled 4 times in 60s.');
      assert.equal(draft.targetRepo, 'clowder-ai/cat-cafe');
      assert.deepEqual(draft.labels, ['bug', 'user-reported']);
      assert.equal(draft.threadId, 'thread_xyz');
      assert.equal(draft.userId, 'usr_test');
    });

    it('sets createdAt timestamp', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      const before = Date.now();
      const draft = createCommunityIssueDraft(validInput);
      const after = Date.now();
      assert.ok(draft.createdAt >= before && draft.createdAt <= after);
    });

    it('leaves publish/cancel fields undefined', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      const draft = createCommunityIssueDraft(validInput);
      assert.equal(draft.githubIssueNumber, undefined);
      assert.equal(draft.githubIssueUrl, undefined);
      assert.equal(draft.publishedAt, undefined);
      assert.equal(draft.cancelledAt, undefined);
    });

    it('rejects empty title', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      assert.throws(() => createCommunityIssueDraft({ ...validInput, title: '' }), /title.*required/i);
    });

    it('rejects empty sourceId', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      assert.throws(() => createCommunityIssueDraft({ ...validInput, sourceId: '' }), /sourceId.*required/i);
    });

    it('rejects empty targetRepo', async () => {
      const { createCommunityIssueDraft } = await import('../dist/types/community-issue-draft.js');
      assert.throws(() => createCommunityIssueDraft({ ...validInput, targetRepo: '' }), /targetRepo.*required/i);
    });
  });
});
