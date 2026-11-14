/**
 * A held ball is waiting, not running: the cat's process has exited and only a
 * wake is armed. Before this projection the timer hold was in no surface at all
 * (Home "Happening now" and the conversation row both read active executions,
 * whose managed face admits a hold only while its command runs).
 *
 * Contract pinned here:
 *  - a live timer hold appears in `waits`, never in `executions`;
 *  - a hold whose command is running stays a managed execution and is not repeated;
 *  - cancelled / fired / retired holds do not appear;
 *  - another principal's hold is visible occupancy with a masked id and no cancel handle;
 *  - a thread that only has a wait is still found by the sparse thread listing.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { registerActiveExecutionRoutes } = await import('../dist/routes/active-execution-routes.js');
const { listPendingHoldWaits } = await import('../dist/domains/ball-custody/hold-wait-projection.js');

const USER_ID = 'user-a';

function timerHold(overrides = {}) {
  const { lifecycle, params, ...rest } = overrides;
  return {
    id: 'hold-ball-timer-a',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 660_000 },
    params: {
      triggerUserId: USER_ID,
      targetCatId: 'codex61-sol',
      holdLifecycle: {
        mode: 'timer',
        status: 'active',
        createdBy: 'hold-ball:codex61-sol',
        wakeAt: 600_000,
        ...lifecycle,
      },
      ...params,
    },
    display: { label: 'hold', category: 'system', description: 'test' },
    deliveryThreadId: 'thread-hold',
    enabled: true,
    createdBy: 'hold-ball:codex61-sol',
    createdAt: new Date(60_000).toISOString(),
    ...rest,
  };
}

function runningCommandHold() {
  return {
    ...timerHold({ id: 'hold-ball-command-b', deliveryThreadId: 'thread-b', createdBy: 'hold-ball:kimi' }),
    params: {
      triggerUserId: USER_ID,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        createdBy: 'hold-ball:kimi',
        managedCommand: { state: 'command_running', command: 'pnpm gate', startedAt: 300 },
      },
    },
  };
}

function buildDeps(tasks) {
  const threads = [
    { id: 'thread-hold', title: 'Fix GitHub login', projectPath: '/project/cafe', createdBy: USER_ID },
    { id: 'thread-b', title: 'Background work', projectPath: '/project/cafe', createdBy: USER_ID },
    { id: 'thread-other', title: 'Other project', projectPath: '/project/other', createdBy: USER_ID },
  ];
  return {
    threadStore: {
      get: mock.fn(async (threadId) => threads.find((thread) => thread.id === threadId) ?? null),
      list: mock.fn(async (userId) => (userId === USER_ID ? threads : [])),
      listByProject: mock.fn(async (userId, projectPath) =>
        userId === USER_ID ? threads.filter((thread) => thread.projectPath === projectPath) : [],
      ),
      listCandidates: mock.fn(async (userId, ids) =>
        userId === USER_ID ? threads.filter((thread) => ids.includes(thread.id)) : [],
      ),
    },
    invocationTracker: { getUserId: () => null, getExecutionId: () => undefined },
    dynamicTaskStore: { getAll: mock.fn(() => tasks) },
    // Live candidates are sparse: nothing is running anywhere.
    buildLiveCandidateSnapshot: mock.fn(async () => ({ threadIds: [], complete: true })),
    resolveLiveExecutions: mock.fn(async () => []),
    cancelExactLiveInvocation: mock.fn(async () => ({ cancelled: true })),
  };
}

async function readAll(app, userId = USER_ID) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/executions/active?scope=all',
    headers: { 'x-cat-cafe-user': userId },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

describe('held balls are projected as waits beside active executions', () => {
  let app;

  async function start(tasks) {
    app = Fastify();
    registerActiveExecutionRoutes(app, buildDeps(tasks));
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('shows a live timer hold as a wait with its wake time, not as a running execution', async () => {
    await start([timerHold()]);
    const body = await readAll(app);
    assert.deepEqual(body.executions, []);
    assert.deepEqual(body.waits, [
      {
        waitId: 'hold-ball-timer-a',
        threadId: 'thread-hold',
        threadTitle: 'Fix GitHub login',
        projectPath: '/project/cafe',
        catId: 'codex61-sol',
        since: 60_000,
        // The scheduler's trigger is the truth: a busy thread re-arms it past the original wakeAt.
        wakeAt: 660_000,
        cancelability: { state: 'cancelable', target: { kind: 'hold_ball', taskId: 'hold-ball-timer-a' } },
      },
    ]);
  });

  it('keeps a running managed command as one execution and does not repeat it as a wait', async () => {
    await start([runningCommandHold()]);
    const body = await readAll(app);
    assert.equal(body.executions.length, 1);
    assert.equal(body.executions[0].kind, 'managed_command');
    assert.deepEqual(body.waits, []);
  });

  it('omits holds that were cancelled, already fired, or are not hold-ball carriers', async () => {
    await start([
      timerHold({ id: 'hold-ball-cancelled', lifecycle: { status: 'cancelled_by_user' } }),
      timerHold({ id: 'hold-ball-fired', enabled: false }),
      timerHold({ id: 'dyn-reminder', createdBy: 'user:operator' }),
    ]);
    const body = await readAll(app);
    assert.deepEqual(body.waits, []);
  });

  it('shows another principal’s hold as masked occupancy without a cancel handle', async () => {
    await start([timerHold({ params: { triggerUserId: 'scheduler' } })]);
    const body = await readAll(app);
    assert.equal(body.waits.length, 1);
    const [wait] = body.waits;
    assert.notEqual(wait.waitId, 'hold-ball-timer-a');
    assert.ok(wait.waitId.startsWith('occupied:'));
    assert.deepEqual(wait.cancelability, { state: 'not_cancelable', reason: 'foreign_principal' });
  });

  it('includes waits in a project-scoped read only for that project', async () => {
    await start([timerHold(), timerHold({ id: 'hold-ball-elsewhere', deliveryThreadId: 'thread-other' })]);
    const response = await app.inject({
      method: 'GET',
      url: `/api/executions/active?projectPath=${encodeURIComponent('/project/cafe')}`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(
      body.waits.map((wait) => wait.waitId),
      ['hold-ball-timer-a'],
    );
    assert.equal(body.waits[0].projectPath, undefined);
  });

  it('never shows a hold on a thread this user cannot read', async () => {
    await start([timerHold({ deliveryThreadId: 'thread-unknown' })]);
    const body = await readAll(app);
    assert.deepEqual(body.waits, []);
  });
});

describe('listPendingHoldWaits', () => {
  let tasks;
  beforeEach(() => {
    tasks = [timerHold(), runningCommandHold()];
  });

  it('enumerates only armed timer holds with their owner and wake time', () => {
    assert.deepEqual(listPendingHoldWaits(tasks), [
      {
        taskId: 'hold-ball-timer-a',
        threadId: 'thread-hold',
        catId: 'codex61-sol',
        userId: USER_ID,
        since: 60_000,
        wakeAt: 660_000,
      },
    ]);
  });

  it('accepts a legacy hold without a lifecycle record', () => {
    const legacy = timerHold({ id: 'hold-ball-legacy' });
    delete legacy.params.holdLifecycle;
    assert.deepEqual(
      listPendingHoldWaits([legacy]).map((wait) => wait.taskId),
      ['hold-ball-legacy'],
    );
  });
});
