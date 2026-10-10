import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import {
  createTypedWaitRegistration,
  isLiveTypedWaitRegistration,
} from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { TaskKeys } from '../dist/domains/cats/services/stores/redis-keys/task-keys.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('a2a-deployment-task');

describe('F323 deployment wait Redis aggregate', () => {
  for (const race of ['owner', 'generation']) {
    test(`canonical Redis WATCH rejects ${race} drift after the Task snapshot read`, async (t) => {
      const redis = fixture.client(`f323-watch-${randomUUID()}:`);
      t.after(() => redis.quit());
      const store = new RedisTaskStore(redis);
      const task = await store.create({
        kind: 'work',
        threadId: 'thread-watch',
        title: 'Verify',
        ownerCatId: 'codex-sol',
        why: 'wait for runtime',
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
          // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
          then: 'verify',
        },
        autoRenew: false,
        createdAt: 100,
      };
      const receipt = createTypedWaitRegistration({
        task,
        active,
        invocationId: 'child-1',
        source: { kind: 'primary', sourceMessageId: 'source-1' },
      });
      const installed = await store.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: null,
        expectedDeploymentWait: task.deploymentWait,
        deploymentWait: { await: active },
        waitRegistration: receipt,
      });
      assert.ok(installed);
      const identity = {
        userId: 'user-1',
        catId: 'codex-sol',
        threadId: task.threadId,
        invocationId: 'child-1',
        sourceMessageId: 'source-1',
      };
      assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'bypass');
      const duplicate = redis.duplicate.bind(redis);
      let injected = false;
      let winningRaw;
      redis.duplicate = (...args) => {
        const session = duplicate(...args);
        const read = session.hgetall.bind(session);
        session.hgetall = async (key) => {
          const stale = await read(key);
          if (!injected && key === TaskKeys.detail(task.id)) {
            injected = true;
            if (race === 'owner') await new RedisTaskStore(redis).update(task.id, { ownerCatId: 'kimi' });
            else
              assert.ok(
                await new RedisTaskStore(redis).replaceDeploymentWaitIfGeneration(task.id, {
                  expectedGeneration: 1,
                  expectedDeploymentWait: installed.deploymentWait,
                  expectedUpdatedAt: installed.updatedAt,
                  deploymentWait: {
                    await: { ...active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } },
                  },
                }),
              );
            winningRaw = await redis.hgetall(key);
          }
          return stale;
        };
        return session;
      };
      const result = await store.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: installed.deploymentWait,
        expectedUpdatedAt: installed.updatedAt,
        deploymentWait: { await: { ...active, generation: 3, ownerFence: { kind: 'containing_task', generation: 3 } } },
      });
      assert.equal(injected, true, 'race occurs on the actual WATCH session after its read, not via sleep');
      assert.equal(result, null, 'stale contender cannot overwrite the winning Task aggregate');
      assert.deepEqual(await redis.hgetall(TaskKeys.detail(task.id)), winningRaw);
      assert.equal(
        (await resolveTypedWaitContinuation({ taskStore: new RedisTaskStore(redis), ...identity })).kind,
        'reject',
      );
    });
  }

  test('persists the work wait and private receipt without TTL, with one CAS winner', async (t) => {
    const redis = fixture.client(`f323-wait-${randomUUID()}:`);
    t.after(async () => {
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
    const cold = new RedisTaskStore(redis);
    const snapshot = await cold.getWaitRegistration(task.id);
    assert.equal(isLiveTypedWaitRegistration(snapshot, guard.identity, Date.now(), guard.reference), true);
    assert.equal(snapshot.receipt.expiresAt, undefined, 'persistent waits omit the optional deadline');
    assert.deepEqual(await resolveTypedWaitContinuation({ taskStore: cold, ...guard.identity }), {
      kind: 'bypass',
      reference: guard.reference,
    });
    const rawBefore = await redis.hgetall(TaskKeys.detail(task.id));
    for (const override of [
      { invocationId: 'parent-not-child' },
      { sourceMessageId: 'sibling-message' },
      { userId: 'other-user' },
      { catId: 'kimi' },
      { threadId: 'other-thread' },
    ]) {
      assert.equal(
        (await resolveTypedWaitContinuation({ taskStore: cold, ...guard.identity, ...override })).kind,
        'reject',
      );
      assert.deepEqual(
        await redis.hgetall(TaskKeys.detail(task.id)),
        rawBefore,
        'reject is a private read, not a Queue/Task writer',
      );
    }

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
    assert.equal(
      isLiveTypedWaitRegistration(await cold.getWaitRegistration(task.id), guard.identity, Date.now(), guard.reference),
      false,
    );
    assert.deepEqual(await resolveTypedWaitContinuation({ taskStore: cold, ...guard.identity }), {
      kind: 'reject',
      reason: 'no_candidate',
    });

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
    const winning = candidates[results.findIndex(Boolean)];
    const winningReceipt = (await cold.getWaitRegistration(task.id)).receipt;
    assert.deepEqual(
      winningReceipt,
      winning.waitRegistration,
      'winner stores its own private receipt, never the losing candidate',
    );
    assert.deepEqual(await resolveTypedWaitContinuation({ taskStore: cold, ...guard.identity }), {
      kind: 'reject',
      reason: 'no_candidate',
    });
    assert.equal(
      (
        await resolveTypedWaitContinuation({
          taskStore: cold,
          ...guard.identity,
          invocationId: winningReceipt.invocationId,
          sourceMessageId: winningReceipt.source.sourceMessageId,
        })
      ).kind,
      'bypass',
    );

    const completed = await store.update(task.id, { status: 'done' });
    assert.equal(completed.deploymentWait.await, undefined);
    assert.equal(completed.deploymentWait.waitOutcome.reason, 'subject_terminal');
    await store.update(task.id, { status: 'doing' });
    assert.equal((await new RedisTaskStore(redis).get(task.id)).deploymentWait.await, undefined);
  });

  test('entrusted closure atomically consumes an armed deployment wait', async (t) => {
    const redis = fixture.client(`f323-close-${randomUUID()}:`);
    t.after(async () => {
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
    const redis = fixture.client(`f323-subject-${randomUUID()}:`);
    t.after(async () => {
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
    const redis = fixture.client(`f323-cas-${randomUUID()}:`);
    t.after(async () => {
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
