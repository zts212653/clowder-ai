import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import Redis from 'ioredis';
import { adoptOrdinaryTaskTenant } from '../src/domains/ball-custody/adopt-ordinary-task-tenant.js';
import { RedisTaskStore } from '../src/domains/cats/services/stores/redis/RedisTaskStore.js';
import { RedisThreadStore } from '../src/domains/cats/services/stores/redis/RedisThreadStore.js';
import { TaskKeys } from '../src/domains/cats/services/stores/redis-keys/task-keys.js';
import { ThreadKeys } from '../src/domains/cats/services/stores/redis-keys/thread-keys.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from './helpers/redis-test-helpers.js';
import { taskNativeCallbackFixture } from './helpers/task-native-callback-fixture.js';

async function redisFixture(t: TestContext) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'ordinary Task compatibility');
  const redis = new Redis(process.env.REDIS_URL!, { keyPrefix: `task-native-compat-${randomUUID()}:` });
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  return redis;
}

test('Redis callback concurrent pickup has one writer; exact ended binding recovers after store reconstruction', async (t) => {
  const redis = await redisFixture(t);
  const f = await taskNativeCallbackFixture(t, redis);
  const task = await f.tasks.create({
    threadId: f.home.id,
    title: 'Unassigned work',
    createdBy: 'user',
    userId: 'native-user',
  });
  const actors = await Promise.all(
    ['codex', 'sonnet'].map(async (catId) => {
      const auth = await f.registry.create('native-user', catId, f.home.id);
      await f.turns.createRunning({
        invocationId: auth.invocationId,
        parentInvocationId: auth.invocationId,
        catId,
        threadId: f.home.id,
        userId: 'native-user',
        executionKind: 'ordinary',
        providerLifecycleTracked: true,
        startedAt: Date.now(),
      });
      return { ...auth, catId };
    }),
  );
  const update = (fixture: typeof f, auth: (typeof actors)[number], status = 'doing') =>
    fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { taskId: task.id, status },
    });
  const results = await Promise.all(actors.map((auth) => update(f, auth)));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.body).join('\n'));
  assert.equal(results.filter((r) => r.statusCode === 409).length, 1);
  const winner = actors[results.findIndex((r) => r.statusCode === 200)]!;
  await f.turns.markProviderStarted(winner.invocationId, Date.now());
  await f.turns.transitionTerminal(winner.invocationId, {
    status: 'interrupted',
    endedAt: Date.now(),
    terminalReason: 'process_restart',
    providerTeardownAt: Date.now(),
  });
  const restarted = await taskNativeCallbackFixture(t, redis, {
    homeId: f.home.id,
    childId: f.child.id,
    taskId: f.task.id,
  });
  const auth = await restarted.registry.create('native-user', winner.catId, f.home.id);
  await restarted.turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: auth.invocationId,
    catId: winner.catId,
    threadId: f.home.id,
    userId: 'native-user',
    executionKind: 'ordinary',
    startedAt: Date.now(),
    providerLifecycleTracked: true,
  });
  const resumed = await update(restarted, { ...auth, catId: winner.catId });
  assert.equal(resumed.statusCode, 200, resumed.body);
  const stored = await new RedisTaskStore(redis).get(task.id);
  assert.equal(stored?.ownerRevision, 1);
  assert.equal(stored?.ownerCatId, winner.catId);
  assert.equal(stored?.executionRef?.invocationId, auth.invocationId);
  assert.equal((await update(restarted, { ...auth, catId: winner.catId }, 'done')).statusCode, 200);
});

test('legacy tenant adoption persists the canonical home user, preserves Task identity and never overwrites a tenant', async (t) => {
  const redis = await redisFixture(t),
    tasks = new RedisTaskStore(redis),
    threads = new RedisThreadStore(redis);
  const home = await threads.create('home-user', 'Legacy home', process.cwd());
  const task = await tasks.create({
    threadId: home.id,
    title: 'Old board row',
    createdBy: 'user',
    ownerCatId: 'codex',
  });
  await redis.hdel(TaskKeys.detail(task.id), 'ownerRevision'); // exact pre-switch row shape
  const legacy = await tasks.get(task.id);
  assert.ok(legacy);
  assert.equal(await adoptOrdinaryTaskTenant({ task: legacy, userId: 'foreign', tasks, threads }), null);
  assert.equal((await tasks.get(task.id))?.userId, undefined);
  const adopted = await adoptOrdinaryTaskTenant({ task: legacy, userId: 'home-user', tasks, threads });
  assert.equal(adopted?.userId, 'home-user');
  const reloaded = await new RedisTaskStore(redis).get(task.id);
  assert.equal(reloaded?.threadId, home.id);
  assert.equal(reloaded?.ownerCatId, 'codex');
  assert.equal(reloaded?.ownerRevision, undefined, 'tenant hydration must not invent an execution migration');
  assert.equal(await adoptOrdinaryTaskTenant({ task: reloaded!, userId: 'foreign', tasks, threads }), null);
});

test('legacy home drift between proof and EXEC aborts the tenant backfill at the same WATCH boundary', async (t) => {
  const redis = await redisFixture(t),
    tasks = new RedisTaskStore(redis),
    threads = new RedisThreadStore(redis);
  const other = redis.duplicate();
  t.after(() => other.quit());
  const home = await threads.create('home-user', 'Legacy home', process.cwd());
  const task = await tasks.create({ threadId: home.id, title: 'Old board row', createdBy: 'user' });
  let notify!: () => void,
    resume!: () => void,
    reads = 0;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const pending = adoptOrdinaryTaskTenant({
    task,
    userId: 'home-user',
    tasks,
    threads: {
      async get(id) {
        const current = await threads.get(id);
        if (++reads === 2) {
          notify();
          await released;
        }
        return current;
      },
    },
  });
  await entered;
  await other.hset(ThreadKeys.detail(home.id), 'createdBy', 'foreign');
  resume();
  await assert.rejects(pending, /TASK_LEGACY_HOME_AUTHORITY_CHANGED/);
  assert.equal((await tasks.get(task.id))?.userId, undefined);
  assert.equal((await tasks.get(task.id))?.ownerCatId, null);
});
