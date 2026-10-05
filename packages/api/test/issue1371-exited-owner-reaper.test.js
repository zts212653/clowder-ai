import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const { InvocationOwnerReaper } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationOwnerReaper.js'
);
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { observeCliExecutionProcess } = await import('../dist/utils/CliExecutionObservation.js');
const { createExitedCliExecutionRecovery } = await import(
  '../dist/domains/cats/services/agents/invocation/ExitedCliExecutionRecovery.js'
);

async function nativeFixture(mode, store = new InMemoryTurnExecutionStore()) {
  const suffix = randomUUID();
  const scope = {
    threadId: `t-${suffix}`,
    userId: 'u',
    catId: 'opus5',
    parentInvocationId: `p-${suffix}`,
    invocationId: `c-${suffix}`,
  };
  const tracker = new InvocationTracker({ maxSlotTtlMs: 1 });
  const controller = tracker.start(scope.threadId, scope.catId, scope.userId, [scope.catId], scope.parentInvocationId);
  await store.createRunning({ ...scope, executionKind: 'ordinary', startedAt: 1 });
  const owner = { ...scope, executionId: scope.parentInvocationId };
  const proc = new EventEmitter();
  if (mode !== 'unknown')
    observeCliExecutionProcess(proc, mode === 'foreign' ? { ...owner, userId: 'foreign' } : owner);
  if (mode !== 'live') proc.emit('exit', 0, null);
  if (mode === 'new-process') observeCliExecutionProcess(new EventEmitter(), owner);
  if (mode === 'new-child') observeCliExecutionProcess(new EventEmitter(), { ...owner, invocationId: 'new-child' });
  let replacement;
  if (mode === 'replacement')
    replacement = tracker.start(scope.threadId, scope.catId, scope.userId, [scope.catId], 'replacement');
  if (mode === 'persist-failure')
    store.transitionTerminal = () => {
      throw new Error('fixture store unavailable');
    };
  const calls = [];
  const reaper = new InvocationOwnerReaper({
    invocationTracker: tracker,
    invocationRecordStore: {
      get: () => ({
        id: scope.parentInvocationId,
        threadId: scope.threadId,
        userId: scope.userId,
        status: 'running',
        targetCats: [scope.catId],
        createdAt: 1,
      }),
    },
    turnExecutionStore: store,
    ...createExitedCliExecutionRecovery(tracker),
    getProviderLifecycle: () => undefined,
    reconcileZombie: async () => {
      calls.push('reconcile');
      return { reconciled: 1, alreadyTerminal: 0, errors: 0 };
    },
    releaseExactOwner: () => {
      calls.push('release');
      tracker.completeByExecutionId(scope.threadId, scope.catId, scope.parentInvocationId);
    },
    now: () => Date.now() + (mode === 'grace' ? 10_000 : 8 * 60 * 60 * 1_000),
    log: { info() {}, warn() {} },
  });
  return { reaper, calls, controller, replacement, store, scope };
}

test('production native observer → exact fence → durable child → parent recovery chain', async () => {
  const h = await nativeFixture('exited');
  const result = await h.reaper.runOnce();
  assert.equal(result.releasedTerminal, 1);
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.store.get(h.scope.invocationId).terminalReason, 'provider_exited_without_terminal');
  assert.deepEqual(h.calls, ['reconcile', 'release']);
});

for (const mode of ['unknown', 'foreign', 'live', 'new-process', 'new-child', 'replacement', 'grace']) {
  test(`${mode} cannot authorize stale-owner retirement`, async () => {
    const h = await nativeFixture(mode);
    await h.reaper.runOnce();
    assert.deepEqual(h.calls, []);
    assert.equal(h.store.get(h.scope.invocationId).status, 'running');
    assert.equal((h.replacement ?? h.controller).signal.aborted, false);
  });
}

test('durable child failure never releases the parent or reports recovery success', async () => {
  const h = await nativeFixture('persist-failure');
  const result = await h.reaper.runOnce();
  assert.equal(result.deferredUnknown, 1);
  assert.deepEqual(h.calls, []);
  assert.equal(h.store.get(h.scope.invocationId).status, 'running');
});

test(
  'Redis keeps recovered child terminal across store recreation and late success cannot overwrite it',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'issue1371-exited-owner');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js'
    );
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `issue1371:${randomUUID()}:` });
    try {
      const store = new RedisTurnExecutionStore(redis);
      const h = await nativeFixture('exited', store);
      assert.equal((await h.reaper.runOnce()).releasedTerminal, 1);
      const restarted = new RedisTurnExecutionStore(redis);
      const saved = await restarted.get(h.scope.invocationId);
      assert.equal(saved.status, 'interrupted');
      assert.equal(await redis.ttl(`turnexec:record:${h.scope.invocationId}`), -1);
      await restarted.transitionTerminal(h.scope.invocationId, { status: 'succeeded', endedAt: saved.endedAt + 1 });
      assert.equal((await restarted.get(h.scope.invocationId)).status, 'interrupted');
      assert.deepEqual(h.calls, ['reconcile', 'release']);
    } finally {
      await redis.quit();
    }
  },
);

test('stale running ledger with exact confirmed process exit is retired before owner release', async () => {
  const tracker = new InvocationTracker({ maxSlotTtlMs: 1 });
  const scope = { threadId: 't', userId: 'u', catId: 'opus5', parentInvocationId: 'p', invocationId: 'c' };
  const controller = tracker.start('t', 'opus5', 'u', ['opus5'], 'p');
  const store = new InMemoryTurnExecutionStore();
  store.createRunning({ ...scope, executionKind: 'ordinary', startedAt: 1 });
  const order = [];
  const reaper = new InvocationOwnerReaper({
    invocationTracker: tracker,
    invocationRecordStore: {
      get: () => ({ id: 'p', threadId: 't', userId: 'u', status: 'running', targetCats: ['opus5'], createdAt: 1 }),
    },
    turnExecutionStore: store,
    getProviderLifecycle: () => undefined,
    getChildProcessExit: () => ({ exitedAt: 2 }),
    fenceExitedExecution: () => {
      order.push('fence');
      controller.abort('provider_exited_without_terminal');
      return true;
    },
    reconcileZombie: async () => {
      assert.equal(store.get('c').status, 'interrupted');
      order.push('reconcile');
      return { reconciled: 1, alreadyTerminal: 0, errors: 0 };
    },
    releaseExactOwner: () => {
      order.push('release');
      tracker.completeByExecutionId('t', 'opus5', 'p');
    },
    now: () => Date.now() + 8 * 60 * 60 * 1000,
    log: { info() {}, warn() {} },
  });
  const result = await reaper.runOnce();
  assert.equal(result.releasedTerminal, 1);
  assert.deepEqual(order, ['fence', 'reconcile', 'release']);
  assert.equal(tracker.has('t', 'opus5'), false);
});
