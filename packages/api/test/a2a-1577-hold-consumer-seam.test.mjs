import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ManagedCommandWakeRecoverySweep } from '../src/domains/ball-custody/ManagedCommandWakeRecoverySweep.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.ts';
import { registerCallbackHoldBallRoutes } from '../src/routes/callback-hold-ball-routes.ts';

// Actual callback route/auth + in-memory canonical History. No runtime, SQLite, Redis or model.
async function fixture(t, options = {}) {
  const registry = new InvocationRegistry();
  const auth = await registry.create('sandbox-user', 'codex', 'sandbox-thread', options.parentId);
  const messages = new MessageStore();
  const tasks = new Map();
  const released = [];
  const registered = [];
  const reservations = [];
  const quota = options.quota ?? {
    async tryAdmit(thread, cat) {
      const eventId = `quota-${reservations.length + 1}`;
      reservations.push([eventId, thread, cat]);
      return { admitted: true, count: reservations.length, eventId };
    },
    async releaseByEventId(...args) {
      released.push(args);
      return true;
    },
    async getCount() {
      return reservations.length;
    },
  };
  const deps = {
    registry,
    ownerUserId: 'sandbox-user',
    holdQuotaStore: quota,
    threadStore: { get: () => ({ id: 'sandbox-thread', userId: 'sandbox-user' }) },
    invocationRecordStore: { get: options.parentRead ?? (() => null) },
    dynamicTaskStore: {
      getAll: () => [...tasks.values()],
      getById: (id) => tasks.get(id) ?? null,
      insert(task) {
        tasks.set(task.id, task);
      },
      remove(id) {
        return tasks.delete(id);
      },
      updateParamsIfCurrent(id, expected, params) {
        const current = tasks.get(id);
        if (!current || current.params !== expected) return false;
        tasks.set(id, { ...current, params });
        return true;
      },
      setEnabled(id, enabled) {
        const current = tasks.get(id);
        if (!current) return false;
        tasks.set(id, { ...current, enabled });
        return true;
      },
    },
    taskRunner: {
      registerDynamic(_spec, id) {
        registered.push(id);
      },
      unregister(id) {
        const index = registered.indexOf(id);
        if (index >= 0) registered.splice(index, 1);
        return true;
      },
    },
    templateRegistry: { get: () => ({ createSpec: () => ({}) }) },
    messageStore: options.messageStore?.(messages) ?? messages,
    socketManager: { broadcastToRoom() {} },
  };
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  registerCallbackHoldBallRoutes(app, deps);
  t.after(() => app.close());
  return {
    app,
    tasks,
    messages,
    reservations,
    registered,
    released,
    deps,
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    async hold() {
      return app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          reason: 'bounded sandbox wait',
          nextStep: 'inspect exact sandbox evidence',
          wakeAfterMs: 10_000,
          waitSourceRef: {
            kind: 'github_issue',
            value: 'sandbox/example#1',
            expectedSignal: 'changed',
            slaUntilMs: Date.now() + 60_000,
          },
        },
      });
    },
  };
}

test('hold rejection uses both retry values from the same quota authority clock', async (t) => {
  const f = await fixture(t, {
    quota: {
      async tryAdmit() {
        return { admitted: false, count: 3, retryAtMs: 2000, retryAfterMs: 37 };
      },
    },
  });
  const result = await f.hold();
  assert.equal(result.statusCode, 429, result.body);
  assert.equal(result.json().retryAt, new Date(2000).toISOString());
  assert.equal(result.json().retryAfterMs, 37);
  assert.equal(f.tasks.size, 0);
});

test('definite waiting History failure releases exactly its quota event and leaves the prior hold', async (t) => {
  const f = await fixture(t, {
    messageStore: () => ({
      append: async () => {
        throw new Error('sandbox append unavailable');
      },
      getByIdempotencyKey: () => null,
    }),
  });
  const prior = {
    id: 'hold-ball-prior',
    templateId: 'reminder',
    createdBy: 'hold-ball:codex',
    deliveryThreadId: 'sandbox-thread',
    enabled: true,
    trigger: { type: 'once', fireAt: 100 },
    params: { holdLifecycle: { mode: 'timer', status: 'active', createdBy: 'hold-ball:codex' } },
  };
  f.tasks.set(prior.id, prior);
  const result = await f.hold();
  assert.equal(result.statusCode, 503, result.body);
  assert.equal(result.json().code, 'HOLD_WAITING_HISTORY_UNAVAILABLE');
  assert.deepEqual([...f.tasks.values()], [prior]);
  assert.deepEqual(f.registered, []);
  assert.deepEqual(f.released, [['quota-1', 'sandbox-thread', 'codex']]);
});

