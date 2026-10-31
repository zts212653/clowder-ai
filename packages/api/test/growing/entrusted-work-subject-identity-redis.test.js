import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const now = 1_788_233_000_000;

function admissionCommand() {
  return {
    task: {
      threadId: 'thread-source',
      title: 'Prepare the canonical result',
      why: 'Explicitly entrusted in the source conversation',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner-redis',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source-redis'],
      intendedOutcome: 'A reviewable result is ready',
      idempotencyKey: 'entrusted:subject-identity-redis',
    },
    closure: {
      condition: 'The result is reviewable',
      expectedSignal: 'artifact:final',
    },
  };
}

function genericTask(subjectKey, threadId = 'thread-shadow') {
  return {
    subjectKey,
    threadId,
    title: 'Generic shadow task',
    why: 'Attempt to claim the same fact',
    createdBy: 'codex-terra',
    ownerCatId: 'codex-terra',
    userId: 'owner-redis',
  };
}

function pauseFirstEval(redis) {
  let release;
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let paused = false;

  const client = new Proxy(redis, {
    get(target, property, receiver) {
      if (property === 'eval') {
        return async (...args) => {
          if (!paused) {
            paused = true;
            markEntered();
            await released;
          }
          return target.eval(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { client, entered, release };
}

function pauseFirstHashRead(redis) {
  let release;
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let paused = false;

  const client = new Proxy(redis, {
    get(target, property, receiver) {
      if (property === 'hgetall') {
        return async (...args) => {
          const result = await target.hgetall(...args);
          if (!paused) {
            paused = true;
            markEntered();
            await released;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { client, entered, release };
}

function pauseFirstUnwatchAndHashRead(redis, hashKey) {
  let releaseCleanup;
  let markCleanupEntered;
  const cleanupEntered = new Promise((resolve) => {
    markCleanupEntered = resolve;
  });
  const cleanupReleased = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  let cleanupPaused = false;

  let releaseHashRead;
  let markHashReadEntered;
  const hashReadEntered = new Promise((resolve) => {
    markHashReadEntered = resolve;
  });
  const hashReadReleased = new Promise((resolve) => {
    releaseHashRead = resolve;
  });
  let hashReadPaused = false;

  const wrapSession = (session) =>
    new Proxy(session, {
      get(target, property, receiver) {
        if (property === 'unwatch') {
          return async (...args) => {
            if (!cleanupPaused) {
              cleanupPaused = true;
              markCleanupEntered();
              await cleanupReleased;
            }
            return target.unwatch(...args);
          };
        }
        if (property === 'hgetall') {
          return async (...args) => {
            const result = await target.hgetall(...args);
            if (!hashReadPaused && args[0] === hashKey) {
              hashReadPaused = true;
              markHashReadEntered();
              await hashReadReleased;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const client = new Proxy(redis, {
    get(target, property, receiver) {
      if (property === 'duplicate') {
        return (...args) => wrapSession(target.duplicate(...args));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { client, cleanupEntered, releaseCleanup, hashReadEntered, releaseHashRead };
}

async function assertRejectedWatchDoesNotLeak(redis, taskId, rejectMutation, markerSuffix) {
  const otherClient = redis.duplicate();
  const markerKey = `task:watch-cleanup:${markerSuffix}`;
  await otherClient.ping();
  try {
    await assert.rejects(rejectMutation, (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED');
    await otherClient.hset(`task:${taskId}`, 'title', `External mutation ${markerSuffix}`);

    const unrelated = redis.multi();
    unrelated.set(markerKey, 'committed');
    const result = await unrelated.exec();

    assert.ok(result, 'expected rejection must not leave WATCH state on the shared connection');
    assert.equal(await redis.get(markerKey), 'committed');
  } finally {
    await redis.unwatch();
    await redis.del(markerKey);
    await otherClient.quit();
  }
}

async function assertRejectedCleanupCannotClearConcurrentWatch({
  redis,
  RedisTaskStore,
  EntrustedWorkLifecycleService,
  rejectMutation,
  rejectionMatcher,
}) {
  const seedStore = new RedisTaskStore(redis);
  const lifecycle = new EntrustedWorkLifecycleService(seedStore, { now: () => now });
  const admitted = await lifecycle.admitOrResume(admissionCommand());
  const entrustedTaskId = admitted.ownerRef.replace('task:item:', '');
  const ordinary = await seedStore.create({
    threadId: 'thread-b',
    title: 'Ordinary task B',
    createdBy: 'codex-sol',
    ownerCatId: 'codex-sol',
    userId: 'owner-redis',
  });
  const gate = pauseFirstUnwatchAndHashRead(redis, `task:${ordinary.id}`);
  const sharedConnectionStore = new RedisTaskStore(gate.client);
  const otherClient = redis.duplicate();
  await otherClient.ping();

  try {
    const rejection = rejectMutation(sharedConnectionStore, entrustedTaskId);
    await gate.cleanupEntered;

    const conditionalUpdate = sharedConnectionStore.updateIfThreadId(ordinary.id, 'thread-b', {
      title: 'Stale update B',
    });
    gate.releaseCleanup();
    await assert.rejects(rejection, rejectionMatcher);
    await gate.hashReadEntered;

    const externalStore = new RedisTaskStore(otherClient);
    const externallyMoved = await externalStore.updateIfThreadId(ordinary.id, 'thread-b', {
      threadId: 'thread-external',
      title: 'External move B',
    });
    assert.equal(externallyMoved?.threadId, 'thread-external');

    gate.releaseHashRead();
    await conditionalUpdate;

    const canonical = await seedStore.get(ordinary.id);
    assert.equal(canonical?.threadId, 'thread-external');
    assert.equal(canonical?.title, 'External move B');
  } finally {
    gate.releaseCleanup();
    gate.releaseHashRead();
    await redis.unwatch();
    await otherClient.quit();
  }
}

function pauseFirstWatchSessionHashRead(redis, hashKey) {
  let releaseHashRead;
  let markHashReadEntered;
  const hashReadEntered = new Promise((resolve) => {
    markHashReadEntered = resolve;
  });
  const hashReadReleased = new Promise((resolve) => {
    releaseHashRead = resolve;
  });
  let hashReadPaused = false;

  const wrapSession = (session) =>
    new Proxy(session, {
      get(target, property, receiver) {
        if (property === 'hgetall') {
          return async (...args) => {
            const result = await target.hgetall(...args);
            if (!hashReadPaused && args[0] === hashKey) {
              hashReadPaused = true;
              markHashReadEntered();
              await hashReadReleased;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const client = new Proxy(redis, {
    get(target, property, receiver) {
      if (property === 'duplicate') {
        return (...args) => wrapSession(target.duplicate(...args));
      }
      if (property === 'hgetall') {
        return async (...args) => {
          const result = await target.hgetall(...args);
          if (!hashReadPaused && args[0] === hashKey) {
            hashReadPaused = true;
            markHashReadEntered();
            await hashReadReleased;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { client, hashReadEntered, releaseHashRead };
}

async function assertForeignTransactionCannotConsumeWatch({
  redis,
  RedisTaskStore,
  watchedMutation,
  assertMutationApplied,
}) {
  const seedStore = new RedisTaskStore(redis);
  const ordinary = await seedStore.create({
    threadId: 'thread-b',
    title: 'Ordinary task B',
    createdBy: 'codex-sol',
    ownerCatId: 'codex-sol',
    userId: 'owner-redis',
  });
  const gate = pauseFirstWatchSessionHashRead(redis, `task:${ordinary.id}`);
  const watchedStore = new RedisTaskStore(gate.client);
  const otherClient = redis.duplicate();
  await otherClient.ping();

  try {
    const mutation = watchedMutation(watchedStore, ordinary.id);
    await gate.hashReadEntered;

    await seedStore.create({
      threadId: 'thread-foreign-transaction',
      title: 'Unrelated public create',
      createdBy: 'codex-terra',
      ownerCatId: 'codex-terra',
      userId: 'owner-redis',
    });

    const externalStore = new RedisTaskStore(otherClient);
    const externallyMoved = await externalStore.updateIfThreadId(ordinary.id, 'thread-b', {
      threadId: 'thread-external',
      title: 'External move B',
    });
    assert.equal(externallyMoved?.threadId, 'thread-external');

    gate.releaseHashRead();
    const mutationResult = await mutation;
    const canonical = await seedStore.get(ordinary.id);
    assert.equal(canonical?.threadId, 'thread-external');
    assert.equal(canonical?.title, 'External move B');
    assertMutationApplied?.(canonical, mutationResult);
  } finally {
    gate.releaseHashRead();
    await otherClient.quit();
  }
}
describe('F310 Redis Task subject identity', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let RedisTaskStore;
  let EntrustedWorkLifecycleService;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F310 Redis Task subject identity');
    const [{ createRedisClient }, storeModule, serviceModule] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../../dist/domains/cats/services/stores/redis/RedisTaskStore.js'),
      import('../../dist/domains/growing/EntrustedWorkLifecycleService.js'),
    ]);
    RedisTaskStore = storeModule.RedisTaskStore;
    EntrustedWorkLifecycleService = serviceModule.EntrustedWorkLifecycleService;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['task:*', 'tasks:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['task:*', 'tasks:*']);
    await redis.quit();
  });

  test('generic create and upsert cannot preclaim the entrusted subject namespace', async () => {
    const store = new RedisTaskStore(redis);
    const createSubject = `entrusted:${'a'.repeat(64)}`;
    const upsertSubject = `entrusted:${'b'.repeat(64)}`;

    await assert.rejects(
      store.create(genericTask(createSubject)),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    await assert.rejects(
      store.upsertBySubject(genericTask(upsertSubject)),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    await assert.rejects(
      store.upsertBySubjectWithManagedWorkBinding(
        { ...genericTask(upsertSubject), kind: 'pr_tracking' },
        { workId: 'work-shadow', attemptId: 'attempt-shadow' },
      ),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    assert.equal(await store.getBySubject(createSubject), null);
    assert.equal(await store.getBySubject(upsertSubject), null);
    assert.deepEqual(await store.listByThread('thread-shadow'), []);
  });

  test('generic create cannot shadow admitted custody and typed replay keeps the canonical owner', async () => {
    const store = new RedisTaskStore(redis);
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admitted.ownerRef.replace('task:item:', '');
    const canonical = await store.get(taskId);

    await assert.rejects(
      store.create(genericTask(canonical.subjectKey)),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    assert.equal((await store.getBySubject(canonical.subjectKey)).id, taskId);
    assert.deepEqual(await store.listByThread('thread-shadow'), []);

    const replay = await lifecycle.admitOrResume(admissionCommand());
    assert.equal(replay.result, 'resumed');
    assert.equal(replay.ownerRef, admitted.ownerRef);
    assert.equal((await store.listByThread('thread-source')).length, 1);
  });

  test('concurrent ordinary subject creation has one winner and no shadow Task artifacts', async () => {
    const subjectKey = 'pr:acme/widgets#310';
    const left = new RedisTaskStore(redis);
    const right = new RedisTaskStore(redis);
    const results = await Promise.allSettled([
      left.create(genericTask(subjectKey, 'thread-left')),
      right.create(genericTask(subjectKey, 'thread-right')),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason?.code, 'TASK_SUBJECT_ALREADY_EXISTS');
    const canonical = await left.getBySubject(subjectKey);
    assert.ok(canonical);
    const stored = [...(await left.listByThread('thread-left')), ...(await left.listByThread('thread-right'))];
    assert.deepEqual(
      stored.map((task) => task.id),
      [canonical.id],
    );
  });

  test('ordinary creation repairs only a stale subject pointer before claiming it', async () => {
    const store = new RedisTaskStore(redis);
    const subjectKey = 'pr:acme/widgets#stale';
    await redis.set(`tasks:subject:${subjectKey}`, 'stale-task-id');

    const created = await store.create(genericTask(subjectKey, 'thread-recovered'));

    assert.equal((await store.getBySubject(subjectKey)).id, created.id);
    assert.equal((await store.listByThread('thread-recovered')).length, 1);
    assert.equal(await store.get('stale-task-id'), null);
  });

  test('create winning an unbound subject race leaves the losing upsert with zero effects', async () => {
    const subjectKey = 'pr:acme/widgets#atomic-upsert';
    const gate = pauseFirstEval(redis);
    const upsertStore = new RedisTaskStore(gate.client);
    const createStore = new RedisTaskStore(redis);
    const losingUpsert = upsertStore.upsertBySubject({
      ...genericTask(subjectKey, 'thread-upsert'),
      title: 'Losing upsert',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
    });

    await gate.entered;
    const winner = await createStore.create({
      ...genericTask(subjectKey, 'thread-create'),
      title: 'Winning create',
    });
    gate.release();

    await assert.rejects(losingUpsert, (error) => error?.code === 'TASK_SUBJECT_ALREADY_EXISTS');
    const canonical = await createStore.getBySubject(subjectKey);
    assert.equal(canonical.id, winner.id);
    assert.equal(canonical.threadId, 'thread-create');
    assert.equal(canonical.ownerCatId, 'codex-terra');
    assert.equal(canonical.title, 'Winning create');
    assert.deepEqual(
      (await createStore.listByThread('thread-create')).map((task) => task.id),
      [winner.id],
    );
    assert.deepEqual(
      (await createStore.listByKind('work')).map((task) => task.id),
      [winner.id],
    );
    assert.deepEqual(await createStore.listByThread('thread-upsert'), []);
  });

  test('typed admission first claim is atomic and a concurrent compatible loser only resumes', async () => {
    const command = admissionCommand();
    const digest = createHash('sha256').update(command.admission.idempotencyKey).digest('hex');
    const subjectKey = `entrusted:${digest}`;
    const gate = pauseFirstEval(redis);
    const pausedStore = new RedisTaskStore(gate.client);
    const contenderStore = new RedisTaskStore(redis);
    const pausedLifecycle = new EntrustedWorkLifecycleService(pausedStore, { now: () => now });
    const contenderLifecycle = new EntrustedWorkLifecycleService(contenderStore, { now: () => now });
    const pausedAdmission = pausedLifecycle.admitOrResume(command);

    await gate.entered;
    const ownerDuringPausedTransition = await redis.get(`tasks:subject:${subjectKey}`);
    let contender;
    try {
      contender = await contenderLifecycle.admitOrResume(command);
    } finally {
      gate.release();
    }
    const resumed = await pausedAdmission;

    assert.equal(ownerDuringPausedTransition, null);
    assert.deepEqual([contender.result, resumed.result].sort(), ['admitted', 'resumed']);
    assert.equal(contender.ownerRef, resumed.ownerRef);
    const taskId = contender.ownerRef.replace('task:item:', '');
    assert.equal((await contenderStore.getBySubject(subjectKey)).id, taskId);
    assert.deepEqual(
      (await contenderStore.listByThread('thread-source')).map((task) => task.id),
      [taskId],
    );
    assert.deepEqual(
      (await contenderStore.listByKind('work')).map((task) => task.id),
      [taskId],
    );
  });

  test('typed closure remains terminal when a stale metadata-only generic update resumes', async () => {
    const store = new RedisTaskStore(redis);
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admitted.ownerRef.replace('task:item:', '');
    const gate = pauseFirstHashRead(redis);
    const staleStore = new RedisTaskStore(gate.client);
    const staleUpdate = staleStore.update(taskId, { title: 'Stale generic title' });

    await gate.entered;
    const closed = await lifecycle.close({
      taskId,
      expectedRevision: 1,
      closure: {
        state: 'satisfied',
        condition: 'The result is reviewable',
        expectedSignal: 'artifact:final',
        evidenceRefs: ['artifact:final:v2'],
      },
    });
    gate.release();

    await assert.rejects(staleUpdate, (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED');
    const canonical = await store.get(taskId);
    assert.equal(closed.status, 'done');
    assert.equal(canonical.status, 'done');
    assert.equal(canonical.title, 'Prepare the canonical result');
    assert.equal(canonical.entrustedWork.revision, 2);
    assert.equal(canonical.entrustedWork.closure.state, 'satisfied');
    assert.deepEqual(canonical.entrustedWork.closure.evidenceRefs, ['artifact:final:v2']);
  });

  test('rejected conditional generic update clears WATCH before the next transaction', async () => {
    const store = new RedisTaskStore(redis);
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admitted.ownerRef.replace('task:item:', '');

    await assertRejectedWatchDoesNotLeak(
      redis,
      taskId,
      () => store.updateIfThreadId(taskId, 'thread-source', { title: 'Rejected generic title' }),
      'conditional-update',
    );
  });

  test('rejected automation replacement clears WATCH before the next transaction', async () => {
    const store = new RedisTaskStore(redis);
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admitted.ownerRef.replace('task:item:', '');

    await assertRejectedWatchDoesNotLeak(
      redis,
      taskId,
      () =>
        store.replaceAutomationStateIfGeneration(taskId, {
          expectedGeneration: null,
          automationState: undefined,
          status: 'done',
        }),
      'automation-replacement',
    );
  });

  test('conditional-update rejection cannot clear a concurrent WATCH', async () => {
    await assertRejectedCleanupCannotClearConcurrentWatch({
      redis,
      RedisTaskStore,
      EntrustedWorkLifecycleService,
      rejectMutation: (store, taskId) =>
        store.updateIfThreadId(taskId, 'thread-source', { title: 'Rejected entrusted update A' }),
      rejectionMatcher: (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    });
  });

  test('automation-replacement rejection cannot clear a concurrent WATCH', async () => {
    await assertRejectedCleanupCannotClearConcurrentWatch({
      redis,
      RedisTaskStore,
      EntrustedWorkLifecycleService,
      rejectMutation: (store, taskId) =>
        store.replaceAutomationStateIfGeneration(taskId, {
          expectedGeneration: null,
          automationState: undefined,
          status: 'done',
        }),
      rejectionMatcher: (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    });
  });

  test('automation-patch serialization rejection cannot clear a concurrent WATCH', async () => {
    await assertRejectedCleanupCannotClearConcurrentWatch({
      redis,
      RedisTaskStore,
      EntrustedWorkLifecycleService,
      rejectMutation: (store, taskId) =>
        store.patchAutomationState(taskId, {
          ci: { lastFingerprint: BigInt(1) },
        }),
      rejectionMatcher: (error) => error instanceof TypeError,
    });
  });
  test('public create cannot consume a conditional-update WATCH session', async () => {
    await assertForeignTransactionCannotConsumeWatch({
      redis,
      RedisTaskStore,
      watchedMutation: (store, taskId) =>
        store.updateIfThreadId(taskId, 'thread-b', {
          title: 'Stale update B',
        }),
      assertMutationApplied: (_canonical, mutationResult) => {
        assert.equal(mutationResult, null);
      },
    });
  });

  test('public create cannot consume an automation-replacement WATCH session', async () => {
    await assertForeignTransactionCannotConsumeWatch({
      redis,
      RedisTaskStore,
      watchedMutation: (store, taskId) =>
        store.replaceAutomationStateIfGeneration(taskId, {
          expectedGeneration: null,
          automationState: {
            ci: {
              lastFingerprint: 'replacement-applied',
            },
          },
        }),
      assertMutationApplied: (canonical) => {
        assert.equal(canonical?.automationState?.ci?.lastFingerprint, 'replacement-applied');
      },
    });
  });

  test('public create cannot consume an automation-patch WATCH session', async () => {
    await assertForeignTransactionCannotConsumeWatch({
      redis,
      RedisTaskStore,
      watchedMutation: (store, taskId) =>
        store.patchAutomationState(taskId, {
          ci: {
            lastFingerprint: 'patch-applied',
          },
        }),
      assertMutationApplied: (canonical) => {
        assert.equal(canonical?.automationState?.ci?.lastFingerprint, 'patch-applied');
      },
    });
  });
});
