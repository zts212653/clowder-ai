import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildHeldEvent, buildWakeConditionMetEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { classifyManagedHoldRetirement } from '../dist/domains/ball-custody/managed-hold-retirement.js';
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
  // Pure Ball projection is a classification fixture, never a private continuation authorizer.
  const events =
    options.holdsBall === false
      ? []
      : [buildHeldEvent({ threadId: thread.id, catId: 'opus', fireAt: 99_000, at: 1_000 })];
  let clock = 2_000;
  const appendHold = (suffix, scope = {}) => {
    const holdTaskId = `hold-${suffix}`;
    const message = messageStore.append({
      from: { kind: 'system', service: 'hold-ball' },
      userId: scope.userId ?? 'user-1',
      threadId: scope.threadId ?? thread.id,
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
          threadId: scope.threadId ?? thread.id,
          catId: scope.catId ?? 'opus',
        },
      },
    });
    clock += 1_000;
    events.push(
      buildWakeConditionMetEvent({
        threadId: thread.id,
        catId: 'opus',
        taskId: holdTaskId,
        command: 'pnpm test',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        at: clock,
      }),
    );
    return {
      sourceMessageId: message.id,
      taskId: holdTaskId,
    };
  };
  const primary = options.primaryHold ? appendHold('primary', options.sourceScope) : undefined;
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
  if (options.sourceReadError)
    messageStore.getById = () => {
      throw new Error('owned History read unavailable');
    };
  const invocationTracker = {
    getActiveSlots: () => {
      if (options.activeRunReadError) throw new Error('owned child lookup unavailable');
      return [
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
            ...options.activeRun,
          },
        },
      ];
    },
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
    ballCustodyEventLog: { read: async () => structuredClone(events) },
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
    primary,
    reverseInputs() {
      activeInputMessageIds.reverse();
      const wakes = events.filter((event) => event.kind === 'ball.wake_condition_met');
      if (wakes.length === 2) {
        const first = events.indexOf(wakes[0]);
        const second = events.indexOf(wakes[1]);
        [events[first], events[second]] = [events[second], events[first]];
      }
    },
    holdAgain() {
      clock += 1_000;
      events.push(buildHeldEvent({ threadId: thread.id, catId: 'opus', fireAt: 100_000, at: clock }));
    },
    retirement(wake) {
      return classifyManagedHoldRetirement(events, {
        threadId: thread.id,
        catId: 'opus',
        taskId: wake.taskId,
        sourceMessageId: wake.sourceMessageId,
      });
    },
    onBaseline(fn) {
      baselineHook = fn;
    },
    async adoptHold(suffix, scope) {
      const wake = appendHold(suffix, scope);
      activeInputMessageIds.push(wake.sourceMessageId);
      return wake;
    },
    /** `when` undefined is the normal call: the server arms its default set, comment surfaces included. */
    async register(when, kind = 'pr', { deadline = true } = {}) {
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
          ...(when ? { when } : {}),
          nextStep: 'Continue with the result.',
          ...(deadline ? { expiresAt: Date.now() + 60000 } : {}),
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
  ['conversation comment', [{ kind: 'pr_conversation_comment_added', authorLogins: ['reviewer'] }]],
  ['inline comment', [{ kind: 'pr_inline_comment_added', authorLogins: ['reviewer'] }]],
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

// #1392 AC-7 made the normal registration arm both comment surfaces and made the deadline optional.
// That normal call is what a cat makes after pushing, so it has to be the one the stop gate accepts.
for (const [kind, commentKind] of [
  ['pr', 'pr_conversation_comment_added'],
  ['issue', 'issue_comment_added'],
]) {
  test(`the normal ${kind} registration, with no conditions and no deadline, continues only its source`, async (t) => {
    const h = await harness(t);
    const body = await h.register(undefined, kind, { deadline: false });
    assert.equal(body.await.expiresAt, undefined, 'the normal registration has no deadline');
    assert.ok(
      body.await.continuation.when.some((predicate) => predicate.kind === commentKind),
      'and it listens to comments',
    );
    assert.equal((await h.resolve()).kind, 'bypass');
    assert.equal((await h.resolve({ sourceMessageId: 'unrelated-source' })).kind, 'reject');
    assert.equal((await h.resolve({ invocationId: 'unrelated-invocation' })).kind, 'reject');
  });
}

test('a narrow registration without a deadline continues its source too', async (t) => {
  const h = await harness(t);
  await h.register([{ kind: 'pr_ci_terminal' }], 'pr', { deadline: false });
  assert.equal((await h.resolve()).kind, 'bypass');
});

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
  for (const wake of wakes) assert.equal(h.retirement(wake).kind, 'live');
  await h.register([{ kind: 'pr_ci_terminal' }]);
  for (const wake of wakes)
    assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'reject');
  assert.equal((await h.resolve()).kind, 'reject');
});

test('two retired entry sources do not grant first-retired continuation authority', async (t) => {
  // C6 supersedes public first-retired authorization; original 19/20 RED is retained in evidence.
  const h = await harness(t, { holdsBall: false });
  const wakes = [await h.adoptHold('one'), await h.adoptHold('two')];
  for (const wake of wakes) assert.equal(h.retirement(wake).kind, 'retired');
  await h.register([{ kind: 'pr_ci_terminal' }]);

  const [first, second] = wakes;
  assert.equal((await h.resolve({ sourceMessageId: first.sourceMessageId, holdTaskId: first.taskId })).kind, 'reject');
  assert.equal(
    (await h.resolve({ sourceMessageId: second.sourceMessageId, holdTaskId: second.taskId })).kind,
    'reject',
  );
  assert.equal((await h.resolve()).kind, 'reject');
});

