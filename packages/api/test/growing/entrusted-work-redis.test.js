import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const now = 1_788_171_000_000;

function command() {
  return {
    task: {
      threadId: 'thread-f310-redis',
      title: 'Prepare real presentation',
      why: 'Accepted source offer',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner-redis',
    },
    admission: {
      basis: 'accepted_offer',
      sourceRefs: ['message:redis-source'],
      offerId: 'custody-offer:redis-source',
      sourceMessageRevision: `sha256:${'a'.repeat(64)}`,
      intendedOutcome: 'A reviewable presentation is ready',
      idempotencyKey: 'entrusted:redis-source',
    },
    closure: {
      condition: 'The final presentation is reviewable',
      expectedSignal: 'artifact:final-presentation',
    },
  };
}

describe('F310 entrusted-work Redis Task owner actions', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let RedisTaskStore;
  let EntrustedWorkLifecycleService;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F310 entrusted-work Redis Task owner actions');
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

  test('concurrent replay creates one Task and persists the contract in the existing Task hash', async () => {
    const left = new EntrustedWorkLifecycleService(new RedisTaskStore(redis), { now: () => now });
    const right = new EntrustedWorkLifecycleService(new RedisTaskStore(redis), { now: () => now });

    const [first, second] = await Promise.all([left.admitOrResume(command()), right.admitOrResume(command())]);
    const results = [first.result, second.result].sort();
    assert.deepEqual(results, ['admitted', 'resumed']);
    assert.equal(first.subjectRef, second.subjectRef);
    assert.equal(first.ownerRef, second.ownerRef);

    const taskId = first.ownerRef.replace('task:item:', '');
    const raw = await redis.hgetall(`task:${taskId}`);
    const stored = JSON.parse(raw.entrustedWork);
    assert.equal(stored.revision, 1);
    assert.equal(stored.admission.idempotencyKey, command().admission.idempotencyKey);
    assert.equal(raw.kind, 'work');
    assert.equal(await redis.ttl(`task:${taskId}`), -1, 'entrusted work must never age out before typed closure');
    assert.equal(
      await redis.ttl('tasks:thread:thread-f310-redis'),
      -1,
      'an entrusted-work thread index must remain durable',
    );
    assert.equal(
      JSON.stringify(stored).match(/eligib|salience|recommendation|actionRef/),
      null,
      'Task contract must not mirror producer judgment or action',
    );
  });

  test('closure is revision-fenced and writes status plus terminal contract atomically', async () => {
    const store = new RedisTaskStore(redis);
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(command());
    const taskId = admitted.ownerRef.replace('task:item:', '');

    const [left, right] = await Promise.allSettled([
      lifecycle.close({
        taskId,
        expectedRevision: 1,
        closure: {
          state: 'satisfied',
          condition: 'The final presentation is reviewable',
          expectedSignal: 'artifact:final-presentation',
          evidenceRefs: ['artifact:presentation:v4'],
        },
      }),
      lifecycle.close({
        taskId,
        expectedRevision: 1,
        closure: {
          state: 'cancelled',
          condition: 'The final presentation is reviewable',
          expectedSignal: 'artifact:final-presentation',
          evidenceRefs: [],
          disposition: {
            kind: 'cancelled',
            actorKind: 'human',
            actorRef: 'user:owner-redis',
            authorityRef: 'thread:thread-f310-redis',
            dispositionRef: 'message:cancel',
            disposedAt: now + 1,
          },
        },
      }),
    ]);
    assert.equal([left, right].filter((result) => result.status === 'fulfilled').length, 1);

    const stored = await store.get(taskId);
    assert.equal(stored.status, 'done');
    assert.equal(stored.entrustedWork.revision, 2);
    assert.ok(['satisfied', 'cancelled'].includes(stored.entrustedWork.closure.state));
    await assert.rejects(
      store.update(taskId, { status: 'done' }),
      (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    );
  });

  test('concurrent typed updates have one winner and persist one matched Artifact/time tuple', async () => {
    const store = new RedisTaskStore(redis);
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(command());
    const taskId = admitted.ownerRef.replace('task:item:', '');
    const candidates = [
      {
        taskId,
        expectedRevision: 1,
        time: { businessDeadline: { value: now + 10_000, sourceRef: 'message:left' } },
        artifactRefs: ['artifact:ppt:left'],
      },
      {
        taskId,
        expectedRevision: 1,
        time: { reviewBy: { value: now + 20_000, sourceRef: 'message:right' } },
        artifactRefs: ['artifact:ppt:right'],
      },
    ];

    const results = await Promise.allSettled(candidates.map((candidate) => lifecycle.update(candidate)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason?.code, 'ENTRUSTED_WORK_REVISION_CONFLICT');

    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    const winner = candidates[winnerIndex];
    const stored = await store.get(taskId);
    assert.equal(stored.entrustedWork.revision, 2);
    assert.deepEqual(stored.entrustedWork.artifactRefs, winner.artifactRefs);
    assert.deepEqual(stored.entrustedWork.time, winner.time);
  });

  test('generic Redis deletion paths preserve entrusted-work history and subject idempotency', async () => {
    const store = new RedisTaskStore(redis);
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(command());
    const taskId = admitted.ownerRef.replace('task:item:', '');

    await assert.rejects(
      store.update(taskId, { ownerCatId: 'codex-terra' }),
      (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    );
    await assert.rejects(
      store.update(taskId, { threadId: 'thread-detached' }),
      (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    );
    await assert.rejects(store.delete(taskId), (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED');
    await assert.rejects(
      store.deleteByThread('thread-f310-redis'),
      (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
    );
    const canonical = await store.get(taskId);
    for (const mutation of [
      { threadId: canonical.threadId, ownerCatId: 'codex-terra' },
      { threadId: 'thread-detached', ownerCatId: canonical.ownerCatId },
    ]) {
      await assert.rejects(
        store.upsertBySubject({
          subjectKey: canonical.subjectKey,
          threadId: mutation.threadId,
          ownerCatId: mutation.ownerCatId,
          title: 'Generic subject upsert must not move custody',
          why: 'Attempted lifecycle bypass',
          createdBy: 'codex-sol',
          userId: 'owner-redis',
        }),
        (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED',
      );
      const stored = await store.get(taskId);
      assert.equal(stored.threadId, 'thread-f310-redis');
      assert.equal(stored.ownerCatId, 'codex-sol');
      assert.equal(stored.entrustedWork.revision, 1);
    }
    const replay = await lifecycle.admitOrResume(command());
    assert.equal(replay.result, 'resumed');
    assert.equal(replay.ownerRef, admitted.ownerRef);
  });
});
