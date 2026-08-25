/**
 * F295 — one read/cancel truth for live invocations and managed commands.
 *
 * These route-level journeys deliberately use two threads with the same cat. A
 * catId-only projection would make the assertions ambiguous and is therefore
 * incapable of passing this contract.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const indexedThreadIds = new Set();
  const executions = new Map([
    ['thread-a:kimi', { executionId: 'inv-a', startedAt: 100 }],
    ['thread-b:kimi', { executionId: 'inv-b', startedAt: 200 }],
  ]);
  const cancelCalls = [];
  const processOwnerCancelCalls = [];
  const turnTerminalCalls = [];
  const processOwners = [];
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
      list: mock.fn(async (userId) =>
        userId === USER_ID
          ? [...threads.values()].filter(
              (thread) => thread.createdBy === userId || thread.id === 'default' || indexedThreadIds.has(thread.id),
            )
          : [],
      ),
      listByProject: mock.fn(async (userId, projectPath) =>
        userId === USER_ID
          ? [...threads.values()].filter(
              (thread) =>
                thread.projectPath === projectPath &&
                (thread.createdBy === userId || thread.id === 'default' || indexedThreadIds.has(thread.id)),
            )
          : [],
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
    cliExecutionOwnerService: {
      listLive: mock.fn(async () => ({ owners: processOwners, complete: true })),
      terminateExact: mock.fn(async (execution) => {
        processOwnerCancelCalls.push(execution);
        return { matched: 1, signaled: 1, complete: true };
      }),
    },
    turnExecutionStore: {
      listByParent: mock.fn(async () => []),
      transitionTerminal: mock.fn(async (invocationId, terminal) => {
        turnTerminalCalls.push({ invocationId, terminal });
        return { outcome: 'transitioned', record: null };
      }),
    },
    _executions: executions,
    _cancelCalls: cancelCalls,
    _managedTasks: managedTasks,
    _processOwners: processOwners,
    _processOwnerCancelCalls: processOwnerCancelCalls,
    _turnTerminalCalls: turnTerminalCalls,
    _threads: threads,
    _indexedThreadIds: indexedThreadIds,
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

  it('keeps one production execution-owner service wired into queue routes', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /const cliExecutionOwnerService = createCliExecutionOwnerService\(\{ log: app\.log \}\)/);
    assert.match(source, /await app\.register\(queueRoutes, \{[\s\S]*?\n\s+cliExecutionOwnerService,\n/);
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

  it('projects a scheduler-owned provider process after tracker loss and lets the user-owned thread owner stop it', async () => {
    deps._processOwners.push({
      executionId: 'inv-scheduler-process',
      invocationId: 'turn-scheduler-process',
      threadId: 'thread-a',
      catId: 'opus5',
      userId: 'scheduler',
      startedAt: 450,
    });

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const processExecution = projection
      .json()
      .executions.find((execution) => execution.executionId === 'inv-scheduler-process');
    assert.deepEqual(processExecution?.cancelability, {
      state: 'cancelable',
      target: {
        kind: 'live_invocation',
        threadId: 'thread-a',
        catId: 'opus5',
        executionId: 'inv-scheduler-process',
      },
    });

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-scheduler-process/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().cancelled, true);
    assert.deepEqual(deps._processOwnerCancelCalls, [
      {
        executionId: 'inv-scheduler-process',
        invocationId: 'turn-scheduler-process',
        threadId: 'thread-a',
        catId: 'opus5',
        userId: 'scheduler',
      },
    ]);
    assert.deepEqual(deps._turnTerminalCalls, [
      {
        invocationId: 'turn-scheduler-process',
        terminal: {
          status: 'canceled',
          endedAt: deps._turnTerminalCalls[0]?.terminal.endedAt,
          terminalReason: 'user_cancel',
        },
      },
    ]);
    assert.equal(Number.isFinite(deps._turnTerminalCalls[0]?.terminal.endedAt), true);
    assert.equal(
      deps.queueProcessor.releaseSlot.mock.calls.length,
      0,
      'signalling a live supervisor must not dispatch its successor before the tree exits',
    );
  });

  it('shows another human principal as masked occupancy without granting cancellation', async () => {
    deps._processOwners.push({
      executionId: 'inv-foreign-human',
      invocationId: 'turn-foreign-human',
      threadId: 'thread-a',
      catId: 'opus5',
      userId: 'user-b',
      startedAt: 460,
    });

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const occupied = projection.json().executions.find((execution) => execution.catId === 'opus5');
    assert.match(occupied.executionId, /^occupied:/);
    assert.deepEqual(occupied.cancelability, { state: 'not_cancelable', reason: 'foreign_principal' });

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-foreign-human/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });
    assert.equal(cancel.statusCode, 409);
    assert.deepEqual(deps._processOwnerCancelCalls, []);
  });

  it('treats an owner-less canonical candidate as viewer-owned without inventing a foreign principal', async () => {
    deps._processOwners.push({
      executionId: 'inv-owner-unknown',
      invocationId: 'turn-owner-unknown',
      threadId: 'thread-a',
      catId: 'opus5',
      startedAt: 465,
    });

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const execution = projection.json().executions.find((item) => item.executionId === 'inv-owner-unknown');
    assert.deepEqual(execution?.cancelability, {
      state: 'cancelable',
      target: {
        kind: 'live_invocation',
        threadId: 'thread-a',
        catId: 'opus5',
        executionId: 'inv-owner-unknown',
      },
    });
  });

  it('merges tracker and process-owner truth for one execution without duplicating or weakening tracker control', async () => {
    deps._processOwners.push({
      executionId: 'inv-a',
      invocationId: 'turn-process-owner-a',
      threadId: 'thread-a',
      catId: 'kimi',
      userId: USER_ID,
      startedAt: 999,
    });

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const merged = projection.json().executions.filter((execution) => execution.executionId === 'inv-a');
    assert.equal(merged.length, 1);
    assert.equal(merged[0].startedAt, 100, 'tracker age remains canonical when both sources describe one execution');

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-a/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'kimi' },
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal(deps._cancelCalls.length, 1, 'tracker remains the preferred control plane');
    assert.deepEqual(deps._processOwnerCancelCalls, []);
  });

  it('replaces an unresolved same-cat tracker row with exact process-owner identity', async () => {
    deps.invocationTracker.getExecutionId = () => undefined;
    deps._processOwners.push({
      executionId: 'inv-process-exact',
      invocationId: 'turn-process-exact',
      threadId: 'thread-a',
      catId: 'kimi',
      userId: USER_ID,
      startedAt: 470,
    });

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const kimiRows = projection
      .json()
      .executions.filter(
        (execution) =>
          execution.kind === 'live_invocation' && execution.threadId === 'thread-a' && execution.catId === 'kimi',
      );
    assert.deepEqual(
      kimiRows.map((execution) => execution.executionId),
      ['inv-process-exact'],
    );
  });

  it('shows viewer-owned liveness with an unavailable control source as honestly non-cancelable', async () => {
    deps.invocationTracker.getExecutionId = () => undefined;

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const execution = projection
      .json()
      .executions.find((item) => item.kind === 'live_invocation' && item.threadId === 'thread-a');
    assert.match(execution.executionId, /^unresolved:/);
    assert.deepEqual(execution.cancelability, {
      state: 'not_cancelable',
      reason: 'control_plane_unavailable',
    });
  });

  it('treats a process that exits between projection and signal as an idempotent successful cancel', async () => {
    deps._processOwners.push({
      executionId: 'inv-natural-exit',
      invocationId: 'turn-natural-exit',
      threadId: 'thread-a',
      catId: 'opus5',
      userId: USER_ID,
      startedAt: 472,
    });
    deps.cliExecutionOwnerService.terminateExact.mock.mockImplementationOnce(async (execution) => {
      deps._processOwnerCancelCalls.push(execution);
      return { matched: 1, signaled: 0, complete: true };
    });

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-natural-exit/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });

    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().cancelled, true);
    assert.equal(deps._turnTerminalCalls.at(-1)?.invocationId, 'turn-natural-exit');
  });

  it('keeps process cancellation successful when tracker-less terminalization needs recovery', async () => {
    deps._processOwners.push({
      executionId: 'inv-terminal-write-fails',
      invocationId: 'turn-terminal-write-fails',
      threadId: 'thread-a',
      catId: 'opus5',
      userId: USER_ID,
      startedAt: 473,
    });
    deps.turnExecutionStore.transitionTerminal.mock.mockImplementationOnce(async () => {
      throw new Error('ledger unavailable');
    });

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-terminal-write-fails/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });

    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().cancelled, true);
  });

  it('keeps a process-owner-only execution inside a complete sparse project snapshot', async () => {
    await app.close();
    deps._executions.clear();
    deps._processOwners.push({
      executionId: 'inv-sparse-process',
      invocationId: 'turn-sparse-process',
      threadId: 'thread-a',
      catId: 'opus5',
      userId: 'scheduler',
      startedAt: 475,
    });
    const buildLiveCandidateSnapshot = mock.fn(async () => ({ threadIds: [], complete: true }));
    deps.activeExecutionService = { buildLiveCandidateSnapshot };
    app = Fastify();
    await app.register(queueRoutes, deps);
    await app.ready();

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(projection.statusCode, 200);
    assert.ok(
      projection.json().executions.some((execution) => execution.executionId === 'inv-sparse-process'),
      'durable process ownership must nominate its thread after the tracker handle is gone',
    );
    assert.equal(buildLiveCandidateSnapshot.mock.callCount(), 1);
    assert.equal(
      deps.cliExecutionOwnerService.listLive.mock.callCount(),
      1,
      'candidate discovery and projection must share one process-owner snapshot per request',
    );
    assert.equal(
      deps.dynamicTaskStore.getAll.mock.callCount(),
      1,
      'managed-command truth must still be read exactly once by its projection',
    );
  });

  it('fails open to canonical liveness when the process-owner snapshot is unavailable', async () => {
    await app.close();
    deps.activeExecutionService = {
      buildLiveCandidateSnapshot: mock.fn(async () => ({ threadIds: [], complete: true })),
    };
    deps.cliExecutionOwnerService.listLive.mock.mockImplementation(async () => ({ owners: [], complete: false }));
    app = Fastify();
    await app.register(queueRoutes, deps);
    await app.ready();

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(projection.statusCode, 200);
    assert.deepEqual(
      projection
        .json()
        .executions.filter((execution) => execution.kind === 'live_invocation')
        .map((execution) => execution.executionId)
        .sort(),
      ['inv-a', 'inv-b'],
      'an incomplete process-owner source must trigger the full canonical scan instead of hiding known work',
    );
    assert.equal(
      deps.cliExecutionOwnerService.listLive.mock.callCount(),
      1,
      'the unavailable process-owner source must not be retried once per candidate thread',
    );
  });

  it('keeps known process-owner liveness visible but non-cancelable while owner truth is incomplete', async () => {
    const owner = {
      executionId: 'inv-owner-incomplete',
      invocationId: 'turn-owner-incomplete',
      threadId: 'thread-a',
      catId: 'opus5',
      userId: USER_ID,
      startedAt: 475,
    };
    deps.cliExecutionOwnerService.listLive.mock.mockImplementation(async () => ({
      owners: [owner],
      complete: false,
    }));

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-a/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    const execution = projection.json().executions.find((candidate) => candidate.executionId === owner.executionId);
    assert.ok(execution, 'known liveness remains visible during control-plane degradation');
    assert.deepEqual(execution.cancelability, {
      state: 'not_cancelable',
      reason: 'control_plane_unavailable',
    });
  });

  it('reports control-plane degradation instead of claiming an exact process execution is inactive', async () => {
    await app.close();
    deps._executions.clear();
    deps.cliExecutionOwnerService.listLive.mock.mockImplementation(async () => ({ owners: [], complete: false }));
    app = Fastify();
    await app.register(queueRoutes, deps);
    await app.ready();

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-hidden-by-degraded-scan/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });

    assert.equal(cancel.statusCode, 503);
    assert.equal(cancel.json().code, 'EXECUTION_CONTROL_UNAVAILABLE');
  });

  it('reports a degraded exact termination scan separately from process inactivity', async () => {
    deps._processOwners.push({
      executionId: 'inv-terminate-degraded',
      invocationId: 'turn-terminate-degraded',
      threadId: 'thread-a',
      catId: 'opus5',
      userId: USER_ID,
      startedAt: 476,
    });
    deps.cliExecutionOwnerService.terminateExact.mock.mockImplementationOnce(async () => ({
      matched: 0,
      signaled: 0,
      complete: false,
    }));

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-a/executions/live/inv-terminate-degraded/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });

    assert.equal(cancel.statusCode, 503);
    assert.equal(cancel.json().code, 'EXECUTION_CONTROL_UNAVAILABLE');
    assert.deepEqual(deps._turnTerminalCalls, []);
  });

  it('shows but never leaks or cancels a scheduler process on an indexed system thread', async () => {
    const systemThread = {
      id: 'thread-system',
      title: 'Shared system thread',
      projectPath: '/project/cafe',
      createdBy: 'system',
    };
    deps._threads.set(systemThread.id, systemThread);
    deps._indexedThreadIds.add(systemThread.id);
    deps._processOwners.push({
      executionId: 'inv-system-scheduler',
      invocationId: 'turn-system-scheduler',
      threadId: 'thread-system',
      catId: 'opus5',
      userId: 'scheduler',
      startedAt: 500,
    });

    const projection = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-system/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    assert.equal(
      deps.threadStore.list.mock.callCount() + deps.threadStore.listByProject.mock.callCount(),
      1,
      'indexed system admission and projection should share one thread-index enumeration',
    );
    const processExecution = projection.json().executions.find((execution) => execution.catId === 'opus5');
    assert.equal(processExecution.cancelability.reason, 'foreign_principal');
    assert.match(processExecution.executionId, /^occupied:/);
    assert.notEqual(processExecution.executionId, 'inv-system-scheduler');

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-system/executions/live/inv-system-scheduler/cancel',
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });
    assert.equal(cancel.statusCode, 409);
    assert.deepEqual(deps._processOwnerCancelCalls, []);
  });

  it('denies an unindexed system thread before resolving liveness for read or cancel', async () => {
    const systemThread = {
      id: 'thread-system-private',
      title: 'Private system thread',
      projectPath: '/project/private',
      createdBy: 'system',
    };
    deps._threads.set(systemThread.id, systemThread);
    deps._processOwners.push({
      executionId: 'inv-private-system',
      invocationId: 'turn-private-system',
      threadId: systemThread.id,
      catId: 'opus5',
      userId: 'scheduler',
      startedAt: 510,
    });

    const projection = await app.inject({
      method: 'GET',
      url: `/api/threads/${systemThread.id}/executions/active`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/threads/${systemThread.id}/executions/live/inv-private-system/cancel`,
      headers: { 'x-cat-cafe-user': USER_ID },
      payload: { catId: 'opus5' },
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-system-missing/executions/active',
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    for (const response of [projection, cancel]) {
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, 'THREAD_ACCESS_DENIED');
      assert.equal(response.json().reason, 'not_visible_to_user');
    }
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.json().code, 'THREAD_ACCESS_DENIED');
    assert.equal(missing.json().reason, 'thread_not_found');
    assert.equal(deps.threadStore.listByProject.mock.callCount(), 0);
    assert.equal(deps.cliExecutionOwnerService.listLive.mock.callCount(), 0);
    assert.deepEqual(deps._processOwnerCancelCalls, []);
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
