import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { tasksRoutes } from '../dist/routes/tasks.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;

async function fixture(t, backend, kind = 'pr_tracking', pending = false) {
  if (backend === 'redis') assertRedisIsolationOrThrow(redisUrl, 'plugin-wait-cancel-route');
  const redis = backend === 'redis' ? new Redis(redisUrl, { keyPrefix: `cancel-wait:${randomUUID()}:` }) : null;
  if (redis) t.after(() => redis.quit());
  const store = redis ? new RedisTaskStore(redis) : new TaskStore();
  let task = await store.create({
    kind,
    subjectKey: `subject:${randomUUID()}`,
    threadId: 'thread',
    title: 'Wait',
    why: '',
    createdBy: 'user',
    userId: 'owner',
    ownerCatId: 'codex',
  });
  const state = {
    pluginInstanceId: 'instance',
    generation: 1,
    userId: 'owner',
    catId: 'codex',
    threadId: 'thread',
    registration: { invocationId: 'inv', registeredAt: 1, source: { kind: 'primary', sourceMessageId: 'source' } },
    ...(pending
      ? {
          waitOutcome: {
            outcomeId: 'matched',
            generation: 1,
            ownerFence: { kind: 'containing_task', generation: 1 },
            reason: 'matched',
            delivery: 'pending',
          },
        }
      : { await: { generation: 1 } }),
  };
  task = await store.replacePluginWait(task.id, {
    expectedStatus: task.status,
    expectedState: undefined,
    expectedGeneration: null,
    state,
  });
  assert.ok(task);
  const events = [];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(tasksRoutes, {
    taskStore: store,
    socketManager: { broadcastToRoom: (...args) => events.push(args) },
  });
  const cancel = (options = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/cancel-wait`,
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {},
      ...options,
    });
  return { store, task, state, events, app, cancel };
}

for (const backend of ['memory', 'redis']) {
  const options = { skip: backend === 'redis' ? redisIsolationSkipReason(redisUrl) : false };
  for (const kind of ['pr_tracking', 'issue_tracking', 'work']) {
    test(`${backend}: user cancels active plugin wait (${kind}) without a provider lifecycle`, options, async (t) => {
      const f = await fixture(t, backend, kind);
      const response = await f.cancel();
      assert.equal(response.statusCode, 200, response.body);
      const saved = await f.store.get(f.task.id);
      assert.equal(saved.pluginWait.await, undefined);
      assert.equal(saved.pluginWait.registration, undefined);
      assert.equal(saved.pluginWait.invalidated, 'user_cancel');
      assert.equal(saved.pluginWait.waitOutcome.reason, 'user_cancel');
      assert.equal(saved.pluginWait.waitOutcome.delivery, 'not_applicable');
      assert.equal(saved.pluginWait.generation, 1);
      assert.equal(saved.status, kind === 'work' ? f.task.status : 'done');
      assert.equal(f.events.length, 1);
      assert.deepEqual(f.events[0], ['thread:thread', 'task_updated', saved]);
      assert.equal((await f.cancel()).statusCode, 409);
      assert.equal(
        await f.store.replacePluginWait(saved.id, {
          expectedStatus: saved.status,
          expectedState: saved.pluginWait,
          expectedGeneration: 1,
          state: f.state,
        }),
        null,
        'late old projection cannot revive cancellation',
      );
      const fresh = await f.store.replacePluginWait(saved.id, {
        expectedStatus: saved.status,
        expectedState: saved.pluginWait,
        expectedGeneration: 1,
        newRegistration: true,
        state: { ...f.state, generation: 2, await: { generation: 2 } },
      });
      assert.equal(!!fresh, kind !== 'work', 'existing explicit tracking restart semantics remain unchanged');
    });
  }
  test(`${backend}: cancel pending notification on terminal tracking task`, options, async (t) => {
    const f = await fixture(t, backend, 'issue_tracking', true);
    assert.equal(f.task.status, 'done');
    assert.equal((await f.cancel()).statusCode, 200);
    const saved = await f.store.get(f.task.id);
    assert.equal(saved.pluginWait.invalidated, 'user_cancel');
    assert.equal(saved.pluginWait.waitOutcome.delivery, 'not_applicable');
    assert.notEqual(saved.pluginWait.waitOutcome.outcomeId, 'matched');
  });
  test(`${backend}: authentication and empty-body checks leave wait unchanged`, options, async (t) => {
    const f = await fixture(t, backend);
    const before = structuredClone(await f.store.get(f.task.id));
    assert.equal((await f.cancel({ headers: {} })).statusCode, 401);
    assert.equal((await f.cancel({ headers: { 'x-cat-cafe-user': 'other' } })).statusCode, 403);
    assert.equal((await f.cancel({ payload: { generation: 99 } })).statusCode, 400);
    assert.deepEqual(await f.store.get(f.task.id), before);
    assert.equal(f.events.length, 0);
  });
  for (const race of ['owner', 'thread', 'generation', 'delivered']) {
    test(`${backend}: cancellation loses CAS to concurrent ${race} change`, options, async (t) => {
      const f = await fixture(t, backend);
      const replace = f.store.replacePluginWait.bind(f.store);
      let winner;
      let calls = 0;
      f.store.replacePluginWait = async (id, input) => {
        calls++;
        if (race === 'owner' || race === 'thread') {
          winner = await f.store.update(id, race === 'owner' ? { ownerCatId: 'opus' } : { threadId: 'other-thread' });
        } else {
          winner = await replace(id, {
            expectedStatus: f.task.status,
            expectedState: f.state,
            expectedGeneration: 1,
            state:
              race === 'generation'
                ? { ...f.state, generation: 2, await: { generation: 2 } }
                : {
                    ...f.state,
                    await: undefined,
                    waitOutcome: {
                      outcomeId: 'delivered',
                      generation: 1,
                      ownerFence: { kind: 'containing_task', generation: 1 },
                      reason: 'matched',
                      delivery: 'delivered',
                    },
                  },
          });
        }
        assert.ok(winner);
        winner = await f.store.get(id);
        return replace(id, input);
      };
      assert.equal((await f.cancel()).statusCode, 409);
      assert.equal(
        calls,
        1,
        'route must reach CAS exactly once, not refuse an otherwise active wait or retry across ownership',
      );
      assert.deepEqual(await f.store.get(f.task.id), winner);
      assert.equal(f.events.length, 0);
    });
  }
  test(`${backend}: delivered wait is not cancellable`, options, async (t) => {
    const f = await fixture(t, backend, 'issue_tracking', true);
    const state = { ...f.state, waitOutcome: { ...f.state.waitOutcome, delivery: 'delivered' } };
    const before = await f.store.replacePluginWait(f.task.id, {
      expectedStatus: f.task.status,
      expectedState: f.state,
      expectedGeneration: 1,
      state,
    });
    assert.equal((await f.cancel()).statusCode, 409);
    assert.deepEqual(await f.store.get(f.task.id), before);
    assert.equal(f.events.length, 0);
  });
}
