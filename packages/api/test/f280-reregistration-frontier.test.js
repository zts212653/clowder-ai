/**
 * #1394 §2.5b — re-registration may hold or rewind the frontier, never advance it.
 *
 * Failure shape this pins (§4 A22): a cat is woken for comment #100, works, comments
 * #101/#102 arrive, the cat re-registers, the baseline is re-frozen at #102, and
 * #101/#102 are never delivered. Silent loss, no error anywhere.
 *
 * The baseline reader deliberately returns a HIGHER snapshot on the second call —
 * that is what "time passed between the two registrations" looks like.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('#1394 §2.5b re-registration frontier', () => {
  let registry;
  let threadStore;
  let taskStore;
  let messageStore;
  let baselineCalls;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    baselineCalls = 0;
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, getMessages: () => [] },
      threadStore,
      evidenceStore: { list: async () => [], transition: async () => {} },
      reflectionService: {},
      markerQueue: {},
      taskStore,
      // Second call reports a LATER frontier — comments arrived between registrations.
      fetchPrWaitBaseline: async () => {
        baselineCalls += 1;
        const bump = baselineCalls === 1 ? 0 : 1000;
        return {
          baseline: {
            capturedAt: 100 + bump,
            headSha: 'head-sha',
            review: {
              inlineCommentCursor: 10 + bump,
              conversationCommentCursor: 20 + bump,
              decisionCursor: 30 + bump,
            },
            ci: { bucket: 'pass', fingerprint: 'head-sha:pass' },
            conflict: { mergeState: 'MERGEABLE' },
            base: { isBehind: false },
          },
          collectorState: {
            review: {
              lastCommentCursor: 20 + bump,
              lastInlineCommentCursor: 10 + bump,
              lastConversationCommentCursor: 20 + bump,
              lastDecisionCursor: 30 + bump,
            },
            ci: { headSha: 'head-sha', lastFingerprint: 'head-sha:pass', lastBucket: 'pass' },
            conflict: { mergeState: 'MERGEABLE' },
          },
        };
      },
      fetchIssueWaitBaseline: async () => {
        baselineCalls += 1;
        const bump = baselineCalls === 1 ? 0 : 1000;
        return {
          baseline: { capturedAt: 100 + bump, issue: { lastCommentCursor: 5 + bump, state: 'open' } },
          collectorState: {
            issue: { lastCommentCursor: 5 + bump, lastDeliveredCursor: 5 + bump, issueState: 'open' },
          },
        };
      },
    });
    return app;
  }

  async function register(app, url, payload) {
    const thread = await threadStore.create('user-1', 'normal-thread');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
    return app.inject({
      method: 'POST',
      url,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload,
    });
  }

  test('PR: a second registration keeps the original frontier instead of jumping to now', async () => {
    const app = await createApp();
    const url = '/api/callbacks/register-pr-tracking';
    const payload = { repoFullName: 'owner/repo', prNumber: 7 };

    assert.equal((await register(app, url, payload)).statusCode, 200);
    const first = taskStore.getBySubject('pr:owner/repo#7').automationState;
    assert.deepEqual(first.await.baseline.review, {
      inlineCommentCursor: 10,
      conversationCommentCursor: 20,
      decisionCursor: 30,
    });

    assert.equal((await register(app, url, payload)).statusCode, 200);
    assert.equal(baselineCalls, 2, 'the live snapshot was re-read and reported a later frontier');
    const second = taskStore.getBySubject('pr:owner/repo#7').automationState;

    assert.deepEqual(
      second.await.baseline.review,
      { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 30 },
      're-registration must not advance the baseline — the gap items would be lost silently',
    );
    assert.equal(
      second.review.lastConversationCommentCursor,
      20,
      'the collector frontier must not advance either, or the poller never re-fetches the gap',
    );
    assert.ok(second.await.generation > first.await.generation, 'it is still a new generation');
  });

  test('issue: a second registration keeps the original comment frontier', async () => {
    const app = await createApp();
    const url = '/api/callbacks/register-issue-tracking';
    const payload = { repoFullName: 'owner/repo', issueNumber: 42 };

    assert.equal((await register(app, url, payload)).statusCode, 200);
    assert.equal(
      taskStore.getBySubject('issue:owner/repo#42').automationState.await.baseline.issue.lastCommentCursor,
      5,
    );

    assert.equal((await register(app, url, payload)).statusCode, 200);
    const second = taskStore.getBySubject('issue:owner/repo#42').automationState;
    assert.equal(second.await.baseline.issue.lastCommentCursor, 5, 're-registration must not advance the frontier');
    assert.equal(second.issue.lastCommentCursor, 5, 'collector frontier must not advance either');
  });

  test('a FIRST registration still freezes at now (A12 is unaffected)', async () => {
    const app = await createApp();
    const response = await register(app, '/api/callbacks/register-pr-tracking', {
      repoFullName: 'owner/other',
      prNumber: 9,
    });

    assert.equal(response.statusCode, 200);
    const state = taskStore.getBySubject('pr:owner/other#9').automationState;
    assert.equal(
      state.await.baseline.review.conversationCommentCursor,
      20,
      'with no prior wait the live snapshot is the baseline — pre-registration history must not fire',
    );
  });
});
