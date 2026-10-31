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
  const task = taskStore.create({
    kind: 'work',
    threadId: thread.id,
    title: 'Deployment wait',
    ownerCatId: 'opus',
    createdBy: 'opus',
    userId: 'user-1',
  });
  let afterCaptureHook = async () => {};
  let observations = 0;
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
    deploymentObservationProvider: {
      observe: async () => {
        if (++observations === 2) await afterCaptureHook();
        return {
          subjectRef: 'deployment:abc123def456:runtime',
          bootSequence: 1,
          bootId: 'boot-1',
          observedAt: Date.now(),
        };
      },
    },
    deploymentWaitLifecycleHolder: {
      current: {
        observe: async () => ({ kind: 'not_matched' }),
        releaseCurrentExecutionClaim: async () => {},
      },
    },
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
    afterCapture(fn) {
      afterCaptureHook = fn;
    },
    async adoptHold(suffix, scope) {
      const wake = appendHold(suffix, scope);
      activeInputMessageIds.push(wake.sourceMessageId);
      return wake;
    },
    async register(when = { kind: 'new_ready_boot', services: ['api'] }, expectedStatus = 200) {
      const response = await fetch(`${app.listeningOrigin}/api/callbacks/register-deployment-wait`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-invocation-id': auth.invocationId,
          'x-callback-token': auth.callbackToken,
        },
        body: JSON.stringify({
          taskId: task.id,
          deploymentId: 'runtime',
          when,
          nextStep: 'Continue with the result.',
        }),
      });
      const body = await response.json();
      assert.equal(response.status, expectedStatus, JSON.stringify(body));
      assert.equal(JSON.stringify(body).includes('typedWaitRegistration'), false);
      assert.equal(JSON.stringify(body.await ?? {}).includes(auth.invocationId), false);
      return body;
    },
    resolve: (overrides = {}) => resolveTypedWaitContinuation({ taskStore, ...identity, ...overrides }),
  };
}

// Provider-specific PR/issue predicates live in the GitHub plugin. Exercise the shared
// private continuation boundary through the current authenticated deployment producer.
for (const when of [
  { kind: 'new_ready_boot', services: ['api'] },
  { kind: 'revision_included', revision: 'a'.repeat(40), services: ['api'] },
]) {
  test(`authenticated ${when.kind} registration continues only its source`, async (t) => {
    const h = await harness(t);
    const body = await h.register(when);
    assert.equal(body.await.expiresAt, undefined);
    assert.equal((await h.resolve()).kind, 'bypass');
    assert.equal(
      (await h.resolve({ now: Date.now() + 120_000 })).kind,
      'bypass',
      'persistent wait does not silently expire',
    );
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

test('primary managed command source can establish a deployment continuation', async (t) => {
  const h = await harness(t, { primaryHold: true });
  await h.register();
  const continuation = await h.resolve();
  assert.equal(continuation.kind, 'bypass');
  assert.deepEqual(continuation.reference, { taskId: continuation.reference.taskId, generation: 1 });
});

test('an adopted hold cannot replace the authenticated deployment origin', async (t) => {
  const h = await harness(t);
  const wake = await h.adoptHold('one');
  await h.register();
  assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'reject');
  assert.equal((await h.resolve()).kind, 'bypass');
});

test('registration before adoption cannot retrospectively consume that source', async (t) => {
  const h = await harness(t);
  let wake;
  h.afterCapture(async () => {
    wake = await h.adoptHold('after-source-capture');
  });
  await h.register();
  assert.equal((await h.resolve()).kind, 'bypass');
  assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'reject');
});

test('multiple adopted sources leave the primary deployment continuation intact', async (t) => {
  const h = await harness(t);
  const wakes = [await h.adoptHold('one'), await h.adoptHold('two')];
  for (const wake of wakes) assert.equal(h.retirement(wake).kind, 'live');
  await h.register();
  for (const wake of wakes)
    assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'reject');
  assert.equal((await h.resolve()).kind, 'bypass');
});

test('retired adopted sources cannot displace the primary deployment continuation', async (t) => {
  const h = await harness(t, { holdsBall: false });
  const wakes = [await h.adoptHold('one'), await h.adoptHold('two')];
  for (const wake of wakes) assert.equal(h.retirement(wake).kind, 'retired');
  await h.register();

  const [first, second] = wakes;
  assert.equal((await h.resolve({ sourceMessageId: first.sourceMessageId, holdTaskId: first.taskId })).kind, 'reject');
  assert.equal(
    (await h.resolve({ sourceMessageId: second.sourceMessageId, holdTaskId: second.taskId })).kind,
    'reject',
  );
  assert.equal((await h.resolve()).kind, 'bypass');
});

