import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RedisRuntimeSessionStore } from '../dist/domains/cats/services/runtime-session/RedisRuntimeSessionStore.js';
import { RuntimeSessionSealReaper } from '../dist/domains/cats/services/runtime-session/RuntimeSessionSealReaper.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { runtimeSealMetadata } from './helpers/runtime-seal-recovery-fixture.js';

const fixture = ownedRedisFixture('1843-runtime-timeout');

test('an entered drain timeout spends the original budget, preserves execution truth and releases its healthy neighbor', async () => {
  const redis = fixture.client('timeout:');
  const store = new RedisRuntimeSessionStore(redis);
  for (const [id, at] of [
    ['a-hung', 1000],
    ['b-healthy', 2000],
  ]) {
    const record = runtimeSealMetadata(id);
    await store.upsert({ ...record, lifecycle: { ...record.lifecycle, retryCount: 0, lastObservedAt: at } });
  }
  let release,
    healthyCalls = 0;
  const reaper = new RuntimeSessionSealReaper({
    runtimeSessionStore: store,
    maxRetries: 1,
    sessionSealer: { requestSeal: async () => ({ accepted: true, status: 'sealing' }), finalize: async () => {} },
    drainRuntimeSession: async (record) => {
      if (record.sessionId === 'a-hung')
        await new Promise((resolve) => {
          release = resolve;
        });
      else healthyCalls++;
      return { ok: true, drainResult: 'complete', lastObservedStepCount: 1 };
    },
  });
  try {
    const first = await reaper.runOnce();
    const retained = await store.getBySessionId('a-hung');
    assert.equal(first.failed, 1);
    assert.equal(healthyCalls, 0);
    assert.equal(retained.lifecycle.retryCount, 1);
    assert.equal(retained.lifecycle.lastObservedAt, 1000, 'a timeout cannot invent a runtime observation');
    assert.equal(retained.lifecycle.state, 'runtime_seal_pending');
    assert.equal(retained.lifecycle.recoveryDisposition, 'needs_attention');
    assert.equal((await store.getBySessionId('b-healthy')).lifecycle.retryCount, 0);
    const second = await reaper.runOnce();
    assert.equal(second.failed, 0);
    assert.equal(second.sealed, 1);
    assert.equal(healthyCalls, 1);
    const snapshot = JSON.stringify(second);
    release();
    await delay(20);
    assert.equal(JSON.stringify(second), snapshot);
    assert.deepEqual(
      await store.getBySessionId('a-hung'),
      retained,
      'late continuation cannot replace the disposition',
    );
    const cold = new RedisRuntimeSessionStore(redis);
    await cold.initializeSealRecovery(true);
    assert.deepEqual(await cold.listSealRecoveryCandidates(), []);
  } finally {
    release?.();
    await delay(20);
  }
});

test('failure CAS rejects a changed scope/lifecycle and durable retry ordering survives old writer and index rebuild', async () => {
  const redis = fixture.client('cas:');
  const store = new RedisRuntimeSessionStore(redis);
  const input = runtimeSealMetadata('same-id');
  const selected = await store.upsert({ ...input, lifecycle: { ...input.lifecycle, retryCount: 0 } });
  await store.upsert({ ...selected, threadId: 'new-owner' });
  assert.equal(await store.failSealRecovery(selected, 4000, 5, 'timeout'), false);
  const current = await store.getBySessionId('same-id');
  assert.equal(await store.failSealRecovery(current, 4000, 5, 'timeout'), true);
  assert.equal(
    await store.failSealRecovery(current, 5000, 5, 'timeout'),
    false,
    'the same selected revision is charged once',
  );
  await store.upsert(current);
  const retained = await store.getBySessionId('same-id');
  assert.equal(retained.lifecycle.retryCount, 1);
  assert.equal(retained.lifecycle.lastRetryAt, 4000);
  const neighbor = runtimeSealMetadata('neighbor');
  await store.upsert({ ...neighbor, lifecycle: { ...neighbor.lifecycle, retryCount: 0, lastObservedAt: 3000 } });
  const cold = new RedisRuntimeSessionStore(redis);
  await cold.initializeSealRecovery(true);
  assert.deepEqual(
    (await cold.listSealRecoveryCandidates()).map((r) => r.sessionId),
    ['neighbor', 'same-id'],
  );
});
