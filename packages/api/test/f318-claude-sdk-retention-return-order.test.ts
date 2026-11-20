import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CacheRetentionStateStore } from '../src/domains/cats/services/session/cache/CacheRetentionStateStore.js';
import { retentionKey } from '../src/domains/cats/services/session/cache/cache-retention-state.js';
import {
  base,
  retentionCoordinatorFixture as fixture,
  minute,
  settledRetentionTick,
} from './helpers/f338-retention-coordinator-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const opts = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
for (const [label, firstRead, secondRead, delayed, cold, stopped] of [
  ['ordered cold control', 90_000, 90_000, false, 2, true],
  ['delayed older cold', 90_000, 90_000, true, 2, true],
  ['newer warm resets', 90_000, 99_000, true, 0, false],
  ['older warm precedes cold', 99_000, 90_000, true, 1, false],
] as const)
  test(`F338: return health follows real input order (${label})`, opts, async (t) => {
    const f = await fixture(t);
    await f.enable();
    const settle = f.store.settleReceipt.bind(f.store);
    let rejectFirst = true;
    t.mock.method(f.store, 'settleReceipt', async (...args: Parameters<typeof settle>) => {
      if (rejectFirst) {
        rejectFirst = false;
        return false;
      }
      return settle(...args);
    });
    await settledRetentionTick(f.coordinator);
    const [a] = await f.store.recent();
    assert.ok(a?.attempt && !a.attempt.completed && a.state === 'stopped');
    const rawKey = `fixture:maintenance-receipt:${a.attempt.id}`,
      get = f.redis.get.bind(f.redis);
    let unavailable = true;
    t.mock.method(f.redis, 'get', async (...args: Parameters<typeof get>) =>
      unavailable && args[0] === rawKey ? null : get(...args),
    );
    f.time(75);
    await f.returnUsage('return-A', firstRead, 75);
    if (!delayed) {
      unavailable = false;
      await settledRetentionTick(f.coordinator);
    }
    f.source.timestamp = base + 75 * minute;
    await f.addDispatch('source-B', 'return-A');
    f.time(125);
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 2);
    await f.returnUsage('return-B', secondRead, 150);
    f.time(150);
    await settledRetentionTick(f.coordinator);
    unavailable = false;
    await settledRetentionTick(f.restart());
    const reader = new CacheRetentionStateStore(f.redis);
    const health = await reader.health('owner', 'opus55', 'parent');
    assert.equal((await reader.get(a.id))?.returned?.readRatio, firstRead / 100_000);
    assert.equal(health?.consecutiveCold, cold, 'late facts cannot be discarded or applied in arrival order');
    assert.equal(health.stopped, stopped);
    assert.equal(health.lastInvocationId, 'return-B');
    await settledRetentionTick(f.coordinator);
    assert.deepEqual(await reader.health('owner', 'opus55', 'parent'), health, 'repeated reconciliation is idempotent');
    f.source.timestamp = base + 150 * minute;
    await f.addDispatch('source-C', 'return-B');
    f.time(200);
    await settledRetentionTick(f.restart());
    assert.equal(f.queries(), stopped ? 2 : 3, 'known repeated cold returns block the next paid opportunity');
  });

