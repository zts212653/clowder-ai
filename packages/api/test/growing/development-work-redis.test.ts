import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Redis from 'ioredis';
import '../helpers/setup-cat-registry.js';
import {
  developmentScopeKey,
  developmentTaskSnapshot,
} from '../../src/domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import { RedisTaskStore } from '../../src/domains/cats/services/stores/redis/RedisTaskStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const url = process.env.REDIS_URL;
const skip = redisIsolationSkipReason(url);
let redis: Redis;
before(async () => {
  if (skip) return;
  assertRedisIsolationOrThrow(url, 'development-work');
  redis = new Redis(url!, { keyPrefix: `f310-development:${randomUUID()}:` });
  await redis.ping();
});
after(async () => {
  if (redis) {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  }
});
const actor = { userId: 'user-a', threadId: 'thread-a', catId: 'codex-sol' };
function command(unit: string) {
  return {
    action: 'admit' as const,
    actor,
    scope: {
      featureRef: 'feature:F310',
      phaseKey: 'B',
      workUnitRef: `file:docs/plans/plan.md#${unit}`,
      acceptedSourceRef: 'file:docs/plans/plan.md',
      acceptedRevision: 'a'.repeat(40),
    },
    sourceRef: `message:${unit}`,
    sourceRevision: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: unit,
    title: unit,
    why: 'Accepted development',
    contract: {
      revision: 1,
      admission: {
        basis: 'explicit_entrustment' as const,
        sourceRefs: [`message:${unit}`],
        idempotencyKey: unit,
        receiptRef: `task:receipt:${unit}`,
        admittedAt: 1,
      },
      intendedOutcome: unit,
      time: {},
      artifactRefs: [],
      closure: { condition: 'Accepted', expectedSignal: 'accepted', state: 'open' as const, evidenceRefs: [] },
    },
  };
}

test('concurrent admissions create one scope; source receipts survive a fresh store', { skip }, async () => {
  const store = new RedisTaskStore(redis);
  const input = command('concurrent');
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      store.transitionDevelopmentWork({
        ...input,
        idempotencyKey: `${input.idempotencyKey}-${i}`,
        sourceRef: `message:concurrent-${i}`,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.result === 'admitted').length, 1);
  assert.equal(results.filter((r) => r.result === 'resume_required').length, 5);
  const first = results.find((r) => r.result === 'admitted')!;
  assert.ok('task' in first);
  const resume = {
    ...input,
    action: 'resume' as const,
    taskId: first.task.id,
    expectedRevision: 1,
    idempotencyKey: 'continue-concurrent',
    sourceRef: 'message:continue-concurrent',
  };
  const resumed = await store.transitionDevelopmentWork(resume);
  const replay = await new RedisTaskStore(redis).transitionDevelopmentWork(resume);
  assert.deepEqual(replay, resumed);
  const fresh = new RedisTaskStore(redis);
  const sourceQuery = {
    actor,
    taskId: first.task.id,
    sourceRef: resume.sourceRef,
    sourceRevision: resume.sourceRevision,
  };
  assert.equal(await fresh.hasDevelopmentSource(sourceQuery), true);
  assert.equal(await fresh.hasDevelopmentSource({ ...sourceQuery, sourceRef: 'message:unrelated' }), false);
  assert.equal(await fresh.hasDevelopmentSource({ ...sourceQuery, sourceRevision: `sha256:${'c'.repeat(64)}` }), false);
  for (const foreign of [
    { ...actor, userId: 'other' },
    { ...actor, threadId: 'elsewhere' },
    { ...actor, catId: 'opus' },
  ]) {
    assert.equal(await fresh.hasDevelopmentSource({ ...sourceQuery, actor: foreign }), false);
  }
  assert.equal(await redis.ttl(`task:${first.task.id}`), -1);
});

