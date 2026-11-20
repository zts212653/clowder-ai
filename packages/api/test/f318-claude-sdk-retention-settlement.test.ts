import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  retentionCoordinatorFixture as fixture,
  settledRetentionTick,
} from './helpers/f338-retention-coordinator-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const opts = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
const carriesReceipt = (args: unknown[], invocationId = 'maintenance-1') =>
  args.some(
    (value) =>
      typeof value === 'string' &&
      value.includes(`"invocationId":"${invocationId}"`) &&
      value.includes('"outcome":"sample_pass"'),
  );

for (const change of ['none', 'disabled', 'returned'] as const)
  test(`F338: completed receipt survives concurrent ${change} and later return`, opts, async (t) => {
    const f = await fixture(t);
    await f.enable();
    const evaluate = f.redis.eval.bind(f.redis);
    let intercepted = false;
    t.mock.method(f.redis, 'eval', async (...args: Parameters<typeof f.redis.eval>) => {
      if (!intercepted && carriesReceipt(args)) {
        intercepted = true;
        if (change === 'disabled') {
          // Stop commits immediately before the receipt write, after the controller's snapshot read.
          await f.settings.set('owner', 'opus55', false);
          await f.coordinator.preferenceChanged('owner', 'opus55');
        } else if (change === 'returned') {
          await f.returnUsage('first-after-close', 90_000);
          f.time(75);
          await f.coordinator.tick();
        }
      }
      return evaluate(...args);
    });
    await settledRetentionTick(f.coordinator);
    const [window] = await f.store.recent();
    assert.ok(intercepted, 'race reached the actual receipt persistence boundary');
    assert.equal(f.queries(), 1);
    assert.equal(window?.receipts.length, 1, 'a stopped window must still account for its completed input');
    assert.equal(window.attempt?.completed, true);
    assert.deepEqual(window.source.confirmedWarmGapsMs, [], 'settlement preserves native source array shapes');
    assert.equal(window.state, change === 'none' ? 'waiting' : 'stopped');
    if (change !== 'none') assert.equal(window.reason, change === 'disabled' ? 'preference_changed' : 'source_changed');
    assert.equal(await f.store.settleReceipt(window.id, window.attempt!.id, window.receipts[0]!), true);
    assert.deepEqual(await f.store.get(window.id), window, 'duplicate receipt is a no-op on the latest state');
    assert.equal(await f.store.settleReceipt(window.id, 'different-attempt', window.receipts[0]!), false);
    assert.equal(
      await f.store.settleReceipt(window.id, window.attempt!.id, {
        ...window.receipts[0]!,
        writeTokens: 999,
      }),
      false,
      'conflicting payload cannot replace the original receipt',
    );
    assert.notEqual(await f.redis.zscore('cache-retention:reconciliation', window.id), null);
    const restarted = f.restart();
    f.time(change === 'returned' ? 76 : 60);
    await settledRetentionTick(restarted);
    if (change !== 'returned') {
      assert.notEqual(await f.redis.zscore('cache-retention:reconciliation', window.id), null);
      await f.returnUsage('first-after-close', 90_000);
      f.time(75);
    }
    await settledRetentionTick(restarted);
    await settledRetentionTick(f.restart());
    const recovered = await f.store.get(window.id);
    assert.equal(recovered?.receipts.length, 1);
    assert.equal(recovered?.returned?.invocationId, 'first-after-close');
    assert.deepEqual(recovered?.returned?.maintenanceInvocationIds, ['maintenance-1']);
    assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
    assert.equal(f.queries(), 1, 'repeated/restarted bookkeeping never sends another input');
    assert.equal(f.errors.length, 0);
  });

test('F338: restart recovers a durable receipt after projection failure, without a provider retry', opts, async (t) => {
  const f = await fixture(t);
  await f.enable();
  const evaluate = f.redis.eval.bind(f.redis);
  let blocked = true,
    refusedWrites = 0;
  t.mock.method(f.redis, 'eval', async (...args: Parameters<typeof f.redis.eval>) => {
    if (blocked && carriesReceipt(args) && args[2] === `cache-retention:window:${(await f.store.recent())[0]!.id}`) {
      refusedWrites++;
      return 0; // Conflicts exhaust the local merge budget; raw billing evidence remains durable.
    }
    return evaluate(...args);
  });
  await settledRetentionTick(f.coordinator);
  blocked = false;
  const [window] = await f.store.recent();
  assert.ok(refusedWrites > 0 && window && !window.attempt?.completed && window.receipts.length === 0);
  await f.coordinator.close();
  const restarted = f.restart();
  f.time(60);
  await settledRetentionTick(restarted);
  const recovered = await f.store.get(window.id);
  assert.equal(recovered?.attempt?.completed, true);
  assert.equal(recovered?.receipts.length, 1);
  assert.equal(recovered?.state, 'stopped', 'recovery must preserve the interrupted window stop');
  assert.equal(recovered?.reason, 'maintenance_failed_cost_unconfirmed');
  await f.returnUsage('after-restart', 90_000);
  f.time(75);
  await settledRetentionTick(restarted);
  await settledRetentionTick(f.restart());
  assert.equal((await f.store.get(window.id))?.returned?.maintenanceInvocationId, 'maintenance-1');
  assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
  assert.equal(f.queries(), 1);
});

test(
  'F338: closing during a second receipt keeps both maintenances linked to the first real return',
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.enable();
    await settledRetentionTick(f.coordinator);
    const evaluate = f.redis.eval.bind(f.redis);
    let interrupted = false;
    t.mock.method(f.redis, 'eval', async (...args: Parameters<typeof f.redis.eval>) => {
      if (!interrupted && carriesReceipt(args, 'maintenance-2')) {
        interrupted = true;
        await f.settings.set('owner', 'opus55', false);
        await f.coordinator.preferenceChanged('owner', 'opus55');
        await f.returnUsage('first-between-settlements', 90_000, 101);
        f.time(101);
        await f.coordinator.tick();
        const [pending] = await f.store.recent();
        assert.ok(pending && !pending.attempt?.completed && !pending.returned);
        assert.notEqual(await f.redis.zscore('cache-retention:reconciliation', pending.id), null);
      }
      return evaluate(...args);
    });
    f.time(100);
    await settledRetentionTick(f.coordinator);
    const [window] = await f.store.recent();
    assert.ok(interrupted && window);
    assert.equal(window.receipts.length, 2);
    assert.equal(window.state, 'stopped');
    assert.equal(window.reason, 'preference_changed');
    await settledRetentionTick(f.restart());
    const reconciled = await f.store.get(window.id);
    assert.deepEqual(reconciled?.returned?.maintenanceInvocationIds, ['maintenance-1', 'maintenance-2']);
    assert.equal(reconciled?.returned?.invocationId, 'first-between-settlements');
    assert.equal(reconciled?.returned?.readRatio, 0.9);
    assert.equal(f.queries(), 2);
  },
);

test('F338: an unsettled stopped claim without a receipt retains its accounting responsibility', opts, async (t) => {
  const f = await fixture(t);
  await f.enable();
  f.afterSend(async () => {
    throw new Error('receipt-not-yet-durable');
  });
  await settledRetentionTick(f.coordinator);
  const [window] = await f.store.recent();
  assert.ok(window && window.attempt?.completed === false && window.state === 'stopped');
  f.time(75);
  await settledRetentionTick(f.restart());
  assert.notEqual(await f.redis.zscore('cache-retention:reconciliation', window.id), null);
  assert.equal(f.queries(), 1, 'unknown cost is retained without retry');
});
