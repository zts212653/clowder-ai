/**
 * F167 PR-A — the hold route's `503 HOLD_OWNER_FENCE_UNAVAILABLE` says which of its five causes it fell on.
 *
 * `resolveHoldWaitOwnerFence` reads the calling invocation's PARENT record and refuses (fails closed) unless it
 * exists in the same thread and tenant and lists the calling cat. Five different causes used to collapse into one
 * opaque 503, so a cat that hit it could not tell a missing parent from a thread mismatch from a failed read.
 * The response now carries one reason code, and only the code: no thread, tenant or record data. The route still
 * refuses, releases the quota reservation it took, and creates no task.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const PARENT = 'parent-invocation';

describe('F167 hold owner fence 503 carries a reason code', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  function stubDeps(parentRead) {
    const inserted = [];
    const released = [];
    return {
      registry,
      holdQuotaStore: {
        async tryAdmit() {
          return { admitted: true, count: 1, eventId: 'event-1' };
        },
        async releaseByEventId(...args) {
          released.push(args);
          return true;
        },
        async getCount() {
          return 0;
        },
        async close() {},
      },
      taskRunner: { registerDynamic() {}, unregister: () => true },
      templateRegistry: {
        get: (id) => (id === 'reminder' ? { createSpec: (taskId, taskParams) => ({ taskId, taskParams }) } : undefined),
      },
      dynamicTaskStore: {
        insert: (record) => inserted.push(record),
        getAll: () => inserted,
        getById: (id) => inserted.find((task) => task.id === id),
        remove: () => true,
        getPrivateOwnerAuthProvenance: () => 'unknown',
        updateParams: () => true,
        updateParamsIfCurrent: () => true,
        setEnabled: () => true,
      },
      messageStore: {
        getByIdempotencyKey: () => null,
        async append(message) {
          return { id: 'message-1', ...message };
        },
      },
      socketManager: { broadcastToRoom() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null, get: parentRead },
      _inserted: inserted,
      _released: released,
    };
  }

  async function holdFrom(deps, threadId) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: { broadcastAgentMessage() {}, getMessages: () => [] },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: deps,
    });
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', threadId, PARENT);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'wait for a bounded external condition',
        nextStep: 'resume',
        wakeAfterMs: 10_000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'AgeOfLearning/cat-cafe#999',
          expectedSignal: 'issue closed',
          slaUntilMs: Date.now() + 60_000,
        },
      },
    });
    await app.close();
    return response;
  }

  const record = (thread, overrides = {}) => ({
    threadId: thread.id,
    userId: 'user-1',
    targetCats: ['codex'],
    actionLeaseCarrier: { kind: 'none' },
    ...overrides,
  });

  const causes = {
    parent_missing: () => async () => null,
    thread_mismatch: (thread) => async () => record(thread, { threadId: 'thread-elsewhere' }),
    user_mismatch: (thread) => async () => record(thread, { userId: 'user-2' }),
    target_cat_missing: (thread) => async () => record(thread, { targetCats: ['opus'] }),
    store_read_failed: () => async () => {
      throw new Error('record store unavailable');
    },
  };

  for (const [reason, makeRead] of Object.entries(causes)) {
    test(`${reason}: 503 with exactly that reason code, still failing closed`, async () => {
      const thread = await threadStore.create('user-1', 'fence');
      const deps = stubDeps(makeRead(thread));

      const response = await holdFrom(deps, thread.id);

      assert.equal(response.statusCode, 503, response.body);
      const body = JSON.parse(response.body);
      assert.deepEqual(body, {
        error: 'Canonical hold owner fence is unavailable',
        code: 'HOLD_OWNER_FENCE_UNAVAILABLE',
        reason,
      });
      assert.equal(deps._inserted.length, 0, 'no task is created');
      assert.equal(deps._released.length, 1, 'the quota reservation is released');
    });
  }

  test('control: a parent in the same thread and tenant listing the cat is admitted (the guard is unchanged)', async () => {
    const thread = await threadStore.create('user-1', 'fence');
    const deps = stubDeps(async () => record(thread));

    const response = await holdFrom(deps, thread.id);

    assert.equal(response.statusCode, 200, response.body);
  });
});
