import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

/**
 * F235 Phase B: Generic community issue draft creation + config.
 *
 * POST /api/community-issue-drafts       — create cat_initiated draft (generic)
 * GET  /api/community-issue-drafts/config — repo picker config
 */

let app;
let draftStore;
let mockPublisherCalls;

const testUserId = 'usr_test1';

describe('F235 Phase B: Generic draft creation', () => {
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
          issueNumber: 500,
          issueUrl: `https://github.com/${input.repo}/issues/500`,
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

  // ── POST /api/community-issue-drafts ──

  describe('POST /api/community-issue-drafts', () => {
    it('creates a cat_initiated draft with valid input', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'conv_123',
          title: 'Bug: tool calls fail silently',
          bodyMarkdown: '## Problem\n\nTool calls return empty response.',
          targetRepo: 'clowder-ai/cat-cafe',
          labels: ['bug'],
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload);
      assert.equal(body.draft.sourceType, 'cat_initiated');
      assert.equal(body.draft.status, 'draft');
      assert.ok(body.draft.draftId.startsWith('cid_'));
      assert.equal(body.draft.targetRepo, 'clowder-ai/cat-cafe');
      assert.deepEqual(body.draft.labels, ['bug']);
      assert.equal(body.draft.threadId, 'thread_abc');
      assert.equal(body.draft.userId, testUserId);
    });

    it('rejects repo not in allowlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'conv_456',
          title: 'Test',
          bodyMarkdown: 'body',
          targetRepo: 'evil-org/evil-repo',
          labels: [],
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.ok(body.error.toLowerCase().includes('allow'), `Expected allowlist error: ${body.error}`);
    });

    it('defaults to defaultRepo when targetRepo omitted', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'conv_789',
          title: 'Test',
          bodyMarkdown: 'body',
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload);
      assert.equal(body.draft.targetRepo, 'clowder-ai/cat-cafe');
    });

    it('sanitizes content on creation', async () => {
      // sk- pattern requires 20+ chars after prefix to match real API keys
      const fakeKey = 'sk-ant-abcdefghijklmnopqrstuvwxyz1234';
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'conv_sanitize',
          title: `Test with ${fakeKey} secret`,
          bodyMarkdown: 'body with /home/user/secret/path',
          targetRepo: 'clowder-ai/cat-cafe',
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.payload}`);
      const draft = JSON.parse(res.payload).draft;
      assert.ok(!draft.title.includes(fakeKey), `Title not sanitized: ${draft.title}`);
      assert.ok(!draft.bodyMarkdown.includes('/home/user'), `Body not sanitized: ${draft.bodyMarkdown}`);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'conv_noauth',
          title: 'Test',
          bodyMarkdown: 'body',
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 401);
    });

    it('rejects empty title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'conv_empty',
          title: '',
          bodyMarkdown: 'body',
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 400);
    });

    it('allows alternate repo from allowlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'conv_tutorials',
          title: 'Tutorial fix',
          bodyMarkdown: 'The tutorial has a typo',
          targetRepo: 'clowder-ai/cat-cafe-tutorials',
          labels: ['docs'],
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload);
      assert.equal(body.draft.targetRepo, 'clowder-ai/cat-cafe-tutorials');
    });
  });

  // ── Retry + Idempotency (R1 P1-1: retry after failed publish) ──

  describe('idempotent create (P1-1 + P1-2 fix)', () => {
    it('returns existing active draft on duplicate sourceId (idempotent retry)', async () => {
      const payload = {
        sourceType: 'cat_initiated',
        sourceId: 'block_retry_1',
        title: 'Retry test',
        bodyMarkdown: 'body',
        targetRepo: 'clowder-ai/cat-cafe',
        threadId: 'thread_abc',
      };

      // First create → 200 with new draft
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload,
      });
      assert.equal(res1.statusCode, 200, `First create failed: ${res1.payload}`);
      const draft1 = JSON.parse(res1.payload).draft;
      assert.ok(draft1.draftId);

      // Second create with same sourceId → should return SAME draft, not 500
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload,
      });
      assert.equal(res2.statusCode, 200, `Retry create should be 200, got ${res2.statusCode}: ${res2.payload}`);
      const draft2 = JSON.parse(res2.payload).draft;
      assert.equal(draft2.draftId, draft1.draftId, 'Retry should return same draft (idempotent)');
    });

    it('different users with same block.id do not collide (P1-2)', async () => {
      const sharedSourceId = 'b_draft_1'; // Same block.id from different cards

      // User A creates draft
      const resA = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': 'usr_alice' },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: sharedSourceId,
          title: 'Alice issue',
          bodyMarkdown: 'Alice body',
          targetRepo: 'clowder-ai/cat-cafe',
          threadId: 'thread_alice',
        },
      });
      assert.equal(resA.statusCode, 200, `User A create failed: ${resA.payload}`);
      const draftA = JSON.parse(resA.payload).draft;

      // User B creates draft with same sourceId → should succeed with DIFFERENT draft
      const resB = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': 'usr_bob' },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: sharedSourceId,
          title: 'Bob issue',
          bodyMarkdown: 'Bob body',
          targetRepo: 'clowder-ai/cat-cafe',
          threadId: 'thread_bob',
        },
      });
      assert.equal(resB.statusCode, 200, `User B create should succeed, got ${resB.statusCode}: ${resB.payload}`);
      const draftB = JSON.parse(resB.payload).draft;
      assert.notEqual(draftB.draftId, draftA.draftId, 'Different users should get separate drafts');
    });

    it('same user, same block.id, different messageId → separate drafts (R2 P1)', async () => {
      const sharedBlockId = 'b_draft_1';

      // Thread A: user creates draft from message msg_a
      const resA = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: sharedBlockId,
          title: 'Thread A issue',
          bodyMarkdown: 'Thread A body',
          targetRepo: 'clowder-ai/cat-cafe',
          threadId: 'thread_a',
          messageId: 'msg_thread_a_001',
        },
      });
      assert.equal(resA.statusCode, 200, `Thread A create failed: ${resA.payload}`);
      const draftA = JSON.parse(resA.payload).draft;

      // Thread B: same user, same block.id, different messageId
      const resB = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: sharedBlockId,
          title: 'Thread B issue',
          bodyMarkdown: 'Thread B body',
          targetRepo: 'clowder-ai/cat-cafe',
          threadId: 'thread_b',
          messageId: 'msg_thread_b_001',
        },
      });
      assert.equal(resB.statusCode, 200, `Thread B should get its own draft: ${resB.payload}`);
      const draftB = JSON.parse(resB.payload).draft;
      assert.notEqual(draftB.draftId, draftA.draftId, 'Different messages should produce separate drafts');
    });

    it('scoped sourceId includes userId (persisted in draft)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload: {
          sourceType: 'cat_initiated',
          sourceId: 'block_scope_test',
          title: 'Scope test',
          bodyMarkdown: 'body',
          targetRepo: 'clowder-ai/cat-cafe',
          threadId: 'thread_abc',
        },
      });
      assert.equal(res.statusCode, 200);
      const draft = JSON.parse(res.payload).draft;
      // sourceId should be scoped to include userId to prevent cross-user collision
      assert.ok(draft.sourceId.includes(testUserId), `sourceId should be user-scoped, got: ${draft.sourceId}`);
    });
  });

  // ── Post-publish create guard (Cloud P2-1: already-published draft idempotency) ──

  describe('post-publish create guard (Cloud P2-1)', () => {
    it('returns 409 with published draft when re-creating after publish', async () => {
      const payload = {
        sourceType: 'cat_initiated',
        sourceId: 'block_pub_guard',
        title: 'Published guard test',
        bodyMarkdown: 'body',
        targetRepo: 'clowder-ai/cat-cafe',
        threadId: 'thread_abc',
      };

      // Step 1: Create draft
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload,
      });
      assert.equal(createRes.statusCode, 200, `Create failed: ${createRes.payload}`);
      const draft = JSON.parse(createRes.payload).draft;

      // Step 2: Publish the draft
      const pubRes = await app.inject({
        method: 'POST',
        url: `/api/community-issue-drafts/${draft.draftId}/publish`,
        headers: { 'x-cat-cafe-user': testUserId },
        payload: { title: draft.title, bodyMarkdown: draft.bodyMarkdown },
      });
      assert.equal(pubRes.statusCode, 200, `Publish failed: ${pubRes.payload}`);

      // Step 3: Re-create with same sourceId → should get 409 (not 500!)
      const retryRes = await app.inject({
        method: 'POST',
        url: '/api/community-issue-drafts',
        headers: { 'x-cat-cafe-user': testUserId },
        payload,
      });
      assert.equal(
        retryRes.statusCode,
        409,
        `Expected 409 for already-published, got ${retryRes.statusCode}: ${retryRes.payload}`,
      );
      const retryBody = JSON.parse(retryRes.payload);
      assert.ok(retryBody.error.includes('published'), `Error should mention published: ${retryBody.error}`);
      assert.equal(retryBody.draft.draftId, draft.draftId, 'Should return the published draft');
      assert.equal(retryBody.draft.status, 'published');
    });
  });

  // ── Concurrent create race (Cloud P2-5: two tabs → INV-3 loser recovery) ──

  describe('concurrent create race (Cloud P2-5)', () => {
    it('recovers from INV-3 race by returning winner draft', async () => {
      const payload = {
        sourceType: 'cat_initiated',
        sourceId: 'block_race_test',
        title: 'Race test',
        bodyMarkdown: 'body',
        targetRepo: 'clowder-ai/cat-cafe',
        threadId: 'thread_abc',
      };

      // Fire two concurrent creates with the same sourceId
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/community-issue-drafts',
          headers: { 'x-cat-cafe-user': testUserId },
          payload,
        }),
        app.inject({
          method: 'POST',
          url: '/api/community-issue-drafts',
          headers: { 'x-cat-cafe-user': testUserId },
          payload,
        }),
      ]);

      // Both should succeed (200) — one creates, one recovers via idempotent path
      // Neither should be 500 (the race loser should re-read, not crash)
      assert.ok(
        res1.statusCode === 200 && res2.statusCode === 200,
        `Both creates should succeed: res1=${res1.statusCode} res2=${res2.statusCode}. ` +
          `res1: ${res1.payload.slice(0, 200)}, res2: ${res2.payload.slice(0, 200)}`,
      );

      // Both should return the same draftId
      const draft1 = JSON.parse(res1.payload).draft;
      const draft2 = JSON.parse(res2.payload).draft;
      assert.equal(draft1.draftId, draft2.draftId, 'Both should converge on same draft');
    });
  });

  // ── GET /api/community-issue-drafts/config ──

  describe('GET /api/community-issue-drafts/config', () => {
    it('returns defaultRepo and repos list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/community-issue-drafts/config',
        headers: { 'x-cat-cafe-user': testUserId },
      });
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload);
      assert.equal(body.defaultRepo, 'clowder-ai/cat-cafe');
      assert.ok(Array.isArray(body.repos));
      assert.ok(body.repos.includes('clowder-ai/cat-cafe'));
      assert.ok(body.repos.includes('clowder-ai/cat-cafe-tutorials'));
    });

    it('rejects unauthenticated requests', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/community-issue-drafts/config',
      });
      assert.equal(res.statusCode, 401);
    });
  });
});
