import { settledRetentionTick } from './helpers/f338-retention-coordinator-fixture.js';
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalReturnFixture } from './helpers/f338-normal-return-fixture.js';
import { base, retentionCoordinatorFixture as fixture } from './helpers/f338-retention-coordinator-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const opts = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
async function withoutUsage(f: Awaited<ReturnType<typeof fixture>>, id: string, at: number) {
  const previous = structuredClone(f.record.lastUsage);
  await f.returnUsage(id, undefined, at);
  f.record.lastUsage = previous;
}

for (const phase of ['before_enrollment', 'before_first', 'before_reconcile', 'due_first', 'during_prepare'] as const)
  test(`F338: an ordinary input with no usage stops maintenance (${phase})`, opts, async (t) => {
    const f = await fixture(t);
    if (phase === 'before_enrollment') await withoutUsage(f, 'no-usage', 49.5);
    await f.enable();
    f.time(49);
    await settledRetentionTick(f.coordinator);
    if (phase === 'before_first') await withoutUsage(f, 'no-usage', 49.5);
    if (phase === 'during_prepare') f.beforeSend(() => withoutUsage(f, 'no-usage', 50));
    f.time(50);
    await settledRetentionTick(f.coordinator);
    const expected = ['before_enrollment', 'before_first', 'during_prepare'].includes(phase) ? 0 : 1;
    assert.equal(f.queries(), expected);
    if (phase === 'before_reconcile' || phase === 'due_first') {
      await withoutUsage(f, 'no-usage', phase === 'due_first' ? 99 : 75);
      if (phase === 'before_reconcile') {
        f.time(75);
        await settledRetentionTick(f.coordinator);
      }
    }
    f.time(100);
    const restarted = f.restart();
    t.after(() => restarted.close());
    await settledRetentionTick(restarted);
    await settledRetentionTick(restarted);
    assert.equal(f.queries(), expected, 'a real input cannot be absorbed into a new maintenance frontier');
    const windows = await f.store.recent();
    assert.equal(windows[0]?.state, 'stopped');
    assert.equal(f.record.lastUsage!.cacheObservation!.requestStartedAt, base);
  });

for (const missing of [false, true])
  for (const phase of [
    'before_first',
    'reconcile_first',
    'due_first',
    'during_prepare',
    'during_second_prepare',
  ] as const)
    test(`F338 real normal Host input stops maintenance (${phase}, missing=${missing})`, opts, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: base });
      const f = await fixture(t, { admitSource: false });
      const host = await normalReturnFixture(t, f.executions);
      f.records.set(host.scope.threadId, host.record);
      f.source.from = { kind: 'agent', catId: host.scope.catId };
      f.source.catId = host.scope.catId;
      f.source.extra = {
        crossPost: { sourceThreadId: host.scope.threadId, sourceInvocationId: host.source.invocationId },
      };
      await f.settings.set('owner', host.scope.catId, true);
      f.time(49);
      t.mock.timers.setTime(base + 49 * 60_000);
      await f.coordinator.observeDispatch(f.source, ['worker']);
      const returned = async (at: number) => {
        f.time(at);
        t.mock.timers.setTime(base + at * 60_000);
        await host.run(0.9, missing);
      };
      if (phase === 'before_first') await returned(49.5);
      if (phase === 'during_prepare') f.beforeSend(() => returned(50));
      f.time(50);
      t.mock.timers.setTime(base + 50 * 60_000);
      await settledRetentionTick(f.coordinator);
      const expected = phase === 'before_first' || phase === 'during_prepare' ? 0 : 1;
      assert.equal(f.queries(), expected);
      if (phase === 'during_second_prepare') f.beforeSend(() => returned(100));
      if (phase === 'reconcile_first' || phase === 'due_first') {
        await returned(phase === 'due_first' ? 99 : 75);
        if (phase === 'reconcile_first') await settledRetentionTick(f.coordinator);
      }
      const restarted = f.restart();
      t.after(() => restarted.close());
      f.time(100);
      t.mock.timers.setTime(base + 100 * 60_000);
      await settledRetentionTick(restarted);
      await settledRetentionTick(restarted);
      assert.equal(f.queries(), expected);
      const window = (await f.store.recent())[0]!;
      assert.equal(window.state, 'stopped');
      assert.equal(window.source.requestStartedAt, base);
      assert.equal(
        window.sourceInputSequence,
        await f.executions.cacheFacts.sequenceOf(host.scope, host.source.invocationId),
      );
      assert.ok(
        window.receipts.every((r) => r.returnAfterSequence === window.sourceInputSequence),
        'maintenance never rebases the source',
      );
    });

test('F338: missing source order proof stops the window instead of capturing the current head', opts, async (t) => {
  const f = await fixture(t);
  await f.redis.set('turnexec:cache-entry:source', 'legacy-unproven');
  await f.enable();
  await settledRetentionTick(f.coordinator);
  f.time(100);
  const restarted = f.restart();
  t.after(() => restarted.close());
  await settledRetentionTick(restarted);
  assert.equal(f.queries(), 0);
  assert.equal((await f.store.recent())[0]?.state, 'stopped');
  assert.equal((await f.store.recent())[0]?.reason, 'input_order_unproven');
});

test('F338: a running first input stops sends while its eventual usage is still reconciled once', opts, async (t) => {
  const f = await fixture(t);
  await f.enable();
  await settledRetentionTick(f.coordinator);
  const window = (await f.store.recent())[0]!;
  await f.executions.createRunning({
    invocationId: 'pending-input',
    parentInvocationId: 'pending-input',
    userId: 'owner',
    threadId: 'home',
    catId: 'opus55',
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    startedAt: base + 75 * 60_000,
  });
  await f.executions.markProviderStarted('pending-input', base + 75 * 60_000);
  f.time(75);
  await settledRetentionTick(f.coordinator);
  assert.equal((await f.store.get(window.id))?.state, 'stopped');
  assert.equal((await f.store.get(window.id))?.returned, undefined);
  await f.returnUsage('pending-input', 90_000);
  await settledRetentionTick(f.coordinator);
  await settledRetentionTick(f.coordinator);
  assert.equal((await f.store.get(window.id))?.returned?.invocationId, 'pending-input');
  assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
  f.time(100);
  await settledRetentionTick(f.coordinator);
  assert.equal(f.queries(), 1);
});