test('unknown History outcome retains the recoverable task and its quota reservation', async (t) => {
  const f = await fixture(t, {
    messageStore: () => ({
      append: async () => {
        throw new Error('ambiguous write');
      },
      getByIdempotencyKey: () => {
        throw new Error('ambiguous read');
      },
    }),
  });
  const result = await f.hold();
  assert.equal(result.statusCode, 503, result.body);
  assert.equal(result.json().code, 'HOLD_WAITING_HISTORY_OUTCOME_UNKNOWN');
  assert.equal(f.tasks.size, 1);
  assert.equal(f.registered.length, 1);
  assert.deepEqual(f.released, []);
});

test('History commit followed by transport error is read back, not rolled back', async (t) => {
  const f = await fixture(t, {
    messageStore: (messages) => ({
      append(input) {
        messages.append(input);
        throw new Error('lost reply after commit');
      },
      getByIdempotencyKey: (...args) => messages.getByIdempotencyKey(...args),
    }),
  });
  const result = await f.hold();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(f.tasks.size, 1);
  assert.deepEqual(f.released, []);
});

for (const [reason, parentRead] of Object.entries({
  parent_missing: () => null,
  thread_mismatch: () => ({ threadId: 'elsewhere' }),
  user_mismatch: () => ({ threadId: 'sandbox-thread', userId: 'elsewhere' }),
  target_cat_missing: () => ({ threadId: 'sandbox-thread', userId: 'sandbox-user', targetCats: ['opus'] }),
  store_read_failed: () => {
    throw new Error('sandbox record read unavailable');
  },
})) {
  test(`hold owner failure ${reason} releases only this quota reservation`, async (t) => {
    const f = await fixture(t, { parentId: 'sandbox-parent', parentRead });
    const result = await f.hold();
    assert.equal(result.statusCode, 503, result.body);
    assert.equal(result.json().reason, reason);
    assert.equal(f.tasks.size, 0);
    assert.deepEqual(f.released, [['quota-1', 'sandbox-thread', 'codex']]);
    assert.doesNotMatch(result.body, /sandbox-parent|elsewhere|sandbox-user/);
  });
}

test('materialization failure compensates the exact quota reservation', async (t) => {
  const f = await fixture(t);
  f.deps.templateRegistry.get = () => ({
    createSpec() {
      throw new Error('sandbox materialization unavailable');
    },
  });
  const result = await f.hold();
  assert.equal(result.statusCode, 500, result.body);
  assert.equal(f.tasks.size, 0);
  assert.deepEqual(f.released, [['quota-1', 'sandbox-thread', 'codex']]);
});

test('timer replacement persists its terminal tombstone and waiting History first', async (t) => {
  const f = await fixture(t);
  const first = await f.hold();
  assert.equal(first.statusCode, 200, first.body);
  const id = first.json().taskId;
  const second = await f.hold();
  assert.equal(second.statusCode, 200, second.body);
  const prior = f.tasks.get(id);
  assert.equal(prior.params.holdLifecycle.status, 'retired_by_replacement');
  assert.equal(prior.enabled, false);
  assert.equal(prior.params.holdLifecycle.replacedByTaskId, second.json().taskId);
  assert.equal(f.tasks.size, 2, 'retired timer remains readable rather than removed');
  const history = f.messages.getByIdempotencyKey('sandbox-user', 'sandbox-thread', `hold-ball-waiting:${id}`);
  assert.ok(history);
});

test('former shadow-owner completion routes are not restored by the hold migration', async (t) => {
  const f = await fixture(t);
  for (const suffix of ['complete-managed-hold', 'complete-a2a-dispatch']) {
    const result = await f.app.inject({
      method: 'POST',
      url: `/api/callbacks/${suffix}`,
      headers: f.headers,
      payload: { disposition: 'completed' },
    });
    assert.equal(result.statusCode, 404);
  }
  assert.equal(f.tasks.size, 0);
});

test('overlapping recovery sweeps share one cycle, then permit a fresh cycle', async () => {
  let entered = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const sweep = new ManagedCommandWakeRecoverySweep({
    dynamicTaskStore: { getAll: () => [] },
    admitWake: async () => ({}),
  });
  // Delayed read-only recovery step measures real runOnce ownership, not an arbitrary sleep.
  sweep.recoverAdmissionFacts = async () => {
    entered++;
    await barrier;
    return { scanned: 0, recovered: 0, pending: 0 };
  };
  const first = sweep.runOnce();
  const second = sweep.runOnce();
  release();
  await Promise.all([first, second]);
  assert.equal(entered, 1);
  await sweep.runOnce();
  assert.equal(entered, 2);
});
