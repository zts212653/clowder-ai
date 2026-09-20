/**
 * #1392 AC-7 at the route, not only in the function that computes it.
 *
 * A previous round of this work shipped an expansion helper with green unit tests while the public
 * entry never called it — the same shape of gap that let a cap regression pass every suite. So these
 * cases drive the real endpoints and read the expansion back out of what the registration returns,
 * which is also where a caller sees it.
 *
 * Both entries are here together on purpose. The PR side and the issue side share one accepted
 * contract — name the subject, hear what happens on it — and splitting them across files is how the
 * issue side kept its mandatory `when[]` for three rounds while "AC-7 is in" was true of the PR side.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const AUTHOR_IDENTITY = { selfLogin: 'mindfn', subjectAuthorLogin: 'mindfn' };
const REVIEWER_IDENTITY = {
  selfLogin: 'mindfn',
  subjectAuthorLogin: 'zts212653',
  reviewerGround: 'review_requested',
};

describe('#1392 AC-7: registration routes', () => {
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

  async function inject(url, payload, deps = {}) {
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
      fetchIssueWaitBaseline: async () => ({
        baseline: { capturedAt: 100, issue: { lastCommentCursor: 7, state: 'open' } },
        collectorState: { issue: { lastCommentCursor: 7, lastDeliveredCursor: 7, issueState: 'open' } },
      }),
      resolveGitHubPrTrackingIdentity: async () => AUTHOR_IDENTITY,
      resolveGitHubSelfLogin: async () => 'mindfn',
      ...deps,
    });
    const thread = await threadStore.create('user-1', 'ac7-thread');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
    return app.inject({
      method: 'POST',
      url,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', ...payload },
    });
  }

  const post = (payload, deps) => inject('/api/callbacks/register-pr-tracking', payload, deps);
  const postIssue = (payload, deps) => inject('/api/callbacks/register-issue-tracking', payload, deps);

  const body = (response) => JSON.parse(response.body);
  const armedKinds = (response) =>
    body(response)
      .await.continuation.when.map((predicate) => predicate.kind)
      .sort();
  const commentAudiences = (response) =>
    body(response)
      .await.continuation.when.filter((predicate) => predicate.kind.endsWith('comment_added'))
      .map((predicate) => predicate.audience);

  /*
   * #1392 AC-7: `nextStep` is a note to the owner, never a condition. Requiring it forced every caller
   * to invent a sentence before they could register, and an invented sentence invites the next reader
   * to treat it as policy. The matcher never reads it either way.
   */
  test('a registration without a nextStep still gets one, written deterministically', async () => {
    const response = await post({ prNumber: 910 });

    assert.equal(response.statusCode, 200, 'display-only text must not gate registering');
    assert.match(body(response).await.continuation.then, /continue the responsibility you already hold/);
  });

  test('a nextStep that was supplied is kept exactly as given', async () => {
    const mine = 'Re-read the accepted source before replying.';
    const response = await post({ prNumber: 911, nextStep: mine });

    assert.equal(body(response).await.continuation.then, mine);
  });

  test('a PR registration that names nothing arms the PR’s conditions AND its comments', async () => {
    const response = await post({ prNumber: 900 });

    assert.equal(response.statusCode, 200, 'the common path must not require naming conditions');
    assert.deepEqual(armedKinds(response), [
      'pr_became_conflicting',
      'pr_ci_terminal',
      'pr_conversation_comment_added',
      'pr_head_changed',
      'pr_inline_comment_added',
      'pr_review_decision_changed',
    ]);
  });

  test('the author perspective reaches the armed predicate, not only the helper', async () => {
    const response = await post({ prNumber: 905 });

    for (const audience of commentAudiences(response)) {
      assert.deepEqual(audience, { mode: 'everyone_but_self', selfLogin: 'mindfn' });
    }
    assert.deepEqual(body(response).notification.perspective, { role: 'subject_author', selfLogin: 'mindfn' });
  });

  test('a reviewer with a checkable ground gets the narrow audience', async () => {
    const response = await post({ prNumber: 906 }, { resolveGitHubPrTrackingIdentity: async () => REVIEWER_IDENTITY });

    for (const audience of commentAudiences(response)) {
      assert.deepEqual(audience, { mode: 'subject_author_only', subjectAuthorLogin: 'zts212653' });
    }
    assert.equal(body(response).notification.perspective.ground, 'review_requested');
  });

  /*
   * The correction that reversed an earlier plan (#1392 issue comment 5747771227): an identity that
   * cannot be resolved must not become an error left in a return value. The owner is the only party
   * who can act and the only one structurally unable to notice, so tracking installs and every
   * comment is delivered flagged.
   */
  test('an identity lookup that throws still registers, and says coverage is not established', async () => {
    const response = await post(
      { prNumber: 907 },
      {
        resolveGitHubPrTrackingIdentity: async () => {
          throw new Error('gh api exploded');
        },
      },
    );

    assert.equal(response.statusCode, 200, 'one failed role lookup must not close the whole tracking');
    assert.equal(body(response).notification.perspective.role, 'unresolved');
    assert.equal(commentAudiences(response).length, 2, 'comments stay armed or the failure becomes silence');
    for (const line of body(response).notification.commentFilters) {
      assert.match(line, /coverage is NOT established/);
    }
  });

  test('a failed identity lookup leaves a whole registration, never half of one', async () => {
    const response = await post(
      { prNumber: 908 },
      {
        resolveGitHubPrTrackingIdentity: async () => {
          throw new Error('gh api exploded');
        },
      },
    );

    const installed = body(response).task;
    assert.equal(installed.automationState.await.generation, 1);
    assert.ok(installed.automationState.await.baseline.headSha, 'a baseline was frozen');
    assert.equal(installed.automationState.ci.headSha, 'test-head', 'collector cursors were installed');
    assert.equal(taskStore.listByKind('pr_tracking').filter((t) => t.subjectKey === 'pr:owner/repo#908').length, 1);
  });

  /*
   * #1392 R2: this case used to assert `audience === undefined` — it locked in the defect. Dropping
   * the derived audience made a named list REPLACE the accepted rule rather than narrow it, so a
   * named passer-by reached a maintainer and a caller who named themselves heard their own comments.
   * The armed predicate now carries both, and both apply.
   */
  test('naming who you wait on narrows the derived audience without replacing it', async () => {
    const response = await post({
      prNumber: 901,
      goal: { kind: 'await_reply_from', authorLogins: ['pr-author'] },
    });

    assert.equal(response.statusCode, 200);
    let commentSurfaces = 0;
    for (const predicate of body(response).await.continuation.when) {
      if (predicate.kind.endsWith('comment_added')) {
        commentSurfaces += 1;
        assert.deepEqual(predicate.authorLogins, ['pr-author'], 'the caller’s narrowing is armed');
        assert.ok(predicate.audience, 'and the derived rule it narrows is still armed beside it');
      }
    }
    assert.equal(commentSurfaces, 2, 'both comment surfaces');
  });

  test('an explicit when[] is still used exactly as given', async () => {
    const response = await post({ prNumber: 902, when: [{ kind: 'pr_ci_terminal' }] });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(armedKinds(response), ['pr_ci_terminal'], 'the advanced path must stay untouched');
  });

  test('an explicit comment predicate keeps its allowlist and gets no derived audience', async () => {
    const response = await post({
      prNumber: 909,
      when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['zts212653'] }],
    });

    const [predicate] = body(response).await.continuation.when;
    assert.deepEqual(predicate.authorLogins, ['zts212653']);
    assert.equal(predicate.audience, undefined, 'role filtering must not be slipped onto a precise wait');
  });

  test('a caller cannot hand-write an audience the server never verified', async () => {
    const response = await post({
      prNumber: 912,
      when: [{ kind: 'pr_conversation_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'someone' } }],
    });

    assert.equal(response.statusCode, 400, 'an audience is a claim about identity, so only the server writes one');
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

  test('an issue registration needs only the subject, and hears every comment that is not ours', async () => {
    const response = await postIssue({ issueNumber: 1392 });

    assert.equal(
      response.statusCode,
      200,
      'the issue entry kept a mandatory when[] long after the PR entry dropped it',
    );
    assert.deepEqual(body(response).await.continuation.when, [
      { kind: 'issue_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'mindfn' } },
    ]);
    assert.match(body(response).notification.commentFilters[0], /except mindfn \(you\)/);
  });

  test('an issue registration without a nextStep still gets the deterministic one', async () => {
    const response = await postIssue({ issueNumber: 1393 });

    assert.match(body(response).await.continuation.then, /continue the responsibility you already hold/);
  });

  test('an explicit issue when[] is still used exactly as given', async () => {
    const response = await postIssue({ issueNumber: 1394, when: [{ kind: 'issue_author_commented' }] });

    assert.deepEqual(body(response).await.continuation.when, [{ kind: 'issue_author_commented' }]);
  });

  test('an issue registration with no resolvable self login flags instead of meaning "anyone"', async () => {
    const response = await postIssue({ issueNumber: 1395 }, { resolveGitHubSelfLogin: async () => undefined });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(body(response).await.continuation.when[0].audience, {
      mode: 'unresolved_identity',
      missing: ['self'],
    });
  });
});
