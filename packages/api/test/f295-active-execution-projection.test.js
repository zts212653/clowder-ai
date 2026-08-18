/**
 * F295 — one read/cancel truth for live invocations and managed commands.
 *
 * These route-level journeys deliberately use two threads with the same cat. A
 * catId-only projection would make the assertions ambiguous and is therefore
 * incapable of passing this contract.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { queueRoutes } = await import('../dist/routes/queue.js');

const USER_ID = 'user-a';

function makeManagedCommandTask() {
  return {
    id: 'hold-ball-command-b',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 90_000 },
    params: {
      triggerUserId: USER_ID,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        createdBy: 'hold-ball:kimi',
        managedCommand: {
          state: 'command_running',
          command: 'pnpm gate',
          startedAt: 300,
        },
      },
    },
    display: { label: 'managed command', category: 'system', description: 'test' },
    deliveryThreadId: 'thread-b',
    enabled: true,
    createdBy: 'hold-ball:kimi',
    createdAt: new Date(300).toISOString(),
  };
}

function makeSchedulerTriggeredCommandTask() {
  // A scheduler round occupies the same cat slot, but its trigger principal is
  // not the viewing user.
  const task = makeManagedCommandTask();
  return {
    ...task,
    id: 'hold-ball-command-scheduler',
    params: { ...task.params, triggerUserId: 'scheduler' },
  };
}

function makeUserMessageRetiredRunningCommandTask() {
  const task = makeManagedCommandTask();
  return {
    ...task,
    id: 'hold-ball-command-retired-wake',
    enabled: false,
    params: {
      ...task.params,
      holdLifecycle: {
        ...task.params.holdLifecycle,
        status: 'cancelled_by_user',
        managedCommand: {
          ...task.params.holdLifecycle.managedCommand,
          command: 'pnpm --filter @cat-cafe/api test',
          startedAt: 350,
        },
      },
    },
  };
}

function buildDeps() {
  const threads = new Map([
    [
      'thread-a',
      {
        id: 'thread-a',
        title: 'Alpha work',
        projectPath: '/project/cafe',
        createdBy: USER_ID,
      },
    ],
    [
      'thread-b',
      {
        id: 'thread-b',
        title: 'Background work',
        projectPath: '/project/cafe',
        createdBy: USER_ID,
      },
    ],
  ]);
  const executions = new Map([
    ['thread-a:kimi', { executionId: 'inv-a', startedAt: 100 }],
    ['thread-b:kimi', { executionId: 'inv-b', startedAt: 200 }],
  ]);
  const cancelCalls = [];
  const managedTasks = [makeManagedCommandTask()];
  const invocationTracker = {
    has(threadId, catId) {
      return executions.has(`${threadId}:${catId}`);
    },
    getUserId(threadId, catId) {
      return executions.has(`${threadId}:${catId}`) ? USER_ID : null;
    },
    getExecutionId(threadId, catId) {
      return executions.get(`${threadId}:${catId}`)?.executionId;
    },
    getActiveSlots(threadId) {
      return [...executions.entries()]
        .filter(([key]) => key.startsWith(`${threadId}:`))
        .map(([key, value]) => ({ catId: key.slice(threadId.length + 1), startedAt: value.startedAt }));
    },
    cancel(threadId, catId, requestUserId, reason) {
      cancelCalls.push({ threadId, catId, requestUserId, reason });
      const key = `${threadId}:${catId}`;
      const execution = executions.get(key);
      if (!execution) return { cancelled: false, catIds: [] };
      executions.delete(key);
      return { cancelled: true, catIds: [catId], executionIds: [execution.executionId] };
    },
  };
  const invocationQueue = new InvocationQueue();
  return {
    threadStore: {
      get: mock.fn(async (threadId) => threads.get(threadId) ?? null),
      listByProject: mock.fn(async (userId, projectPath) =>
        userId === USER_ID ? [...threads.values()].filter((thread) => thread.projectPath === projectPath) : [],
      ),
    },
    invocationQueue,
    invocationTracker,
    dynamicTaskStore: {
      getAll: mock.fn(() => managedTasks),
      getById: mock.fn((taskId) => managedTasks.find((task) => task.id === taskId) ?? null),
    },
    queueProcessor: {
      canReleaseSlotForUser: mock.fn(() => true),
      processNext: mock.fn(async () => ({ started: false })),
      isPaused: mock.fn(() => false),
      getPauseReason: mock.fn(() => undefined),
      clearPause: mock.fn(),
      releaseSlot: mock.fn(),
      releaseThread: mock.fn(),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    agentSessionMutex: {
      forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
    },
    getManagedCommandWakeRecovery: () => undefined,
    _executions: executions,
    _cancelCalls: cancelCalls,
    _managedTasks: managedTasks,
  };
}

describe('F295 active execution projection', () => {
  let app;
  let deps;

  beforeEach(async () => {
    deps = buildDeps();
    app = Fastify();
    await app.register(queueRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('cold-discovers same-cat live work in every project thread and a post-invocation managed command', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      projectPath: '/project/cafe',
      executions: [
        {
          executionId: 'inv-a',
          threadId: 'thread-a',
          threadTitle: 'Alpha work',
          catId: 'kimi',
          kind: 'live_invocation',
          startedAt: 100,
          cancelability: {
            state: 'cancelable',
            target: {
              kind: 'live_invocation',
              threadId: 'thread-a',
              catId: 'kimi',
              executionId: 'inv-a',
            },
          },
        },
        {
          executionId: 'inv-b',
          threadId: 'thread-b',
          threadTitle: 'Background work',
          catId: 'kimi',
          kind: 'live_invocation',
          startedAt: 200,
          cancelability: {
            state: 'cancelable',
            target: {
              kind: 'live_invocation',
              threadId: 'thread-b',
              catId: 'kimi',
              executionId: 'inv-b',
            },
          },
        },
        {
          executionId: 'hold-ball-command-b',
          threadId: 'thread-b',
          threadTitle: 'Background work',
          catId: 'kimi',
          kind: 'managed_command',
          startedAt: 300,
          cancelability: {
            state: 'cancelable',
            target: { kind: 'managed_command', taskId: 'hold-ball-command-b' },
          },
        },
      ],
    });
  });

  it('rejects a stale live cancel target instead of killing its replacement', async () => {
    deps._executions.set('thread-a:kimi', { executionId: 'inv-new', startedAt: 400 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-a/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'kimi' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'EXECUTION_REPLACED');
    assert.deepEqual(deps._cancelCalls, []);
    assert.equal(deps._executions.get('thread-a:kimi').executionId, 'inv-new');
  });

  it('keeps a command visible and exactly cancelable after an ordinary message retires only its wake', async () => {
    deps._managedTasks.push(makeUserMessageRetiredRunningCommandTask());

    const response = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(response.statusCode, 200);
    const execution = response.json().executions.find((item) => item.executionId === 'hold-ball-command-retired-wake');
    assert.deepEqual(execution, {
      executionId: 'hold-ball-command-retired-wake',
      threadId: 'thread-b',
      threadTitle: 'Background work',
      catId: 'kimi',
      kind: 'managed_command',
      startedAt: 350,
      cancelability: {
        state: 'cancelable',
        target: { kind: 'managed_command', taskId: 'hold-ball-command-retired-wake' },
      },
    });
  });

  it('cancels only the exact thread execution when the same cat runs elsewhere', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-a/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'kimi' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().cancelled, true);
    assert.deepEqual(deps._cancelCalls, [
      { threadId: 'thread-a', catId: 'kimi', requestUserId: USER_ID, reason: 'user_cancel' },
    ]);
    assert.equal(deps._executions.has('thread-a:kimi'), false);
    assert.equal(deps._executions.get('thread-b:kimi').executionId, 'inv-b');
  });

  it('surfaces a scheduler-owned command as occupancy instead of hiding the busy cat slot', async () => {
    // Reported downstream: the console filters executions by the viewing user, so a
    // scheduler round holding the cat slot vanished and Queue looked idle while new
    // work silently queued behind an invisible occupant.
    deps._managedTasks.push(makeSchedulerTriggeredCommandTask());

    const response = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(response.statusCode, 200);
    const schedulerExecution = response
      .json()
      .executions.find(
        (execution) =>
          execution.kind === 'managed_command' &&
          execution.catId === 'kimi' &&
          execution.cancelability.state === 'not_cancelable',
      );

    assert.ok(schedulerExecution, 'an occupied cat slot must be visible to whoever shares the thread');
    assert.equal(schedulerExecution.kind, 'managed_command');
    assert.equal(schedulerExecution.catId, 'kimi');
    // Occupancy only: this viewer does not own the run and must not be offered a stop.
    assert.equal(schedulerExecution.cancelability.state, 'not_cancelable');
    assert.equal(schedulerExecution.cancelability.reason, 'foreign_principal');
    // The durable task id is a capability handle for the hold-ball status/cancel
    // routes. A foreign row must not hand it out.
    assert.notEqual(schedulerExecution.executionId, 'hold-ball-command-scheduler');
    assert.match(schedulerExecution.executionId, /^occupied:/);
  });

  it('still hides executions on threads this user cannot access', async () => {
    const foreign = makeSchedulerTriggeredCommandTask();
    foreign.id = 'hold-ball-command-foreign-thread';
    foreign.deliveryThreadId = 'thread-not-in-project';
    deps._managedTasks.push(foreign);

    const response = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(
      response.json().executions.some((execution) => execution.executionId === 'hold-ball-command-foreign-thread'),
      false,
    );
  });

  it('the occupancy id resolves to no hold task, so it cannot read or cancel the foreign run', async () => {
    // The hold-ball status/cancel routes both start by resolving the path param
    // through the dynamic task store; an id that resolves to nothing 404s before
    // any thread-scoped authorization is even consulted.
    deps._managedTasks.push(makeSchedulerTriggeredCommandTask());

    const response = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const foreign = response
      .json()
      .executions.find((execution) => execution.cancelability.reason === 'foreign_principal');
    assert.ok(foreign);

    assert.equal(deps.dynamicTaskStore.getById(foreign.executionId), null);
    // ...while the owner's own row still carries a usable handle.
    const owned = response.json().executions.find((execution) => execution.executionId === 'hold-ball-command-b');
    assert.ok(owned);
    assert.ok(deps.dynamicTaskStore.getById(owned.executionId));
  });
});
