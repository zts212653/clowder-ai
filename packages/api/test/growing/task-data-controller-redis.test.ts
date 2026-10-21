import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Redis from 'ioredis';
import '../helpers/setup-cat-registry.js';
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
  assertRedisIsolationOrThrow(url, 'task-data-controller');
  if (!url) throw new Error('task-data-controller Redis URL is unavailable');
  redis = new Redis(url, { keyPrefix: `f322-task-data-controller:${randomUUID()}:` });
  await redis.ping();
});

after(async () => {
  if (!redis) return;
  await cleanupClientKeyspace(redis);
  await redis.quit();
});

const owner = {
  userId: 'owner',
  catId: 'codex-sol',
  threadId: 'thread-private',
  subjectKey: 'entrusted:redis-legacy',
  firstSourceRef: 'message:collective-source',
  admissionAuthorityRef: 'message:host-admission',
};
const baseController = {
  pluginId: 'official.collective-connector',
  pluginInstanceId: 'pi-current',
  moduleRef: 'plugin:official.collective-connector',
  lifecycleRevision: 8,
  grantRevision: 3,
};

async function fixture() {
  const store = new RedisTaskStore(redis, { ttlSeconds: 60 });
  const expected = { ...owner, subjectKey: `${owner.subjectKey}:${randomUUID()}` };
  const admitted = (
    await store.admitEntrustedWork({
      subjectKey: expected.subjectKey,
      task: {
        threadId: owner.threadId,
        userId: owner.userId,
        ownerCatId: owner.catId,
        createdBy: 'user',
        title: 'Original Collective work',
        why: 'Keep original history',
      },
      entrustedWork: {
        revision: 1,
        admission: {
          basis: 'authorized_source',
          sourceRefs: [owner.firstSourceRef],
          idempotencyKey: 'original-admission',
          receiptRef: 'task:receipt:original-admission',
          admittedAt: 100,
          authorityRef: owner.admissionAuthorityRef,
        },
        intendedOutcome: 'Continue original Work',
        time: {},
        artifactRefs: ['artifact:original'],
        closure: {
          state: 'open',
          condition: 'Owner accepts',
          expectedSignal: 'accepted',
          evidenceRefs: [],
        },
      },
    })
  ).task;
  return { store, admitted, expected };
}

function bind(taskId: string, operationId: string, pluginInstanceId: string, expected = owner) {
  return {
    action: 'bind' as const,
    taskId,
    expectedTaskRevision: 1,
    operationId,
    expected,
    controller: { ...baseController, pluginInstanceId },
    ownerOperation: {
      actorRef: `user:${owner.userId}`,
      operationKey: 'work',
      actionId: 'adopt',
      requestId: `request:${operationId}`,
      confirmedAt: 1_792_573_400_000,
    },
  };
}

test('concurrent Redis binds have one winner and the durable Task and receipt survive restart', { skip }, async () => {
  const { store, admitted, expected } = await fixture();
  const results = await Promise.all([
    store.transitionEntrustedTaskDataController(bind(admitted.id, 'bind-a', 'pi-a', expected)),
    store.transitionEntrustedTaskDataController(bind(admitted.id, 'bind-b', 'pi-b', expected)),
  ]);
  assert.equal(results.filter((result) => result.kind === 'bound').length, 1, JSON.stringify(results));
  assert.equal(
    results.filter((result) => ['controller_conflict', 'revision_conflict'].includes(result.kind)).length,
    1,
  );

  const winner = results.find((result) => result.kind === 'bound');
  assert.ok(winner && 'receipt' in winner);
  const reopened = new RedisTaskStore(redis, { ttlSeconds: 60 });
  const persisted = await reopened.get(admitted.id);
  assert.equal(persisted?.entrustedWork?.dataController?.state, 'active');
  assert.equal(persisted?.entrustedWork?.dataController?.binding.ownerOperationReceiptRef, winner.receipt.receiptRef);
  assert.deepEqual(persisted?.entrustedWork?.dataController?.receipts, [winner.receipt]);
  assert.equal(await redis.ttl(`task:${admitted.id}`), -1, 'entrusted Task and controller receipts are permanent');
});

