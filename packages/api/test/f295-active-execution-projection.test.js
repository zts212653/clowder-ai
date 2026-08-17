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
});
