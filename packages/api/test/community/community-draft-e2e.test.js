import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

/**
 * F235 Phase B: End-to-end integration — generic create → get → publish → get.
 *
 * Exercises the full lifecycle: generic create endpoint → sanitization →
 * store → publish (mocked GitHub) → terminal published state.
 */

let app;
let draftStore;
let mockPublisherCalls;

const testUserId = 'usr_e2e';

describe('F235 Phase B: cat-initiated draft → publish e2e', () => {
  beforeEach(async () => {
    const { InMemoryCommunityIssueDraftStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryCommunityIssueDraftStore.js'
    );
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const { communityIssueDraftRoutes } = await import('../../dist/routes/community-issue-draft-routes.js');

    draftStore = new InMemoryCommunityIssueDraftStore();
    const frustrationIssueStore = new InMemoryFrustrationIssueStore();
    mockPublisherCalls = [];

    const mockPublisher = {
      async publish(input) {
        mockPublisherCalls.push(input);
        return {
          issueNumber: 999,
          issueUrl: `https://github.com/${input.repo}/issues/999`,
        };
      },
    };

    app = Fastify();
    await app.register(communityIssueDraftRoutes, {
      communityIssueDraftStore: draftStore,
      frustrationIssueStore,
      publisher: mockPublisher,
      config: {
        defaultRepo: 'clowder-ai/cat-cafe',
        repoAllowlist: ['clowder-ai/cat-cafe', 'clowder-ai/cat-cafe-tutorials'],
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('generic create → get → publish → get shows published', async () => {
    // 1. Create draft via generic endpoint
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/community-issue-drafts',
      headers: { 'x-cat-cafe-user': testUserId },
      payload: {
        sourceType: 'cat_initiated',
        sourceId: 'e2e_test_1',
        title: 'E2E: test issue',
        bodyMarkdown: '## Problem\n\nTest e2e flow',
        targetRepo: 'clowder-ai/cat-cafe',
        labels: ['test'],
        threadId: 'thread_e2e',
      },
    });
    assert.equal(createRes.statusCode, 200, `Create failed: ${createRes.payload}`);
    const createBody = JSON.parse(createRes.payload);
    const { draftId } = createBody.draft;
    assert.ok(draftId, 'Expected draftId');
    assert.equal(createBody.draft.sourceType, 'cat_initiated');
    assert.equal(createBody.draft.status, 'draft');

    // 2. Get draft — verify content was stored
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/community-issue-drafts/${draftId}`,
      headers: { 'x-cat-cafe-user': testUserId },
    });
    assert.equal(getRes.statusCode, 200, `Get failed: ${getRes.payload}`);
    const getDraft = JSON.parse(getRes.payload).draft;
    assert.equal(getDraft.status, 'draft');
    assert.equal(getDraft.title, 'E2E: test issue');

    // 3. Publish with edited title (mocked GitHub)
    const pubRes = await app.inject({
      method: 'POST',
      url: `/api/community-issue-drafts/${draftId}/publish`,
      headers: { 'x-cat-cafe-user': testUserId },
      payload: { title: 'E2E: edited title' },
    });
    assert.equal(pubRes.statusCode, 200, `Publish failed: ${pubRes.payload}`);
    const pubBody = JSON.parse(pubRes.payload);
    assert.equal(pubBody.draft.status, 'published');
    assert.ok(pubBody.githubIssueUrl, 'Expected githubIssueUrl');
    assert.equal(pubBody.draft.githubIssueNumber, 999);

    // Verify mock publisher was called with correct args
    assert.equal(mockPublisherCalls.length, 1);
    assert.equal(mockPublisherCalls[0].repo, 'clowder-ai/cat-cafe');
    assert.equal(mockPublisherCalls[0].title, 'E2E: edited title');

    // 4. Get again — published is terminal
    const finalRes = await app.inject({
      method: 'GET',
      url: `/api/community-issue-drafts/${draftId}`,
      headers: { 'x-cat-cafe-user': testUserId },
    });
    assert.equal(finalRes.statusCode, 200);
    assert.equal(JSON.parse(finalRes.payload).draft.status, 'published');
  });

  it('generic create → cancel → get shows cancelled', async () => {
    // 1. Create
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/community-issue-drafts',
      headers: { 'x-cat-cafe-user': testUserId },
      payload: {
        sourceType: 'cat_initiated',
        sourceId: 'e2e_cancel_1',
        title: 'E2E: cancel test',
        bodyMarkdown: 'Will be cancelled',
        targetRepo: 'clowder-ai/cat-cafe',
        threadId: 'thread_e2e',
      },
    });
    assert.equal(createRes.statusCode, 200);
    const { draftId } = JSON.parse(createRes.payload).draft;

    // 2. Cancel
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/community-issue-drafts/${draftId}/cancel`,
      headers: { 'x-cat-cafe-user': testUserId },
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(JSON.parse(cancelRes.payload).draft.status, 'cancelled');

    // 3. Get — cancelled is terminal
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/community-issue-drafts/${draftId}`,
      headers: { 'x-cat-cafe-user': testUserId },
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(JSON.parse(getRes.payload).draft.status, 'cancelled');

    // 4. Cannot publish after cancel (INV-1)
    const retryPub = await app.inject({
      method: 'POST',
      url: `/api/community-issue-drafts/${draftId}/publish`,
      headers: { 'x-cat-cafe-user': testUserId },
    });
    assert.equal(retryPub.statusCode, 409);
  });

  it('tutorials repo publish works through full pipeline', async () => {
    // Verify AC-B2: alternate repo from allowlist
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/community-issue-drafts',
      headers: { 'x-cat-cafe-user': testUserId },
      payload: {
        sourceType: 'cat_initiated',
        sourceId: 'e2e_tutorials_1',
        title: 'Tutorial typo fix',
        bodyMarkdown: 'Page 3 has a typo',
        targetRepo: 'clowder-ai/cat-cafe-tutorials',
        labels: ['docs'],
        threadId: 'thread_e2e',
      },
    });
    assert.equal(createRes.statusCode, 200);
    const { draftId } = JSON.parse(createRes.payload).draft;
    assert.equal(JSON.parse(createRes.payload).draft.targetRepo, 'clowder-ai/cat-cafe-tutorials');

    // Publish to tutorials repo
    const pubRes = await app.inject({
      method: 'POST',
      url: `/api/community-issue-drafts/${draftId}/publish`,
      headers: { 'x-cat-cafe-user': testUserId },
    });
    assert.equal(pubRes.statusCode, 200);
    assert.equal(mockPublisherCalls[0].repo, 'clowder-ai/cat-cafe-tutorials');
    assert.ok(pubRes.payload.includes('cat-cafe-tutorials'));
  });
});