test(
  'F338: invocation facts deduplicate across restart; input order survives clock ties and unknowns',
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.enable();
    await f.coordinator.observeDispatch(f.source, ['worker']);
    const [window] = await f.store.recent();
    assert.ok(window);
    const fact = (id: string, inputSequence: number, readRatio?: number) => ({
      invocationId: id,
      inputSequence,
      observedAt: base + (inputSequence % 2) * 1000,
      maintenanceInvocationId: 'maintenance',
      ...(readRatio === undefined ? {} : { readRatio }),
    });
    const facts = [
      fact('unknown-latest', 6),
      fact('last-cold', 5, 0.9),
      fact('newer-warm', 3, 0.95),
      fact('older-cold', 2, 0.9),
      fact('unknown-middle', 4),
    ];
    for (const value of facts) assert.equal(await f.store.recordReturn(window, value), true);
    const reader = new CacheRetentionStateStore(f.redis),
      initial = await reader.health('owner', 'opus55', 'parent');
    assert.equal(initial?.consecutiveCold, 1);
    assert.equal(initial.stopped, false);
    assert.equal(
      initial.lastInvocationId,
      'unknown-latest',
      'the canonical ordinal, not wall clock or arrival, defines latest',
    );
    assert.ok((await Promise.all(facts.map((value) => reader.recordReturn(window, value)))).every(Boolean));
    assert.deepEqual(await reader.health('owner', 'opus55', 'parent'), initial);
    assert.equal(
      await reader.recordReturn(window, { ...facts[3]!, readRatio: 0.5 }),
      false,
      'immutable invocation facts cannot be replaced',
    );
    assert.deepEqual(await reader.health('owner', 'opus55', 'parent'), initial);
    const key = `cache-retention:health:${retentionKey('owner', 'opus55', 'parent')}:returns`;
    assert.equal(await f.redis.hlen(key), 5);
    assert.equal(await f.redis.ttl(key), -1, 'health facts have no retention TTL');
    assert.equal(await reader.recordReturn(window, fact('next-cold', 7, 0.9)), true);
    assert.equal((await reader.health('owner', 'opus55', 'parent'))?.consecutiveCold, 2);
    assert.equal(await reader.recordReturn(window, fact('later-warm', 8, 0.99)), true);
    const health = await reader.health('owner', 'opus55', 'parent');
    assert.equal(health?.consecutiveCold, 0);
    assert.equal(health.stopped, true, 'a later warm return does not undo a proven historical consecutive cold pair');
    assert.equal(f.queries(), 0);
  },
);

test(
  'F338: a late warm fact between cold facts produces the same health as chronological processing',
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.enable();
    await f.coordinator.observeDispatch(f.source, ['worker']);
    const [window] = await f.store.recent();
    assert.ok(window);
    for (const sequence of [2, 4])
      await f.store.recordReturn(window, {
        invocationId: `cold-${sequence}`,
        inputSequence: sequence,
        observedAt: base + sequence,
        readRatio: 0.9,
        maintenanceInvocationId: 'maintenance',
      });
    assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.stopped, true);
    await f.store.save(
      { ...window, revision: window.revision + 1, state: 'stopped', reason: 'repeated_cold_return' },
      window.revision,
    );
    await f.store.recordReturn(window, {
      invocationId: 'warm-between',
      inputSequence: 3,
      observedAt: base + 3,
      readRatio: 0.99,
      maintenanceInvocationId: 'maintenance',
    });
    const health = await new CacheRetentionStateStore(f.redis).health('owner', 'opus55', 'parent');
    assert.equal(health?.consecutiveCold, 1);
    assert.equal(
      health.stopped,
      false,
      'derived health converges on the actual order rather than a premature ingestion-order latch',
    );
    assert.equal(
      (await f.store.get(window.id))?.state,
      'stopped',
      'correcting health never reopens an already stopped window',
    );
    assert.equal(f.queries(), 0);
  },
);

test('F338: a refused health fact keeps return reconciliation until it can commit once', opts, async (t) => {
  const f = await fixture(t);
  await f.enable();
  await settledRetentionTick(f.coordinator);
  const [window] = await f.store.recent();
  assert.ok(window);
  const record = f.store.recordReturn.bind(f.store);
  let writable = false;
  t.mock.method(f.store, 'recordReturn', async (...args: Parameters<typeof record>) =>
    writable ? record(...args) : false,
  );
  await f.returnUsage('health-write-delayed', 90_000, 75);
  f.time(75);
  await settledRetentionTick(f.coordinator);
  assert.equal((await f.store.get(window.id))?.returned, undefined);
  assert.notEqual(await f.redis.zscore('cache-retention:reconciliation', window.id), null);
  assert.equal(f.queries(), 1);
  writable = true;
  await settledRetentionTick(f.restart());
  await settledRetentionTick(f.coordinator);
  assert.equal((await f.store.get(window.id))?.returned?.invocationId, 'health-write-delayed');
  assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
  assert.equal(await f.redis.zscore('cache-retention:reconciliation', window.id), null);
  assert.equal(f.queries(), 1);
});
