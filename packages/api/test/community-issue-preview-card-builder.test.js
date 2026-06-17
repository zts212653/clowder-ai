import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F235 Task 7: CommunityIssuePreviewCard rich block builder.
 */

const loadModule = () => import('../dist/domains/community/community-issue-preview-card-builder.js');

const draftFixture = {
  draftId: 'cid_test1',
  status: 'draft',
  sourceType: 'frustration_issue',
  sourceId: 'fi_src1',
  title: 'Permission prompts too frequent',
  bodyMarkdown: '## Problem\nUser cancelled 4 times.',
  targetRepo: 'clowder-ai/cat-cafe',
  labels: ['bug', 'user-reported'],
  threadId: 'thread_t1',
  userId: 'usr_u1',
  createdAt: Date.now(),
};

describe('F235: CommunityIssuePreviewCardBuilder', () => {
  describe('buildCommunityIssuePreviewCard (draft state)', () => {
    it('returns a card with correct id pattern', async () => {
      const { buildCommunityIssuePreviewCard } = await loadModule();
      const card = buildCommunityIssuePreviewCard(draftFixture);
      assert.equal(card.id, 'community-preview-cid_test1');
    });

    it('has kind=card and v=1', async () => {
      const { buildCommunityIssuePreviewCard } = await loadModule();
      const card = buildCommunityIssuePreviewCard(draftFixture);
      assert.equal(card.kind, 'card');
      assert.equal(card.v, 1);
    });

    it('includes title about community publish', async () => {
      const { buildCommunityIssuePreviewCard } = await loadModule();
      const card = buildCommunityIssuePreviewCard(draftFixture);
      assert.ok(card.title.includes('Publish') || card.title.includes('Community') || card.title.includes('社区'));
    });

    it('includes draft content in body', async () => {
      const { buildCommunityIssuePreviewCard } = await loadModule();
      const card = buildCommunityIssuePreviewCard(draftFixture);
      assert.ok(card.bodyMarkdown.includes('Permission prompts'));
    });

    it('has tone=info', async () => {
      const { buildCommunityIssuePreviewCard } = await loadModule();
      const card = buildCommunityIssuePreviewCard(draftFixture);
      assert.equal(card.tone, 'info');
    });

    it('includes repo and labels in fields', async () => {
      const { buildCommunityIssuePreviewCard } = await loadModule();
      const card = buildCommunityIssuePreviewCard(draftFixture);
      const fieldLabels = card.fields.map((f) => f.label);
      assert.ok(fieldLabels.includes('Repository'));
      assert.ok(fieldLabels.includes('Labels'));
    });

    it('has correct meta for frontend dispatch', async () => {
      const { buildCommunityIssuePreviewCard } = await loadModule();
      const card = buildCommunityIssuePreviewCard(draftFixture);
      assert.equal(card.meta.kind, 'community_issue_preview');
      assert.equal(card.meta.draftId, 'cid_test1');
      assert.equal(card.meta.sourceType, 'frustration_issue');
      assert.equal(card.meta.sourceId, 'fi_src1');
    });
  });

  describe('buildCommunityIssuePublishedCard (published state)', () => {
    const publishedDraft = {
      ...draftFixture,
      status: 'published',
      githubIssueNumber: 347,
      githubIssueUrl: 'https://github.com/clowder-ai/cat-cafe/issues/347',
      publishedAt: Date.now(),
    };

    it('returns card with published info', async () => {
      const { buildCommunityIssuePublishedCard } = await loadModule();
      const card = buildCommunityIssuePublishedCard(publishedDraft);
      assert.equal(card.kind, 'card');
      assert.ok(card.bodyMarkdown.includes('347') || card.bodyMarkdown.includes('github.com'));
    });

    it('includes github link in body', async () => {
      const { buildCommunityIssuePublishedCard } = await loadModule();
      const card = buildCommunityIssuePublishedCard(publishedDraft);
      assert.ok(card.bodyMarkdown.includes('https://github.com/clowder-ai/cat-cafe/issues/347'));
    });

    it('has tone=success', async () => {
      const { buildCommunityIssuePublishedCard } = await loadModule();
      const card = buildCommunityIssuePublishedCard(publishedDraft);
      assert.equal(card.tone, 'success');
    });

    it('has correct meta with published status', async () => {
      const { buildCommunityIssuePublishedCard } = await loadModule();
      const card = buildCommunityIssuePublishedCard(publishedDraft);
      assert.equal(card.meta.kind, 'community_issue_preview');
      assert.equal(card.meta.draftId, 'cid_test1');
    });
  });
});
