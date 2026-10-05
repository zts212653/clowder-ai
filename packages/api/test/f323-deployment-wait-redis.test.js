import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { readRedisTypedWaitCustodyGuards } from '../dist/domains/cats/services/stores/redis/RedisTypedWaitCustodyGuard.js';
import { TaskKeys } from '../dist/domains/cats/services/stores/redis-keys/task-keys.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

describe('F323 deployment wait Redis aggregate', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  test('persists the work wait and private receipt without TTL, with one CAS winner', async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f323-deployment-wait');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f323-wait-${randomUUID()}:` });
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    });
    const store = new RedisTaskStore(redis, { ttlSeconds: 1 });
    const task = await store.create({
      kind: 'work',
      threadId: 'thread-f323',
      title: 'Verify activation',
      ownerCatId: 'codex-sol',
      why: 'wait for runtime',
      createdBy: 'codex-sol',
      userId: 'user-1',
    });
    const makeActive = (generation, revision) => ({
      v: 1,
      generation,
      subjectRef: 'deployment:abc123def456:runtime',
      ownerFence: { kind: 'containing_task', generation },
      baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
      continuation: {
        when: [{ kind: 'revision_included', revision, services: ['api'] }],
        // biome-ignore lint/suspicious/noThenProperty: F280 continuation contract field.
        then: 'verify',
      },
      autoRenew: false,
      createdAt: 100,
    });
    const first = makeActive(1, 'a'.repeat(40));
    const receipt = createTypedWaitRegistration({
      task,
      active: first,
      invocationId: 'inv-1',
      source: { kind: 'primary', sourceMessageId: 'msg-1' },
    });
    const installed = await store.replaceDeploymentWaitIfGeneration(task.id, {
      expectedGeneration: null,
      expectedDeploymentWait: task.deploymentWait,
      expectedUpdatedAt: task.updatedAt,
      deploymentWait: { await: first },
      waitRegistration: receipt,
      status: 'blocked',
    });
    assert.ok(installed);
    assert.equal(await redis.ttl(TaskKeys.detail(task.id)), -1, 'active deployment waits override opt-in task TTL');
    assert.deepEqual((await new RedisTaskStore(redis).getWaitRegistration(task.id)).receipt, receipt);
    const guard = {
      reference: { taskId: task.id, generation: 1 },
      identity: {
        invocationId: 'inv-1',
        userId: 'user-1',
        catId: 'codex-sol',
        threadId: 'thread-f323',
        sourceMessageId: 'msg-1',
      },
    };
    const proof = await readRedisTypedWaitCustodyGuards(redis, [guard]);
    assert.equal(proof.witnesses[0].stateField, 'deploymentWait');
    assert.equal(proof.witnesses[0].expiresAt, undefined, 'persistent waits omit the optional deadline');

    const matched = await store.replaceDeploymentWaitIfGeneration(task.id, {
      expectedGeneration: 1,
      expectedDeploymentWait: installed.deploymentWait,
      expectedUpdatedAt: installed.updatedAt,
      deploymentWait: {
        waitOutcome: {
          v: 1,
          domain: 'deployment',
          outcomeId: 'wait:deployment:abc123def456:runtime:g1:matched',
          generation: 1,
          subjectRef: 'deployment:abc123def456:runtime',
          ownerFence: { kind: 'containing_task', generation: 1 },
          reason: 'matched',
          at: 200,
          delivery: 'delivered',
          nextStep: 'verify',
        },
      },
      status: 'blocked',
    });
    assert.ok(matched);
    assert.equal(await redis.ttl(TaskKeys.detail(task.id)), -1, 'deployment outcome history remains durable');
    assert.deepEqual((await new RedisTaskStore(redis).getWaitRegistration(task.id)).receipt, receipt);
    await assert.rejects(readRedisTypedWaitCustodyGuards(redis, [guard]), /typed wait/);

    const current = await store.get(task.id);
    const candidates = ['b', 'c'].map((digit) => {
      const active = makeActive(2, digit.repeat(40));
      return {
        expectedGeneration: 1,
        expectedDeploymentWait: current.deploymentWait,
        expectedUpdatedAt: current.updatedAt,
        deploymentWait: { await: active },
        waitRegistration: createTypedWaitRegistration({
          task: current,
          active,
          invocationId: `inv-${digit}`,
          source: { kind: 'primary', sourceMessageId: `msg-${digit}` },
        }),
      };
    });
    const results = await Promise.all(
      candidates.map((candidate) => store.replaceDeploymentWaitIfGeneration(task.id, candidate)),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await store.get(task.id)).deploymentWait.await.generation, 2);

    const completed = await store.update(task.id, { status: 'done' });
    assert.equal(completed.deploymentWait.await, undefined);
    assert.equal(completed.deploymentWait.waitOutcome.reason, 'subject_terminal');
    await store.update(task.id, { status: 'doing' });
    assert.equal((await new RedisTaskStore(redis).get(task.id)).deploymentWait.await, undefined);
  });

  test('entrusted closure atomically consumes an armed deployment wait', async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f323-deployment-close');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f323-close-${randomUUID()}:` });
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    });
    const store = new RedisTaskStore(redis);
    const entrustedWork = {
      revision: 1,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:f323'],
        idempotencyKey: 'f323-close',
        receiptRef: 'task:receipt:f323-close',
        admittedAt: 1,
      },
      intendedOutcome: 'Verify deployment',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'Verified', expectedSignal: 'verified', evidenceRefs: [] },
    };
    const admitted = await store.admitEntrustedWork({
      subjectKey: 'entrusted:f323-close',
      entrustedWork,
      task: {
        threadId: 'thread-f323-close',
        title: 'Verify deployment',
        ownerCatId: 'codex-sol',
        why: 'Wait for activation',
        createdBy: 'codex-sol',
        userId: 'user-1',
      },
    });
    const task = admitted.task;
    const active = {
      v: 1,
      generation: 1,
      subjectRef: 'deployment:abc123def456:runtime',
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
      continuation: {
        when: [{ kind: 'new_ready_boot', services: ['api'] }],
        // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
        then: 'verify',
      },
      autoRenew: false,
      createdAt: 100,
    };
    assert.ok(
      await store.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: null,
        expectedDeploymentWait: task.deploymentWait,
        expectedUpdatedAt: task.updatedAt,
        deploymentWait: { await: active },
      }),
    );
    const closed = await store.closeEntrustedWork(task.id, {
      expectedRevision: 1,
      closure: { ...entrustedWork.closure, state: 'satisfied', evidenceRefs: ['artifact:verified'] },
    });
    assert.equal(closed.kind, 'closed');
    const stored = await new RedisTaskStore(redis).get(task.id);
    assert.equal(stored.status, 'done');
    assert.equal(stored.deploymentWait.await, undefined);
    assert.equal(stored.deploymentWait.waitOutcome.reason, 'subject_terminal');
  });

  test('subject upsert transfers an armed wait without overwriting a concurrent generation', async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f323-subject-upsert');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f323-subject-${randomUUID()}:` });
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    });
    const store = new RedisTaskStore(redis);
    const input = {
      kind: 'work',
      subjectKey: 'f323:runtime-acceptance',
      threadId: 'thread-f323-subject',
      title: 'Verify runtime',
      ownerCatId: 'codex-sol',
      why: 'wait for activation',
      createdBy: 'codex-sol',
      userId: 'user-1',
    };
    const task = await store.create(input);
    const active = {
      v: 1,
      generation: 1,
      subjectRef: 'deployment:abc123def456:runtime',
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
      continuation: {
        when: [{ kind: 'new_ready_boot', services: ['api'] }],
        // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
        then: 'verify',
      },
      autoRenew: false,
      createdAt: 100,
    };
    assert.ok(
      await store.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: null,
        expectedDeploymentWait: task.deploymentWait,
        expectedUpdatedAt: task.updatedAt,
        deploymentWait: { await: active },
      }),
    );
    const moved = await store.upsertBySubject({ ...input, ownerCatId: 'kimi' });
    assert.equal(moved.id, task.id);
    assert.equal(moved.deploymentWait.await, undefined);
    assert.equal(moved.deploymentWait.waitOutcome.reason, 'owner_changed');
    assert.equal((await new RedisTaskStore(redis).get(task.id)).deploymentWait.waitOutcome.reason, 'owner_changed');
  });
  test('same-millisecond Redis CAS cannot revive a cancelled wait from a stale snapshot', async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f323-deployment-wait-same-ms');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f323-cas-${randomUUID()}:` });
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    });
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      const store = new RedisTaskStore(redis);
      const task = await store.create({
        kind: 'work',
        threadId: 'thread-cas',
        title: 'Verify',
        ownerCatId: 'codex-sol',
        why: 'wait for activation',
        createdBy: 'codex-sol',
        userId: 'user-1',
      });
      const active = {
        v: 1,
        generation: 1,
        subjectRef: 'deployment:abc123def456:runtime',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
        continuation: {
          when: [{ kind: 'new_ready_boot', services: ['api'] }],
          // biome-ignore lint/suspicious/noThenProperty: F280 continuation contract field.
          then: 'verify',
        },
        autoRenew: false,
        createdAt: 100,
      };
      const snapshot = await store.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: null,
        expectedDeploymentWait: task.deploymentWait,
        deploymentWait: { await: active },
      });
      assert.ok(snapshot);
      const lifecycle = new DeploymentWaitLifecycleService({
        taskStore: store,
        deliveryDeps: {},
        log: { info() {}, warn() {}, error() {} },
        currentObservation: async () => null,
      });
      await lifecycle.cancel(task.id, { kind: 'user', userId: 'user-1' });
      const stale = await store.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: 1,
        expectedUpdatedAt: snapshot.updatedAt,
        expectedDeploymentWait: snapshot.deploymentWait,
        deploymentWait: {
          waitOutcome: {
            v: 1,
            domain: 'deployment',
            outcomeId: 'stale-match',
            generation: 1,
            subjectRef: active.subjectRef,
            ownerFence: active.ownerFence,
            reason: 'matched',
            at: 1_000,
            delivery: 'pending',
          },
        },
      });
      assert.equal(stale, null);
      assert.equal((await store.get(task.id)).deploymentWait.waitOutcome.reason, 'user_cancel');
    } finally {
      Date.now = originalNow;
    }
  });
});
