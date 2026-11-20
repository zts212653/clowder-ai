import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base,
  retentionCoordinatorFixture as fixture,
  minute,
  settledRetentionTick,
} from './helpers/f338-retention-coordinator-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const opts = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

for (const phase of [49, 49.75, 50.5])
  test(`F338: 768 archived disabled references do not delay a live window (poll ${phase})`, opts, async (t) => {
    const f = await fixture(t, { admitSource: false });
    for (let i = 0; i < 768; i++)
      await f.store.remember({
        id: `off-${i}`,
        userId: 'owner',
        catId: 'fable-5',
        threadId: 'home',
        messageId: `missing-${i}`,
        messageThreadId: 'child',
        sourceInvocationId: `off-${i}`,
        targets: ['worker'],
        createdAt: base,
      });
    await f.coordinator.observeDispatch(f.source, ['worker']);
    await f.enable();
    for (let at = phase; at < 52; at++) {
      f.time(at);
      await settledRetentionTick(f.coordinator);
    }
    assert.equal(f.queries(), 1, 'maintenance must run before the original T50+2 minute deadline');
    assert.ok(await f.redis.hget('cache-retention:candidates', 'off-0'), 'archive is not discarded');
    assert.equal(f.record.lastUsage!.cacheObservation!.requestStartedAt, base);
  });

test('F338: a latest snapshot without first-return proof cannot clear a cold streak', opts, async (t) => {
  const f = await fixture(t);
  await f.enable();
  await settledRetentionTick(f.coordinator);
  const window = (await f.store.recent())[0]!;
  await f.store.recordReturn(window, {
    invocationId: 'previous-cold',
    inputSequence: 1,
    observedAt: base + 1000,
    readRatio: 0.9,
    maintenanceInvocationId: 'old',
  });
  // Both calls completed between polls. Ordinary transcript persistence may be absent.
  for (const [id, ratio] of [
    ['first-cold', 0.9],
    ['second-warm', 0.99],
  ] as const)
    f.record.lastUsage = {
      cacheObservation: {
        ...window.source,
        invocationId: id,
        requestStartedAt: base + 75 * minute,
        observedAt: base + 75 * minute + (id === 'first-cold' ? 1 : 2),
        cacheReadTokens: 100_000 * ratio,
      },
    };
  f.time(76);
  await settledRetentionTick(f.coordinator);
  assert.equal((await f.store.get(window.id))?.returned?.readRatio, undefined, 'latest cannot stand in for first');
  assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
});

for (const missing of [false, true])
  test(`F338: first return survives later snapshots, restart and replay (missing=${missing})`, opts, async (t) => {
    const f = await fixture(t);
    await f.enable();
    await settledRetentionTick(f.coordinator);
    const window = (await f.store.recent())[0]!;
    await f.returnUsage('first-cold', missing ? undefined : 90_000);
    await f.returnUsage('second-warm', 99_000, 75.5);
    f.time(76);
    const restarted = f.restart();
    t.after(() => restarted.close());
    await settledRetentionTick(restarted);
    await settledRetentionTick(restarted);
    const saved = await f.store.get(window.id);
    if (missing) {
      assert.equal(saved?.returned, undefined);
      assert.equal(saved?.returnUnknown, 'first_return_unproven');
      assert.equal(await f.store.health('owner', 'opus55', 'parent'), null);
    } else {
      assert.equal(saved?.returned?.invocationId, 'first-cold');
      assert.equal(saved?.returned?.readRatio, 0.9);
      assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
    }
  });

test(
  'F338: source completion enrolls its deadline ahead of completed and unknown enabled archives',
  opts,
  async (t) => {
    const f = await fixture(t, { admitSource: false });
    await f.enable();
    const sourceUsage = f.record.lastUsage;
    f.record.lastUsage = {};
    f.time(49);
    await f.coordinator.observeDispatch(f.source, ['worker']);
    assert.equal((await f.store.recent()).length, 0, 'dispatch during a source call has no final usage yet');
    f.record.lastUsage = sourceUsage;
    await f.coordinator.observeSource(f.record);
    assert.equal((await f.store.recent()).length, 1, 'normal final usage enrolls without a poll or model work');
    assert.equal(f.queries(), 0);
    for (let i = 0; i < 800; i++) {
      const oldSource = structuredClone(f.source),
        oldReply = structuredClone(f.response);
      oldSource.id = `archive-${i}`;
      oldSource.extra = { crossPost: { sourceThreadId: `archive-home-${i}`, sourceInvocationId: `settled-${i}` } };
      oldSource.lifecycle!.dispatchRefs = [
        { targetId: 'worker', phase: 'dispatched', statusMessageId: `archive-reply-${i}` },
      ];
      oldReply.id = `archive-reply-${i}`;
      oldReply.lifecycle = {
        kind: 'response',
        status: 'completed',
        targetId: 'worker',
        inputMessageIds: [oldSource.id],
        orderKey: oldReply.id,
      };
      const oldRecord = structuredClone(f.record);
      oldRecord.id = `archive-parent-${i}`;
      oldRecord.threadId = `archive-home-${i}`;
      oldRecord.lastUsage!.cacheObservation!.invocationId = `settled-${i}`;
      f.records.set(oldRecord.threadId, oldRecord);
      f.history.set(oldSource.id, oldSource);
      if (i % 2 === 0) f.history.set(oldReply.id, oldReply);
      await f.coordinator.observeDispatch(oldSource, ['worker']);
    }
    f.time(50.75);
    const restarted = f.restart();
    t.after(() => restarted.close());
    await settledRetentionTick(restarted);
    assert.equal(f.queries(), 1);
    assert.equal((await f.store.recent())[0]?.source.requestStartedAt, base);
  },
);
