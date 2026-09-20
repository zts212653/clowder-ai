/**
 * #1392 AC-7 at the route, not only in the function that computes it.
 *
 * A previous round of this work shipped an expansion helper with green unit tests while the public
 * entry never called it — the same shape of gap that let a cap regression pass every suite. So these
 * cases drive the real endpoint and read the expansion back out of what the registration returns,
 * which is also where a caller sees it.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('#1392 AC-7: POST /api/callbacks/register-pr-tracking', () => {
  let registry;
  let threadStore;
  let taskStore;
  let messageStore;

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
  });

  async function post(payload) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      taskStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, getMessages: () => [] },
      evidenceStore: { search: async () => [] },
      reflectionService: {},
      markerQueue: { list: async () => [], transition: async () => {} },
      fetchPrWaitBaseline: async () => ({
        baseline: { capturedAt: 100, headSha: 'test-head' },
        collectorState: { ci: { headSha: 'test-head' } },
      }),
    });
    const thread = await threadStore.create('user-1', 'ac7-thread');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', ...payload },
    });
  }

  const armedKinds = (response) =>
    JSON.parse(response.body)
      .await.continuation.when.map((predicate) => predicate.kind)
      .sort();

  /*
   * #1392 AC-7: `nextStep` is a note to the owner, never a condition. Requiring it forced every caller
   * to invent a sentence before they could register, and an invented sentence invites the next reader
   * to treat it as policy. The matcher never reads it either way.
   */
  test('a registration without a nextStep still gets one, written deterministically', async () => {
    const response = await post({ prNumber: 910 });

    assert.equal(response.statusCode, 200, 'display-only text must not gate registering');
    const written = JSON.parse(response.body).await.continuation.then;
    assert.match(written, /continue the responsibility you already hold/);
  });

  test('a nextStep that was supplied is kept exactly as given', async () => {
    const mine = 'Re-read the accepted source before replying.';
    const response = await post({ prNumber: 911, nextStep: mine });

    assert.equal(JSON.parse(response.body).await.continuation.then, mine);
  });

  test('a registration that names nothing is accepted and arms the PR’s own conditions', async () => {
    const response = await post({ prNumber: 900 });

    assert.equal(response.statusCode, 200, 'the common path must not require naming conditions');
    assert.deepEqual(armedKinds(response), [
      'pr_became_conflicting',
      'pr_ci_terminal',
      'pr_head_changed',
      'pr_review_decision_changed',
    ]);
  });

  test('naming who you wait on also arms both comment surfaces with that audience', async () => {
    const response = await post({
      prNumber: 901,
      goal: { kind: 'await_reply_from', authorLogins: ['pr-author'] },
    });

    assert.equal(response.statusCode, 200);
    const armed = armedKinds(response);
    assert.ok(armed.includes('pr_conversation_comment_added'));
    assert.ok(armed.includes('pr_inline_comment_added'));
    for (const predicate of JSON.parse(response.body).await.continuation.when) {
      if (predicate.kind.endsWith('comment_added')) {
        assert.deepEqual(predicate.authorLogins, ['pr-author']);
      }
    }
  });

  test('an explicit when[] is still used exactly as given', async () => {
    const response = await post({ prNumber: 902, when: [{ kind: 'pr_ci_terminal' }] });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(armedKinds(response), ['pr_ci_terminal'], 'the advanced path must stay untouched');
  });

  test('stating a goal and contradicting it with when[] is refused', async () => {
    const response = await post({
      prNumber: 903,
      when: [{ kind: 'pr_ci_terminal' }],
      goal: { kind: 'await_reply_from', authorLogins: ['pr-author'] },
    });

    assert.equal(response.statusCode, 400);
  });

  test('a goal naming nobody is refused rather than widened to everyone', async () => {
    const response = await post({
      prNumber: 904,
      goal: { kind: 'await_reply_from', authorLogins: ['   '] },
    });

    assert.equal(response.statusCode, 400);
  });
});