for (const retired of [false, true]) {
  for (const primaryHold of [false, true]) {
    for (const reversed of [false, true]) {
      test(`adopted entry order and retirement cannot change deployment primary: retired=${retired}, primary=${primaryHold}, reversed=${reversed}`, async (t) => {
        const h = await harness(t, { holdsBall: !retired, primaryHold });
        const wakes = [h.primary ?? (await h.adoptHold('first')), await h.adoptHold('second')];
        if (reversed) h.reverseInputs();
        await h.register();
        for (const wake of wakes) {
          assert.equal(
            (await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind,
            wake === h.primary ? 'bypass' : 'reject',
          );
        }
        const [task] = h.taskStore.listByThread(h.identity.threadId);
        assert.deepEqual(h.taskStore.getWaitRegistration(task.id)?.receipt?.source, {
          kind: 'primary',
          sourceMessageId: h.identity.sourceMessageId,
          ...(h.primary ? { holdTaskId: h.primary.taskId } : {}),
        });
        assert.equal((await h.resolve()).kind, 'bypass');
      });
    }
  }
}

test('a sole retired adopted source never gains deployment continuation authority', async (t) => {
  const h = await harness(t, { holdsBall: false });
  const wake = await h.adoptHold('sole-retired');
  assert.equal(h.retirement(wake).kind, 'retired');
  await h.register();
  assert.equal((await h.resolve({ sourceMessageId: wake.sourceMessageId, holdTaskId: wake.taskId })).kind, 'reject');
  assert.equal((await h.resolve()).kind, 'bypass');
});

for (const reversed of [false, true]) {
  test(`mixed retired/live adopted sources cannot change the deployment primary, reversed=${reversed}`, async (t) => {
    const h = await harness(t, { holdsBall: false });
    const first = await h.adoptHold('retired');
    h.holdAgain();
    const second = await h.adoptHold('live');
    assert.equal(h.retirement(first).kind, 'retired');
    assert.equal(h.retirement(second).kind, 'live');
    if (reversed) h.reverseInputs();
    await h.register();
    assert.equal((await h.resolve()).kind, 'bypass');
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
  test(`actual deployment producer denies mismatched ${name} private receipt`, async (t) => {
    const h = await harness(t, { primaryHold: true, ...options });
    await h.register(undefined, 409);
    const [task] = h.taskStore.listByThread(h.identity.threadId);
    assert.equal(task.deploymentWait, undefined, 'no wait is installed without a valid source');
    assert.equal(h.taskStore.getWaitRegistration(task.id)?.receipt ?? null, null);
    assert.equal((await h.resolve()).kind, 'reject');
  });
}

for (const [name, overrides] of [
  ['thread', { threadId: 'foreign-thread' }],
  ['user', { userId: 'foreign-user' }],
  ['cat', { catId: 'foreign-cat' }],
  ['child', { invocationId: 'foreign-child' }],
  ['hold', { holdTaskId: 'foreign-hold' }],
]) {
  test(`valid private receipt rejects replay with changed ${name}`, async (t) => {
    const h = await harness(t, { primaryHold: true });
    await h.register();
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
      deploymentWait: {
        ...task.deploymentWait,
        currentExecutionClaim: undefined,
        await: { ...task.deploymentWait.await, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } },
      },
    }),
  ],
  [
    'predicate',
    (task) => ({
      deploymentWait: {
        ...task.deploymentWait,
        currentExecutionClaim: undefined,
        await: {
          ...task.deploymentWait.await,
          continuation: {
            ...task.deploymentWait.await.continuation,
            when: [{ kind: 'new_ready_boot', services: ['web'] }],
          },
        },
      },
    }),
  ],
]) {
  test(`private receipt cannot survive ${name}`, async (t) => {
    const h = await harness(t, { primaryHold: true });
    await h.register();
    assert.equal((await h.resolve()).kind, 'bypass');
    const [task] = h.taskStore.listByThread(h.identity.threadId);
    const change = mutate(task);
    if (change.deploymentWait) {
      assert.ok(
        h.taskStore.replaceDeploymentWaitIfGeneration(task.id, {
          expectedGeneration: task.deploymentWait.await.generation,
          expectedDeploymentWait: task.deploymentWait,
          deploymentWait: change.deploymentWait,
        }),
      );
    } else {
      assert.ok(h.taskStore.update(task.id, change));
    }
    assert.equal((await h.resolve()).kind, 'reject');
  });
}