test('missing scope index rebuilds from Task and close retires only the open index', { skip }, async () => {
  const store = new RedisTaskStore(redis);
  const input = command('rebuild');
  const first = await store.transitionDevelopmentWork(input);
  assert.ok('task' in first);
  const key = `tasks:development-scope:${developmentScopeKey(actor.userId, input.scope)}`;
  await redis.del(key);
  const matches = await new RedisTaskStore(redis).findDevelopmentWork(actor.userId, input.scope);
  assert.equal(matches[0].id, first.task.id);
  assert.equal(await redis.get(key), first.task.id);
  await store.closeEntrustedWork(first.task.id, {
    expectedRevision: 1,
    closure: { ...input.contract.closure, state: 'satisfied', evidenceRefs: ['artifact:real'] },
  });
  assert.equal(await redis.get(key), null);
  assert.equal((await store.transitionDevelopmentWork(input)).result, 'scope_closed');
  assert.ok(await store.get(first.task.id));
});

test('scoped work history and shared thread index stay durable under an expiring generic store', { skip }, async () => {
  const store = new RedisTaskStore(redis, { ttlSeconds: 60 });
  const input = command('durable-history');
  const first = await store.transitionDevelopmentWork(input);
  assert.ok('task' in first);
  await store.closeEntrustedWork(first.task.id, {
    expectedRevision: 1,
    closure: { ...input.contract.closure, state: 'satisfied', evidenceRefs: ['artifact:real'] },
  });
  assert.equal(await redis.ttl(`task:${first.task.id}`), -1);
  await store.create({
    threadId: actor.threadId,
    userId: actor.userId,
    createdBy: 'user',
    title: 'Generic expiring work',
    why: '',
  });
  assert.equal(await redis.ttl(`tasks:thread:${actor.threadId}`), -1);
});

for (const mutation of ['update', 'upsert', 'delete', 'deleteByThread'] as const) {
  test(`generic ${mutation} paused across adoption cannot overwrite or erase the adopted owner`, { skip }, async () => {
    const store = new RedisTaskStore(redis);
    const raceActor = { ...actor, threadId: `race-${mutation}` };
    const old = await store.create({
      threadId: raceActor.threadId,
      userId: actor.userId,
      ownerCatId: 'codex-sol',
      createdBy: 'user',
      title: 'Legacy race',
      why: 'Original',
      subjectKey: `legacy:race-${mutation}`,
    });
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    let didPause = false;
    const pause = async <T>(snapshot: T): Promise<T> => {
      if (!didPause) {
        didPause = true;
        entered();
        await unblock;
      }
      return snapshot;
    };
    const wrap = (connection: Redis): Redis =>
      new Proxy(connection, {
        get(target, property) {
          if (property === 'duplicate') return () => wrap(target.duplicate());
          if (property === 'hgetall')
            return async (...args: Parameters<typeof redis.hgetall>) => {
              return pause(await target.hgetall(...args));
            };
          if (property === 'multi')
            return () => {
              const tx = target.multi();
              let hasRead = false;
              return new Proxy(tx, {
                get(pipeline, name) {
                  if (name === 'hgetall')
                    return (...args: Parameters<typeof tx.hgetall>) => {
                      hasRead = true;
                      return pipeline.hgetall(...args);
                    };
                  if (name === 'exec')
                    return async () => {
                      const result = await pipeline.exec();
                      return hasRead ? pause(result) : result;
                    };
                  const value = Reflect.get(pipeline, name);
                  return typeof value === 'function' ? value.bind(pipeline) : value;
                },
              });
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const client = wrap(redis);
    // Freeze the legacy snapshot while the separate owner atomically adopts it.
    const racingStore = new RedisTaskStore(client);
    const pending =
      mutation === 'update'
        ? racingStore.update(old.id, { why: 'Stale generic writer' })
        : mutation === 'upsert'
          ? racingStore.upsertBySubject({
              threadId: raceActor.threadId,
              userId: actor.userId,
              ownerCatId: 'codex-sol',
              createdBy: 'user',
              title: 'Overwrite',
              why: '',
              subjectKey: old.subjectKey!,
            })
          : mutation === 'delete'
            ? racingStore.delete(old.id)
            : racingStore.deleteByThread(raceActor.threadId);
    await paused;
    try {
      const adopted = await store.transitionDevelopmentWork({
        ...command(`adopt-race-${mutation}`),
        actor: raceActor,
        action: 'adopt',
        taskId: old.id,
        expectedSnapshot: developmentTaskSnapshot(old),
      });
      assert.equal(adopted.result, 'adopted');
      release();
      await assert.rejects(pending);
    } finally {
      release();
      await pending.catch(() => undefined);
    }
  });
}