for (const retired of [false, true]) {
  for (const primaryHold of [false, true]) {
    for (const reversed of [false, true]) {
      test(`ambiguous entry denies authority: retired=${retired}, primary=${primaryHold}, reversed=${reversed}`, async (t) => {
        const h = await harness(t, { holdsBall: !retired, primaryHold });
        const wakes = [h.primary ?? (await h.adoptHold('first')), await h.adoptHold('second')];
        if (reversed) h.reverseInputs();
        await h.register([{ kind: 'pr_ci_terminal' }]);
        for (const wake of wakes) {
          assert.equal(
            (await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind,
            'reject',
          );
        }
        const [task] = h.taskStore.listByThread(h.identity.threadId);
        assert.equal(h.taskStore.getWaitRegistration(task.id).receipt, null);
      });
    }
  }
}

test('a sole exact retired source still establishes a private continuation', async (t) => {
  const h = await harness(t, { holdsBall: false });
  const wake = await h.adoptHold('sole-retired');
  assert.equal(h.retirement(wake).kind, 'retired');
  await h.register([{ kind: 'pr_ci_terminal' }]);
  assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'bypass');
});

for (const reversed of [false, true]) {
  test(`mixed retired/live entry sources deny authority, reversed=${reversed}`, async (t) => {
    const h = await harness(t, { holdsBall: false });
    const first = await h.adoptHold('retired');
    h.holdAgain();
    const second = await h.adoptHold('live');
    assert.equal(h.retirement(first).kind, 'retired');
    assert.equal(h.retirement(second).kind, 'live');
    if (reversed) h.reverseInputs();
    await h.register([{ kind: 'pr_ci_terminal' }]);
    for (const wake of [first, second]) {
      assert.equal(
        (await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind,
        'reject',
      );
    }
  });
}

for (const [name, options] of [
  ['source thread', { sourceScope: { threadId: 'foreign-thread' } }],
  ['source user', { sourceScope: { userId: 'foreign-user' } }],
  ['source cat', { sourceScope: { catId: 'foreign-cat' } }],
  ['active child thread', { activeRun: { threadId: 'foreign-thread' } }],
  ['active child target', { activeRun: { targetId: 'foreign-cat' } }],
  ['active child invocation', { activeRun: { invocationId: 'foreign-child' } }],
  ['absent entry input', { activeRun: { inputMessageIds: [] } }],
  ['History read unavailable', { sourceReadError: true }],
  ['child lookup unavailable', { activeRunReadError: true }],
]) {
  test(`actual tracking producer denies mismatched ${name} private receipt`, async (t) => {
    const h = await harness(t, { primaryHold: true, ...options });
    await h.register([{ kind: 'pr_ci_terminal' }]);
    const [task] = h.taskStore.listByThread(h.identity.threadId);
    assert.ok(task.automationState.await, 'public tracking remains installed');
    assert.equal(h.taskStore.getWaitRegistration(task.id).receipt, null);
    assert.equal((await h.resolve()).kind, 'reject');
  });
}

for (const [name, overrides] of [
  ['thread', { threadId: 'foreign-thread' }],
  ['user', { userId: 'foreign-user' }],
  ['cat', { catId: 'foreign-cat' }],
  ['child', { invocationId: 'foreign-child' }],
  ['hold', { holdTaskId: 'foreign-hold' }],
  ['expiry', { now: Date.now() + 120_000 }],
]) {
  test(`valid private receipt rejects replay with changed ${name}`, async (t) => {
    const h = await harness(t, { primaryHold: true });
    await h.register([{ kind: 'pr_ci_terminal' }]);
    assert.equal((await h.resolve()).kind, 'bypass');
    assert.equal((await h.resolve(overrides)).kind, 'reject');
  });
}

for (const [name, mutate] of [
  ['terminal Task', () => ({ status: 'done' })],
  ['changed owner', () => ({ ownerCatId: 'foreign-cat' })],
  [
    'generation',
    (task) => ({
      automationState: {
        ...task.automationState,
        await: { ...task.automationState.await, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } },
      },
    }),
  ],
  [
    'predicate',
    (task) => ({
      automationState: {
        ...task.automationState,
        await: {
          ...task.automationState.await,
          continuation: { ...task.automationState.await.continuation, when: [{ kind: 'pr_head_changed' }] },
        },
      },
    }),
  ],
]) {
  test(`private receipt cannot survive ${name}`, async (t) => {
    const h = await harness(t, { primaryHold: true });
    await h.register([{ kind: 'pr_ci_terminal' }]);
    assert.equal((await h.resolve()).kind, 'bypass');
    const [task] = h.taskStore.listByThread(h.identity.threadId);
    assert.ok(h.taskStore.update(task.id, mutate(task)));
    assert.equal((await h.resolve()).kind, 'reject');
  });
}

test('unanchored review cannot gain the authority of a generic predicate', async (t) => {
  const h = await harness(t);
  await h.register([{ kind: 'pr_review_result_available' }, { kind: 'pr_ci_terminal' }]);
  assert.equal((await h.resolve()).kind, 'reject');
});
