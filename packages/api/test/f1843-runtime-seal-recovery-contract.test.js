import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeSessionSealReaper } from '../dist/domains/cats/services/runtime-session/RuntimeSessionSealReaper.js';
import { RuntimeSessionStore } from '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js';
import { runtimeSealMetadata } from './helpers/runtime-seal-recovery-fixture.js';

test('exhausted runtime seal records retain pending execution truth but leave automatic recovery with a durable disposition', async () => {
  const store = new RuntimeSessionStore();
  const original = runtimeSealMetadata();
  store.upsert(original);
  const reaper = new RuntimeSessionSealReaper({
    runtimeSessionStore: store,
    now: () => 3000,
    sessionSealer: {
      requestSeal: async () => assert.fail('cannot invent a terminal seal'),
      finalize: async () => assert.fail(),
    },
    drainRuntimeSession: async () => assert.fail('exhausted work cannot be drained again'),
  });
  await reaper.runOnce();
  const retained = store.getBySessionId(original.sessionId);
  assert.equal(retained.lifecycle.state, 'runtime_seal_pending');
  assert.equal(retained.lifecycle.retryCount, 5);
  assert.equal(retained.lifecycle.recoveryDisposition, 'needs_attention');
  assert.equal((await reaper.runOnce()).scanned, 0);
  assert.ok(store.getBySessionId(original.sessionId));
  store.upsert({ ...original, lifecycle: { ...original.lifecycle, lastObservedAt: 4000, retryCount: 0 } });
  assert.equal(
    store.getBySessionId(original.sessionId).lifecycle.recoveryDisposition,
    'needs_attention',
    'a same-execution writer must preserve the owner disposition',
  );
  assert.equal(store.getBySessionId(original.sessionId).lifecycle.retryCount, 5);
  assert.equal((await reaper.runOnce()).scanned, 0);
});

test('an old seal candidate cannot park a new owner scope on the same sidecar ID', () => {
  const store = new RuntimeSessionStore();
  const previous = store.upsert(runtimeSealMetadata('scope-drift'));
  store.upsert({ ...previous, threadId: 'new-owner-thread' });
  assert.equal(store.parkSealRecovery(previous, 5000), false);
  assert.equal(store.getBySessionId(previous.sessionId).lifecycle.recoveryDisposition, undefined);
});

test('a same-execution pending heartbeat cannot reset the partial recovery budget before disposition', () => {
  const store = new RuntimeSessionStore();
  const source = runtimeSealMetadata('heartbeat');
  store.upsert({ ...source, lifecycle: { ...source.lifecycle, retryCount: 4 } });
  store.upsert({ ...source, lifecycle: { ...source.lifecycle, retryCount: 0, lastObservedAt: 3000 } });
  assert.equal(store.getBySessionId(source.sessionId).lifecycle.retryCount, 4);
});

test('one sidecar metadata failure cannot prevent a healthy neighboring seal from settling', async () => {
  const store = new RuntimeSessionStore();
  store.upsert(runtimeSealMetadata('unavailable'));
  const good = runtimeSealMetadata('healthy-neighbor');
  good.lifecycle.retryCount = 0;
  store.upsert(good);
  const park = store.parkSealRecovery.bind(store);
  store.parkSealRecovery = (record) => {
    if (record.sessionId === 'unavailable') throw new Error('synthetic sidecar metadata unavailable');
    return park(record, 3000);
  };
  const reaper = new RuntimeSessionSealReaper({
    runtimeSessionStore: store,
    now: () => 3000,
    sessionSealer: { requestSeal: async () => ({ accepted: true, status: 'sealing' }), finalize: async () => {} },
    drainRuntimeSession: async () => ({ ok: true, drainResult: 'complete', lastObservedStepCount: 1 }),
  });
  const result = await reaper.runOnce();
  assert.equal(result.failed, 1);
  assert.equal(result.sealed, 1);
  assert.equal(store.getBySessionId(good.sessionId).lifecycle.state, 'sealed');
});
