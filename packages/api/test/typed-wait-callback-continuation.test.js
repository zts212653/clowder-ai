import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildHeldEvent, buildWakeConditionMetEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { ManagedHoldDispositionService } from '../dist/domains/ball-custody/ManagedHoldDispositionService.js';
import { turnCustodyAdoptionRegistry } from '../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

async function harness(t, options = {}) {
  const registry = new InvocationRegistry();
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = threadStore.create('user-1', 'typed wait continuation');
  // A real custody log. The state machine only accepts a wake from `active`, so a wake for a cat that never held
  // the ball is not a live obligation: it is retired, and retired sources drain one at a time. The cat holds the
  // ball first; `holdsBall: false` is the shape that used to stand in for it (wakes with no hold behind them).
  const events =
    options.holdsBall === false
      ? []
      : [buildHeldEvent({ threadId: thread.id, catId: 'opus', fireAt: 99_000, at: 1_000 })];
  let clock = 2_000;
  const appendHold = (suffix, invocationId) => {
    const holdTaskId = `hold-${suffix}`;
    const message = messageStore.append({
      userId: 'scheduler',
      catId: null,
      threadId: thread.id,
      content: 'Command complete.',
      mentions: [],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      source: {
        connector: 'hold-ball',
        label: 'command',
        icon: 'hold-ball',
        meta: { wakeWhen: true, taskId: holdTaskId, threadId: thread.id, catId: 'opus' },
      },
      queueCustody: makeQueuedMessageCustody({
        ownerUserId: 'user-1',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        ...(invocationId
          ? {
              seenByCatIds: ['opus'],
              seenInvocationIdByCatId: { opus: invocationId },
              bodyExposures: [{ targetCatId: 'opus', invocationId, seenAt: Date.now() }],
            }
          : {}),
      }),
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
      kind: 'structured',
      protocol: 'hold',
      sourceMessageId: message.id,
      taskId: holdTaskId,
      subjectKey: `ball:thread:${thread.id}`,
      holderCatId: 'opus',
    };
  };
  const primary = options.primaryHold ? appendHold('primary') : undefined;
  const source = primary
    ? messageStore.getById(primary.sourceMessageId)
    : messageStore.append({
        userId: 'user-1',
        catId: null,
        threadId: thread.id,
        content: 'Continue the owner task.',
        mentions: [],
        timestamp: Date.now(),
      });
  const auth = await registry.create('user-1', 'opus', thread.id, undefined, undefined, undefined, source.id, 'strict');
  const unregister = turnCustodyAdoptionRegistry.register(auth.invocationId, async () => {});
  t.after(unregister);
  const managedHoldDispositionService = new ManagedHoldDispositionService({
    registry,
    messageStore,
    ballCustodyEventLog: { read: async () => events },
  });
  let baselineHook = async () => {};
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    taskStore,
    messageStore,
    threadStore,
    holdBallDeps: { registry, managedHoldDispositionService },
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
      const wake = appendHold(suffix, auth.invocationId);
      assert.equal(await turnCustodyAdoptionRegistry.adopt(auth.invocationId, [wake]), true);
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
  const source = h.messageStore.getById(h.identity.sourceMessageId);
  h.messageStore.transitionQueueCustody(source.id, {
    expectedRevision: source.queueCustody.revision,
    next: {
      ...source.queueCustody,
      revision: source.queueCustody.revision + 1,
      seenByCatIds: ['opus'],
      seenInvocationIdByCatId: { opus: h.identity.invocationId },
      bodyExposures: [{ targetCatId: 'opus', invocationId: h.identity.invocationId, seenAt: Date.now() }],
    },
  });
  const coordinator = new QueuedMessageCustodyCoordinator({
    messageStore: h.messageStore,
    readWaitRegistration: (id) => h.taskStore.getWaitRegistration(id),
  });
  await coordinator.commitSuccessfulTargetForMessage(
    source.queueCustody.entryId,
    source.id,
    'opus',
    h.identity.invocationId,
    Date.now(),
    {
      invocationId: h.identity.invocationId,
      disposition: 'managed_hold_disposition',
      evidenceRef: { kind: 'turn_execution', invocationId: h.identity.invocationId },
      handledAt: Date.now(),
      consumption: {
        kind: 'managed_hold_continued',
        sourceMessageId: source.id,
        taskId: h.identity.holdTaskId,
        transition: 'event_wait',
        waitRegistration: continuation.reference,
      },
    },
    () => true,
  );
  assert.deepEqual(h.messageStore.getById(source.id).queueCustody.handledByCatIds, ['opus']);
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

test('adopted wakes whose cat does not hold the ball are retired and drain one at a time, not as a live ambiguity', async (t) => {
  // The same two adopted sources as above, but the log has no hold behind them (`holdsBall: false`). A wake
  // for a cat that does not hold the ball is not an obligation to act on, so source selection retires it and
  // settles retired sources individually in durable wake order. A registration therefore binds the FIRST of
  // them only, never both, and never a source the caller cannot name.
  const h = await harness(t, { holdsBall: false });
  const wakes = [await h.adoptHold('one'), await h.adoptHold('two')];
  await h.register([{ kind: 'pr_ci_terminal' }]);

  const [first, second] = wakes;
  assert.equal((await h.resolve({ sourceMessageId: first.sourceMessageId, holdTaskId: first.taskId })).kind, 'bypass');
  assert.equal(
    (await h.resolve({ sourceMessageId: second.sourceMessageId, holdTaskId: second.taskId })).kind,
    'reject',
  );
  assert.equal((await h.resolve()).kind, 'reject');
});

test('unanchored review cannot gain the authority of a generic predicate', async (t) => {
  const h = await harness(t);
  await h.register([{ kind: 'pr_review_result_available' }, { kind: 'pr_ci_terminal' }]);
  assert.equal((await h.resolve()).kind, 'reject');
});
