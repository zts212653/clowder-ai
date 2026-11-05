import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { TaskKeys } from '../dist/domains/cats/services/stores/redis-keys/task-keys.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { createTypedWaitCustodyFixture } from './helpers/typed-wait-custody-fixture.js';

describe('typed wait registration keeps exact private Redis authority', () => {
  const owned = ownedRedisFixture('a2a-typed-registration');
  async function harness(t) {
    const redis = owned.client(`typed-wait-${randomUUID()}:`);
    await redis.ping();
    t.after(async () => {
      await redis.quit();
    });
    const taskStore = new RedisTaskStore(redis);
    const h = await createTypedWaitCustodyFixture({ messageStore: new RedisMessageStore(redis), taskStore });
    const identity = {
      invocationId: 'child-1',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-wait',
      sourceMessageId: h.message.id,
      holdTaskId: 'hold-1',
    };
    return { ...h, redis, identity };
  }

  test('private receipt survives a new store instance and public hydration stays clean', async (t) => {
    const h = await harness(t);
    const cold = new RedisTaskStore(h.redis);
    assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt, h.receipt);
    assert.equal(JSON.stringify(await cold.get(h.task.id)).includes('typedWaitRegistration'), false);
    assert.equal((await resolveTypedWaitContinuation({ taskStore: cold, ...h.identity })).kind, 'bypass');
  });

  for (const sessionHandoff of [
    undefined,
    { proposalId: 'approved-handoff', continuationEntryId: 'private-entry', sourceSessionId: 'sealed-session' },
  ]) {
    test(`authorization and ${sessionHandoff ? 'handoff' : 'message'} source survive cold hydration only in the private receipt`, async (t) => {
      const h = await harness(t);
      const authorization = {
        ownerAuthProvenance: 'strict',
        toolExecutionPolicy: {
          mode: 'callback_allowlist',
          allowedCallbackRoutes: ['POST /api/callbacks/register-deployment-wait'],
        },
      };
      const receipt = createTypedWaitRegistration({
        task: h.task,
        active: h.active,
        invocationId: h.identity.invocationId,
        source: { ...h.receipt.source, ...(sessionHandoff ? { sessionHandoff } : {}) },
        authorization,
      });
      const current = await h.taskStore.get(h.task.id);
      assert.ok(
        await h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
          expectedGeneration: 1,
          expectedDeploymentWait: current.deploymentWait,
          expectedUpdatedAt: current.updatedAt,
          deploymentWait: current.deploymentWait,
          waitRegistration: receipt,
        }),
      );
      const cold = new RedisTaskStore(h.redis);
      assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt.authorization, authorization);
      assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt.source, receipt.source);
      assert.equal(JSON.stringify(await cold.get(h.task.id)).includes('ownerAuthProvenance'), false);
    });
  }

  test('a losing Task CAS cannot overwrite the winning generation receipt', async (t) => {
    const h = await harness(t);
    const active = { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } };
    const nextReceipt = createTypedWaitRegistration({
      task: h.task,
      active,
      invocationId: 'child-2',
      source: h.receipt.source,
    });
    assert.equal(
      await h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
        expectedDeploymentWait: (await h.taskStore.get(h.task.id)).deploymentWait,
        expectedGeneration: 0,
        deploymentWait: { await: active },
        waitRegistration: nextReceipt,
      }),
      null,
    );
    assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt, h.receipt);
  });

  test('matched legacy receipt can seal authorization once without replacing its source or scope', async (t) => {
    const h = await harness(t);
    const authorization = { ownerAuthProvenance: 'strict' };
    const current = await h.taskStore.get(h.task.id);
    const waitOutcome = {
      v: 1,
      domain: 'deployment',
      outcomeId: `wait:${h.active.subjectRef}:g1:matched`,
      generation: 1,
      subjectRef: h.active.subjectRef,
      ownerFence: h.active.ownerFence,
      reason: 'matched',
      delivery: 'pending',
      registeredAt: h.active.createdAt,
      at: Date.now(),
      actor: { kind: 'system' },
    };
    assert.ok(
      await h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: current.deploymentWait,
        deploymentWait: { waitOutcome },
      }),
    );
    const replace = (receipt) =>
      h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: { waitOutcome },
        deploymentWait: { waitOutcome },
        waitRegistration: receipt,
      });
    await assert.rejects(replace({ ...h.receipt, invocationId: 'another-invocation', authorization }), /does not bind/);
    assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt, h.receipt);
    assert.ok(await replace({ ...h.receipt, authorization }));
    const cold = new RedisTaskStore(h.redis);
    assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt, { ...h.receipt, authorization });
    await assert.rejects(replace({ ...h.receipt, authorization: { ownerAuthProvenance: 'unknown' } }), /does not bind/);
    assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt.authorization, authorization);
  });

  test('collector-only updates retain the same active registration', async (t) => {
    const h = await harness(t);
    await h.taskStore.patchAutomationState(h.task.id, {
      ci: { headSha: 'head-1', lastNotificationBucket: 'pending' },
    });
    assert.equal((await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity })).kind, 'bypass');
  });

  test('persistent waits survive elapsed time but generation replacement revokes authority', async (t) => {
    const h = await harness(t);
    assert.equal(
      (await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity, now: Number.MAX_SAFE_INTEGER }))
        .kind,
      'bypass',
    );
    const active = { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } };
    await h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
      expectedDeploymentWait: (await h.taskStore.get(h.task.id)).deploymentWait,
      expectedGeneration: 1,
      deploymentWait: { await: active },
    });
    assert.equal((await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity })).kind, 'reject');
  });

  test('a failed canonical Task read reports query_failed', async (t) => {
    const h = await harness(t);
    const read = h.redis.hgetall.bind(h.redis);
    h.redis.hgetall = async (key) => {
      if (key === TaskKeys.detail(h.task.id)) throw new Error('Task connection unavailable');
      return read(key);
    };
    assert.deepEqual(await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity }), {
      kind: 'reject',
      reason: 'query_failed',
    });
  });

  // C1-C7: a private continuation receipt authorizes only its exact Task/child.
  // These are fresh Redis Task reads, not the retired Message-custody Lua/Queue CAS.
  for (const deadline of ['persistent']) {
    async function registered(t) {
      const h = await harness(t);
      if (deadline === 'persistent') {
        const { expiresAt: _deadline, ...active } = h.active;
        const receipt = createTypedWaitRegistration({
          task: h.task,
          active,
          invocationId: h.identity.invocationId,
          source: h.receipt.source,
        });
        assert.ok(
          await h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
            expectedDeploymentWait: (await h.taskStore.get(h.task.id)).deploymentWait,
            expectedGeneration: 1,
            deploymentWait: { await: active },
            waitRegistration: receipt,
          }),
        );
        h.active = active;
        h.receipt = receipt;
      }
      assert.equal((await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity })).kind, 'bypass');
      return h;
    }

    test(`${deadline}: exact child/source/scope cannot be replaced, and all rejection reads are zero-write`, async (t) => {
      const h = await registered(t);
      const key = TaskKeys.detail(h.task.id);
      const before = await h.redis.hgetall(key);
      for (const changes of [
        { invocationId: 'parent-1' },
        { invocationId: 'another-child' },
        { sourceMessageId: 'foreign-source' },
        { holdTaskId: 'foreign-hold' },
        { threadId: 'foreign-thread' },
        { userId: 'foreign-user' },
        { catId: 'foreign-cat' },
      ]) {
        assert.equal(
          (await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity, ...changes })).kind,
          'reject',
        );
        assert.deepEqual(await h.redis.hgetall(key), before);
      }
      assert.equal(await h.redis.ttl(key), -1, 'private Task proof is persistent by default');
      assert.equal(await h.redis.ttl(TaskKeys.thread(h.task.threadId)), -1);
      const cold = new RedisTaskStore(h.redis);
      assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt, h.receipt);
      assert.equal(JSON.stringify(await cold.listByThread(h.task.threadId)).includes('typedWaitRegistration'), false);
    });

    for (const drift of [
      'owner',
      'user',
      'thread',
      'done',
      'subject',
      'generation',
      'fence',
      'predicate',
      'baseline',
      'terminal',
      'expiry',
      'receipt',
      'missing',
    ]) {
      test(`${deadline}: fresh private read rejects ${drift} after the thread snapshot without writing`, async (t) => {
        const h = await registered(t);
        const key = TaskKeys.detail(h.task.id);
        const read = h.redis.hgetall.bind(h.redis);
        const original = await read(key);
        let reads = 0;
        let injected = false;
        let winner;
        h.redis.hgetall = async (requested) => {
          if (requested !== key || ++reads !== 1) return read(requested);
          // listByThread already read the live Task; now change actual storage
          // before getWaitRegistration, with no delay or cached authorization.
          injected = true;
          if (drift === 'missing') {
            winner = original;
            return {}; // Simulate unavailable detail, never delete retained fixture data.
          }
          const state = JSON.parse(original.deploymentWait);
          const patch = {};
          if (drift === 'owner') patch.ownerCatId = 'foreign-cat';
          else if (drift === 'user') patch.userId = 'foreign-user';
          else if (drift === 'thread') patch.threadId = 'foreign-thread';
          else if (drift === 'done') patch.status = 'done';
          else if (drift === 'subject') state.await.subjectRef = 'deployment:different:runtime';
          else if (drift === 'generation') state.await.generation = 2;
          else if (drift === 'fence') state.await.ownerFence.generation = 2;
          else if (drift === 'predicate')
            state.await.continuation.when = [{ kind: 'new_ready_boot', services: ['web'] }];
          else if (drift === 'baseline') state.await.baseline.bootId = 'new-boot';
          else if (drift === 'terminal') state.waitOutcome = { generation: 1, reason: 'matched' };
          else if (drift === 'expiry') state.await.expiresAt = 1;
          else if (drift === 'receipt') patch.typedWaitRegistration = '{}';
          patch.deploymentWait = JSON.stringify(state);
          await h.redis.hset(key, patch);
          winner = await read(key);
          return winner;
        };
        assert.deepEqual(await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity }), {
          kind: 'reject',
          reason: 'no_candidate',
        });
        assert.equal(injected, true, 'drift is injected at the final private read');
        assert.deepEqual(await read(key), winner, 'rejection must not overwrite or repair the winning Task');
        assert.equal(await h.redis.ttl(key), -1);
      });
    }
  }

  test('persistent deployment wait remains live at a later final proof read without stored hash changes', async (t) => {
    const h = await harness(t);
    const key = TaskKeys.detail(h.task.id);
    const read = h.redis.hgetall.bind(h.redis);
    const before = await read(key);
    const realNow = Date.now;
    const initialNow = realNow();
    let now = initialNow;
    let reads = 0;
    try {
      Date.now = () => now;
      h.redis.hgetall = async (requested) => {
        const raw = await read(requested);
        if (requested === key && ++reads === 1) now = initialNow + 60_000;
        return raw;
      };
      assert.equal((await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity })).kind, 'bypass');
      assert.equal(reads, 1, 'listByThread uses a pipeline; this direct read is getWaitRegistration');
      assert.deepEqual(await read(key), before);
    } finally {
      Date.now = realNow;
    }
  });
});
