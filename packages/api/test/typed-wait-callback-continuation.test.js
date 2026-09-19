import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

async function harness(t, options = {}) {
  const registry = new InvocationRegistry();
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = threadStore.create('user-1', 'typed wait continuation');
  const activeInputMessageIds = [];
  const appendHold = (suffix) => {
    const holdTaskId = `hold-${suffix}`;
    const message = messageStore.append({
      from: { kind: 'system', service: 'hold-ball' },
      userId: 'user-1',
      threadId: thread.id,
      content: 'Command complete.',
      mentions: [],
      timestamp: Date.now(),
      source: {
        connector: 'hold-ball',
        label: 'command',
        icon: 'hold-ball',
        meta: {
          wakeWhen: true,
          managedHold: true,
          phase: 'wake',
          taskId: holdTaskId,
          threadId: thread.id,
          catId: 'opus',
        },
      },
    });
    return {
      sourceMessageId: message.id,
      taskId: holdTaskId,
    };
  };
  const primary = options.primaryHold ? appendHold('primary') : undefined;
  const source = primary
    ? messageStore.getById(primary.sourceMessageId)
    : messageStore.append({
        from: { kind: 'user', userId: 'user-1' },
        userId: 'user-1',
        threadId: thread.id,
        content: 'Continue the owner task.',
        mentions: [],
        timestamp: Date.now(),
      });
  activeInputMessageIds.push(source.id);
  const auth = await registry.create('user-1', 'opus', thread.id, undefined, undefined, undefined, source.id, 'strict');
  const invocationTracker = {
    getActiveSlots: () => [
      {
        catId: 'opus',
        startedAt: Date.now(),
        activeRun: {
          threadId: thread.id,
          targetId: 'opus',
          invocationId: auth.invocationId,
          responseMessageId: 'response-1',
          inputEntryIds: [],
          inputMessageIds: [...activeInputMessageIds],
          privateInputEntryIds: [],
          startedAt: Date.now(),
        },
      },
    ],
  };
  let baselineHook = async () => {};
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    invocationTracker,
    taskStore,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, getMessages: () => [] },
    evidenceStore: { search: async () => [], health: async () => true },
    reflectionService: { reflect: async () => '' },
    markerQueue: { list: async () => [] },
    fetchPrWaitBaseline: async () => {
      await baselineHook();
      return { baseline: { capturedAt: Date.now(), headSha: 'head-1' }, collectorState: {} };
    },
    fetchIssueWaitBaseline: async () => ({ baseline: { capturedAt: Date.now(), author: 'owner' }, collectorState: {} }),
    verifyPrReviewEventWaitCoverage: async () => ({ covered: true }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const identity = {
    threadId: thread.id,
    catId: 'opus',
    userId: 'user-1',
    invocationId: auth.invocationId,
    sourceMessageId: source.id,
    ...(primary ? { holdTaskId: primary.taskId } : {}),
  };
  return {
    taskStore,
    identity,
    messageStore,
    onBaseline(fn) {
      baselineHook = fn;
    },
    async adoptHold(suffix) {
      const wake = appendHold(suffix);
      activeInputMessageIds.push(wake.sourceMessageId);
      return wake;
    },
    async register(when, kind = 'pr') {
      const response = await fetch(`${app.listeningOrigin}/api/callbacks/register-${kind}-tracking`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-invocation-id': auth.invocationId,
          'x-callback-token': auth.callbackToken,
        },
        body: JSON.stringify({
          repoFullName: 'owner/repo',
          [`${kind}Number`]: 4513,
          when,
          nextStep: 'Continue with the result.',
          expiresAt: Date.now() + 60000,
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(JSON.stringify(body).includes('typedWaitRegistration'), false);
      assert.equal(JSON.stringify(body.await).includes(auth.invocationId), false);
      return body;
    },
    resolve: (overrides = {}) => resolveTypedWaitContinuation({ taskStore, ...identity, ...overrides }),
  };
}

const cases = [
  ['head change', [{ kind: 'pr_head_changed' }]],
  ['review decision', [{ kind: 'pr_review_decision_changed' }]],
  ['review thread', [{ kind: 'pr_review_thread_changed', reviewThreadIds: ['thread-1'] }]],
  ['CI terminal', [{ kind: 'pr_ci_terminal' }]],
  ['conflict', [{ kind: 'pr_became_conflicting' }]],
  ['anchored review', [{ kind: 'pr_review_result_available', triggerCommentId: 4936000000 }]],
  ['issue comment', [{ kind: 'issue_comment_added' }], 'issue'],
  ['issue author', [{ kind: 'issue_author_commented' }], 'issue'],
];
for (const [name, when, kind] of cases) {
  test(`authenticated ${name} registration continues only its source`, async (t) => {
    const h = await harness(t);
    await h.register(when, kind);
    assert.equal((await h.resolve()).kind, 'bypass');
    assert.equal((await h.resolve({ sourceMessageId: 'unrelated-source' })).kind, 'reject');
    assert.equal((await h.resolve({ invocationId: 'unrelated-invocation' })).kind, 'reject');
  });
}

test('an old same-owner anchored review tracker cannot stand in for this invocation', async (t) => {
  const h = await harness(t);
  const task = h.taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#99',
    threadId: h.identity.threadId,
    title: 'Old review',
    ownerCatId: 'opus',
    createdBy: 'opus',
    userId: 'user-1',
  });
  h.taskStore.replaceAutomationStateIfGeneration(task.id, {
    expectedGeneration: null,
    automationState: {
      await: {
        v: 1,
        generation: 1,
        subjectRef: task.subjectKey,
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { capturedAt: 1, headSha: 'old-head' },
        continuation: {
          when: [{ kind: 'pr_review_result_available', triggerCommentId: 42 }],
          // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
          then: 'Old unrelated review.',
        },
        createdAt: 1,
        expiresAt: Date.now() + 60000,
      },
    },
  });
  assert.equal((await h.resolve()).kind, 'reject');
});

test('primary managed command source can establish a CI continuation', async (t) => {
  const h = await harness(t, { primaryHold: true });
  await h.register([{ kind: 'pr_ci_terminal' }]);
  const continuation = await h.resolve();
  assert.equal(continuation.kind, 'bypass');
  assert.deepEqual(continuation.reference, { taskId: continuation.reference.taskId, generation: 1 });
});

test('an adopted hold binds only the exposed source, independently of the user origin', async (t) => {
  const h = await harness(t);
  const wake = await h.adoptHold('one');
  await h.register([{ kind: 'pr_ci_terminal' }]);
  assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'bypass');
  assert.equal((await h.resolve()).kind, 'reject');
});

test('registration before adoption cannot retrospectively consume that source', async (t) => {
  const h = await harness(t);
  let wake;
  h.onBaseline(async () => {
    wake = await h.adoptHold('during-baseline');
  });
  await h.register([{ kind: 'pr_ci_terminal' }]);
  assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'reject');
});

test('multiple pending adopted sources cannot be settled by one wait registration', async (t) => {
  const h = await harness(t);
  const wakes = [await h.adoptHold('one'), await h.adoptHold('two')];
  await h.register([{ kind: 'pr_ci_terminal' }]);
  for (const wake of wakes)
    assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'reject');
  assert.equal((await h.resolve()).kind, 'reject');
});

test('unanchored review cannot gain the authority of a generic predicate', async (t) => {
  const h = await harness(t);
  await h.register([{ kind: 'pr_review_result_available' }, { kind: 'pr_ci_terminal' }]);
  assert.equal((await h.resolve()).kind, 'reject');
});