test('Redis replay, conflicts, revoke, and restart all preserve rejected zero-write snapshots', { skip }, async () => {
  const { store, admitted, expected } = await fixture();
  const first = await store.transitionEntrustedTaskDataController(
    bind(admitted.id, 'bind-original', 'pi-current', expected),
  );
  assert.equal(first.kind, 'bound');

  const beforeReplay = await redis.hgetall(`task:${admitted.id}`);
  const replay = await new RedisTaskStore(redis).transitionEntrustedTaskDataController({
    ...bind(admitted.id, 'bind-original', 'pi-current', expected),
    ownerOperation: {
      ...bind(admitted.id, 'bind-original', 'pi-current', expected).ownerOperation,
      requestId: 'request:retry',
    },
  });
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(await redis.hgetall(`task:${admitted.id}`), beforeReplay);

  for (const rejected of [
    { ...bind(admitted.id, 'bind-stale', 'pi-current', expected) },
    {
      ...bind(admitted.id, 'bind-foreign', 'pi-foreign', expected),
      expectedTaskRevision: 2,
      controller: {
        ...baseController,
        pluginId: 'foreign.plugin',
        pluginInstanceId: 'pi-foreign',
        moduleRef: 'plugin:foreign.plugin',
      },
    },
  ]) {
    const before = await redis.hgetall(`task:${admitted.id}`);
    const result = await store.transitionEntrustedTaskDataController(rejected);
    assert.ok(['revision_conflict', 'controller_conflict'].includes(result.kind));
    assert.deepEqual(await redis.hgetall(`task:${admitted.id}`), before);
  }

  const revoked = await store.transitionEntrustedTaskDataController({
    action: 'revoke',
    taskId: admitted.id,
    expectedTaskRevision: 2,
    expectedBindingRevision: 1,
    expectedControllerReceiptRef: first.receipt.receiptRef,
    controller: baseController,
    operationId: 'revoke-original',
    ownerOperation: {
      actorRef: `user:${owner.userId}`,
      operationKey: 'work',
      actionId: 'revoke',
      requestId: 'request:revoke',
      confirmedAt: 1_792_573_500_000,
    },
  });
  assert.equal(revoked.kind, 'revoked');
  const restarted = await new RedisTaskStore(redis).get(admitted.id);
  assert.equal(restarted?.entrustedWork?.dataController?.state, 'revoked');
  assert.equal(restarted?.entrustedWork?.dataController?.receipts.length, 2);
});

test('Redis checks the carrier fence at controller and entrusted-work CAS boundaries', { skip }, async () => {
  const rejectedBind = await fixture();
  const bindBefore = await redis.hgetall(`task:${rejectedBind.admitted.id}`);
  await assert.rejects(
    rejectedBind.store.transitionEntrustedTaskDataController(
      bind(rejectedBind.admitted.id, 'bind-expired', 'pi-current', rejectedBind.expected),
      { assertCurrent: async () => Promise.reject(new Error('owner operation expired')) },
    ),
    /expired/,
  );
  assert.deepEqual(await redis.hgetall(`task:${rejectedBind.admitted.id}`), bindBefore);

  const { store, admitted, expected } = await fixture();
  const bound = await store.transitionEntrustedTaskDataController(
    bind(admitted.id, 'bind-current', 'pi-current', expected),
  );
  assert.equal(bound.kind, 'bound');
  assert.ok('receipt' in bound);
  const expiredFence = { assertCurrent: async () => Promise.reject(new Error('carrier expired')) };
  const before = await redis.hgetall(`task:${admitted.id}`);
  await assert.rejects(
    store.transitionEntrustedTaskDataController(
      {
        action: 'revoke',
        taskId: admitted.id,
        expectedTaskRevision: 2,
        expectedBindingRevision: 1,
        expectedControllerReceiptRef: bound.receipt.receiptRef,
        controller: baseController,
        operationId: 'revoke-expired',
        ownerOperation: {
          actorRef: `user:${owner.userId}`,
          operationKey: 'work',
          actionId: 'revoke',
          requestId: 'request:revoke-expired',
          confirmedAt: 1_792_573_600_000,
        },
      },
      expiredFence,
    ),
    /expired/,
  );
  assert.deepEqual(await redis.hgetall(`task:${admitted.id}`), before);
  await assert.rejects(
    store.updateEntrustedWork(admitted.id, { expectedRevision: 2, status: 'doing' }, expiredFence),
    /expired/,
  );
  assert.deepEqual(await redis.hgetall(`task:${admitted.id}`), before);
});
