/**
 * F167 C1 × Phase P — rolling-window counter exempts wakeWhen (#1471)
 *
 * Root cause (issue #1471): the
 * MAX_HOLDS_PER_WINDOW guard and incrementHoldCount sat on the code path shared
 * by wakeAfterMs (timer hold) and wakeWhen (managed command). A cat hosting four
 * ordinary test/build commands in one thread inside an hour was told
 * "pass the ball" (429), although every managed command carries its own definite
 * completion signal — the window limited registrations, not progress.
 *
 * Contract locked here:
 *   - wakeWhen never consumes a window slot (holdsInWindow stays at the timer count)
 *   - wakeWhen is admitted even when the timer window is exhausted (3/3)
 *   - wakeAfterMs still consumes slots and still 429s on the 4th (mixed flow)
 * Pure-timer exhaustion (4× wakeAfterMs → 429) stays locked in
 * `callback-hold-ball-route-scheduling.test.js`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const VALID_WAIT_SOURCE_REF = {
  kind: 'github_issue',
  value: 'AgeOfLearning/cat-cafe#999',
  expectedSignal: 'issue closed',
  slaUntilMs: 3_600_000,
};

const TIMED = {
  reason: 'waiting on issue',
  nextStep: 'continue',
  wakeAfterMs: 10_000,
  waitSourceRef: VALID_WAIT_SOURCE_REF,
};

const COMMAND = {
  reason: 'running gate',
  nextStep: 'check result',
  wakeWhen: { command: 'echo ok' },
};

describe('#1471: hold-ball rolling window counts timer holds only (wakeWhen exempt)', () => {
  let registry;
  let threadStore;
  let getHoldCount;
  let getActiveRunnerCount;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const routeModule = await import('../dist/routes/callback-hold-ball-routes.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    getHoldCount = routeModule.getHoldCount;
    getActiveRunnerCount = routeModule.getActiveRunnerCount;
  });

  function makeStubDeps() {
    const insertedTasks = [];
    const removedIds = [];
    const live = (id) => insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
    const reminderTemplate = {
      createSpec(taskId, taskParams) {
        return { taskId, taskParams };
      },
    };
    return {
      registry,
      taskRunner: {
        registerDynamic() {},
        unregister() {
          return true;
        },
      },
      templateRegistry: {
        get(id) {
          return id === 'reminder' ? reminderTemplate : undefined;
        },
      },
      dynamicTaskStore: {
        insert(record) {
          insertedTasks.push(record);
        },
        getAll() {
          return insertedTasks.filter((t) => !removedIds.includes(t.id));
        },
        getById(id) {
          return live(id);
        },
        remove(id) {
          removedIds.push(id);
          return true;
        },
        updateParams(id, params) {
          const task = live(id);
          if (!task) return false;
          task.params = params;
          return true;
        },
        updateParamsIfCurrent(id, expected, params) {
          const task = live(id);
          if (!task || task.params !== expected) return false;
          task.params = params;
          return true;
        },
        setEnabled(id, enabled) {
          const task = live(id);
          if (!task) return false;
          task.enabled = enabled;
          return true;
        },
      },
      messageStore: {
        getByIdempotencyKey() {
          return null;
        },
        async append(msg) {
          return { id: `test-msg-${insertedTasks.length}`, ...msg };
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      // Completion path (after the HTTP response) resolves the invocation carrier;
      // stub it like callback-hold-ball-wakewhen.test.js so no error logs leak.
      invocationRecordStore: {
        getByIdempotencyKey(_threadId, _userId, key) {
          return { id: `invocation-${key}`, userMessageId: key.slice('connector-'.length), status: 'running' };
        },
      },
      _insertedTasks: insertedTasks,
    };
  }

  async function createApp(holdBallDeps) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps,
    });
    return app;
  }

  async function makeSession(user) {
    const thread = await threadStore.create(user, `${user}-thread`);
    const { invocationId, callbackToken } = await registry.create(user, 'codex', thread.id);
    return {
      threadId: thread.id,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    };
  }

  async function hold(app, headers, payload) {
    const response = await app.inject({ method: 'POST', url: '/api/callbacks/hold-ball', headers, payload });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }

  async function drainAndClose(app) {
    const deadline = Date.now() + 5_000;
    while (getActiveRunnerCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await app.close();
  }

  test('four wakeWhen holds in one window: all admitted, no window slot consumed', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const { threadId, headers } = await makeSession('user-f001-cmd');
    try {
      for (let i = 1; i <= 4; i++) {
        const { status, body } = await hold(app, headers, COMMAND);
        assert.equal(status, 200, `managed command #${i} must be admitted`);
        assert.equal(body.holdsInWindow, 0, `managed command #${i} must not tick the window`);
      }
      assert.equal(getHoldCount(threadId, 'codex'), 0, 'counter untouched by wakeWhen');
      assert.equal(deps._insertedTasks.length, 4, 'every command hold scheduled its wake carrier');
    } finally {
      await drainAndClose(app);
    }
  });

  test('mixed flow: only timer holds tick; wakeWhen passes at 3/3; 4th timer still 429', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const { threadId, headers } = await makeSession('user-f001-mixed');
    try {
      const steps = [
        [COMMAND, 200, 0],
        [TIMED, 200, 1],
        [COMMAND, 200, 1],
        [TIMED, 200, 2],
        [TIMED, 200, 3],
        [COMMAND, 200, 3], // timer window exhausted — a managed command is still admitted
        [TIMED, 429, 3],
        [COMMAND, 200, 3], // still admitted right after the timer 429
      ];
      for (const [index, [payload, expectedStatus, expectedInWindow]] of steps.entries()) {
        const { status, body } = await hold(app, headers, payload);
        const label = `step ${index + 1} (${payload.wakeWhen ? 'wakeWhen' : 'wakeAfterMs'})`;
        assert.equal(status, expectedStatus, label);
        assert.equal(body.holdsInWindow, expectedInWindow, `${label} holdsInWindow`);
        if (expectedStatus === 429) {
          assert.match(body.error, /maxHoldsPerWindow/);
          assert.match(body.error, /pass the ball now/);
        }
      }
      assert.equal(getHoldCount(threadId, 'codex'), 3, 'only the three timer holds are counted');
      assert.equal(deps._insertedTasks.length, 7, 'the 429 timer hold must not schedule a wake');
    } finally {
      await drainAndClose(app);
    }
  });
});
