import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { projectSessionCacheWarmth } from '../src/domains/cats/services/session/cache/session-cache-warmth.js';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  base,
  retentionCoordinatorFixture as fixture,
  minute,
  settledRetentionTick,
} from './helpers/f338-retention-coordinator-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const opts = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

test(
  'F338 product: bounded discovery rotates past disabled and completed sources despite new arrivals',
  opts,
  async (t) => {
    const f = await fixture(t, { admitSource: false });
    const completed = {
      ...structuredClone(f.source),
      id: 'completed-source',
      timestamp: base,
      extra: { crossPost: { sourceThreadId: 'completed-home', sourceInvocationId: 'completed-invocation' } },
    } as StoredMessage;
    const completedRecord = structuredClone(f.record);
    completedRecord.threadId = 'completed-home';
    completedRecord.lastUsage!.cacheObservation!.invocationId = 'completed-invocation';
    f.records.set('completed-home', completedRecord);
    f.history.set(completed.id, completed);
    const completedReply = { ...structuredClone(f.response), id: 'reply' };
    complete(completedReply);
    completedReply.lifecycle!.kind === 'response' && (completedReply.lifecycle.inputMessageIds = [completed.id]);
    f.history.set('reply', completedReply);
    for (let i = 0; i < 256; i++) {
      if (i % 2 === 0) {
        await f.store.remember({
          id: `disabled-${i}`,
          userId: 'owner',
          catId: 'fable-5',
          threadId: 'home',
          messageId: `missing-${i}`,
          messageThreadId: 'child',
          sourceInvocationId: `disabled-${i}`,
          targets: ['worker'],
          createdAt: base,
        });
      } else {
        const source = { ...structuredClone(completed), id: `completed-${i}` };
        const reply = { ...structuredClone(completedReply), id: `${source.id}-reply` };
        reply.lifecycle!.kind === 'response' && (reply.lifecycle.inputMessageIds = [source.id]);
        source.lifecycle!.dispatchRefs = [{ targetId: 'worker', phase: 'dispatched', statusMessageId: reply.id }];
        f.history.set(source.id, source);
        f.history.set(reply.id, reply);
        await f.coordinator.observeDispatch(source, ['worker']);
      }
    }
    f.history.set('reply', f.response);
    await f.coordinator.observeDispatch(f.source, ['worker']);
    await f.enable();
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 1, 'enabled member recovery drains the current snapshot in one poll');
    for (let i = 0; i < 20; i++)
      await f.store.remember({
        id: `new-${i}`,
        userId: 'owner',
        catId: 'fable-5',
        threadId: 'home',
        messageId: `new-${i}`,
        messageThreadId: 'child',
        sourceInvocationId: `new-${i}`,
        targets: ['worker'],
        createdAt: base,
      });
    f.time(51);
    const restarted = f.restart();
    t.after(() => restarted.close());
    await settledRetentionTick(restarted);
    assert.equal(f.queries(), 1, 'a later enabled source is reached inside its window without deleting earlier work');
    assert.ok(await f.redis.hget('cache-retention:candidates', 'disabled-0'), 'disabled references remain durable');
    assert.notEqual(
      await f.redis.zscore('cache-retention:pending', 'disabled-0'),
      null,
      'disabled sources remain discoverable',
    );
  },
);

test('F338 product: more than one source page preserves a pending witness through final send', opts, async (t) => {
  const f = await fixture(t, { admitSource: false });
  f.source.timestamp = base;
  for (let i = 0; i < 257; i++) complete((await f.addDispatch(`completed-${i}`)).response);
  f.source.timestamp = base + 500;
  await f.coordinator.observeDispatch(f.source, ['worker']);
  await f.enable();
  await settledRetentionTick(f.coordinator);
  f.time(51);
  await settledRetentionTick(f.coordinator);
  assert.equal(f.queries(), 1, 'source pagination must neither miss the remaining reply nor lose it at final send');
});

test('F338 product: an older maintenance return is reconciled beyond the latest 256 windows', opts, async (t) => {
  const f = await fixture(t);
  await f.enable();
  await settledRetentionTick(f.coordinator);
  const original = (await f.store.recent())[0]!;
  for (let i = 0; i < 256; i++)
    await f.store.save(
      {
        ...structuredClone(original),
        id: `newer-${i}`,
        revision: 1,
        state: 'stopped',
        receipts: [],
        source: { ...original.source, observedAt: base + 2000 + i },
      },
      0,
    );
  await f.returnUsage('actual-return', 90_000);
  f.time(75);
  await settledRetentionTick(f.coordinator);
  await settledRetentionTick(f.coordinator);
  assert.equal((await f.store.get(original.id))?.returned?.invocationId, 'actual-return');
  assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
});

function complete(response: StoredMessage): void {
  response.lifecycle = {
    ...response.lifecycle!,
    kind: 'response',
    status: 'completed',
    targetId: 'worker',
    inputMessageIds: response.lifecycle?.kind === 'response' ? response.lifecycle.inputMessageIds : [],
  };
}

for (const timing of ['before_tick', 'during_prepare'] as const)
  test(`F338 product: current dispatch references survive target reselection ${timing}`, opts, async (t) => {
    const f = await fixture(t);
    await f.enable();
    f.time(49);
    await settledRetentionTick(f.coordinator);
    const reselect = async () => {
      complete(f.response);
      f.source.lifecycle = {
        kind: 'input',
        orderKey: 'dispatch',
        dispatchRefs: [{ targetId: 'replacement', phase: 'dispatched', statusMessageId: 'replacement-reply' }],
      };
      f.history.set('replacement-reply', {
        ...f.response,
        id: 'replacement-reply',
        from: { kind: 'agent', catId: createCatId('replacement') },
        lifecycle: {
          kind: 'response',
          orderKey: 'replacement-reply',
          status: 'processing',
          targetId: 'replacement',
          inputMessageIds: ['dispatch'],
        },
      });
    };
    if (timing === 'before_tick') await reselect();
    else f.beforeSend(reselect);
    f.time(50);
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 1);
  });

test(
  'F338 product: one completed dispatch does not stop a shared window with another pending reply',
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.enable();
    await f.addDispatch('second-dispatch');
    f.time(49);
    await settledRetentionTick(f.coordinator);
    complete(f.response);
    f.time(50);
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 1, 'the remaining dispatch still needs the same parent window');
    assert.equal((await f.store.recent())[0]?.receipts.length, 1);
    assert.equal((await f.store.recent())[0]?.state, 'waiting');
  },
);

for (const timing of ['before_prepare', 'during_prepare'] as const)
  test(`F338 product: final send aggregates same-source pending replies ${timing}`, opts, async (t) => {
    const f = await fixture(t);
    await f.enable();
    if (timing === 'before_prepare') await f.addDispatch('second-dispatch');
    f.beforeSend(async () => {
      if (timing === 'during_prepare') await f.addDispatch('second-dispatch');
      complete(f.response);
    });
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 1, 'finishing the representative message does not cancel other waiting work');
  });

test(
  'F338 product: a pending dispatch from another invocation cannot keep this source window alive',
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.enable();
    await f.addDispatch('unrelated', 'another-source');
    f.time(49);
    await settledRetentionTick(f.coordinator);
    complete(f.response);
    f.time(50);
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 0);
  },
);

test(
  'F338 product: default-off, two bounded distinct maintenance claims, restart, same parent and no catch-up',
  opts,
  async (t) => {
    const f = await fixture(t);
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 0);
    await f.enable();
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 1);
    const saved = (await f.store.recent())[0]!;
    assert.equal(saved.sessionId, 'parent');
    assert.equal(saved.receipts.length, 1);
    assert.equal(await f.redis.ttl(`cache-retention:window:${saved.id}`), -1);
    f.time(75);
    const projected = projectSessionCacheWarmth(f.record, base + 75 * minute, undefined, await f.store.proof(f.record));
    assert.equal(projected.status, 'warm');
    assert.equal(projected.source, 'cache_retention');
    assert.equal(projected.retaining, true);
    assert.equal(f.record.lastUsage!.cacheObservation!.requestStartedAt, base);
    f.time(100);
    const restarted = f.restart();
    t.after(() => restarted.close());
    await settledRetentionTick(restarted);
    assert.equal(f.queries(), 2);
    await f.settings.set('owner', 'opus55', false);
    assert.equal(
      (await f.store.proof(f.record))?.retaining,
      false,
      'opt-out removes retention presentation immediately',
    );
    f.time(121);
    await settledRetentionTick(restarted);
    assert.equal(f.queries(), 2);
  },
);

for (const boundary of ['disabled', 'settled', 'late', 'parent_changed'] as const)
  test(`F338 product: ${boundary} after async preparation gives zero model requests`, opts, async (t) => {
    const f = await fixture(t);
    await f.enable();
    f.beforeSend(async () => {
      if (boundary === 'disabled') await f.settings.set('owner', 'opus55', false);
      if (boundary === 'settled')
        f.response.lifecycle = {
          ...f.response.lifecycle!,
          kind: 'response',
          status: 'completed',
          targetId: 'worker',
          inputMessageIds: ['dispatch'],
        };
      if (boundary === 'late') f.time(53);
      if (boundary === 'parent_changed') f.record.cliSessionId = 'changed';
    });
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 0);
    await settledRetentionTick(f.coordinator);
    assert.equal(f.queries(), 0, 'a claimed attempt is never retried');
  });

test(
  'F338 product: next real return is linked once, two known cold returns stop only this session',
  opts,
  async (t) => {
    const f = await fixture(t);
    await f.enable();
    await settledRetentionTick(f.coordinator);
    const window = (await f.store.recent())[0]!;
    await f.returnUsage('real-return', 90_000);
    await settledRetentionTick(f.coordinator);
    await settledRetentionTick(f.coordinator);
    const stored = await f.store.get(window.id);
    assert.equal(stored?.returned?.maintenanceInvocationId, 'maintenance-1');
    assert.equal(stored?.returned?.readRatio, 0.9);
    assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
    await f.store.recordReturn(window, {
      invocationId: 'unknown-return',
      inputSequence: 3,
      observedAt: base + 76 * minute,
      maintenanceInvocationId: 'm2',
    });
    assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
    await f.store.recordReturn(window, {
      invocationId: 'second-cold',
      inputSequence: 4,
      observedAt: base + 77 * minute,
      readRatio: 0.9,
      maintenanceInvocationId: 'm3',
    });
    assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.stopped, true);
    assert.equal(await f.store.health('other-owner', 'opus55', 'parent'), null);
  },
);

test('F338 product: a durable in-flight claim after a crash is stopped without a paid retry', opts, async (t) => {
  const f = await fixture(t);
  await f.enable();
  f.time(49);
  await settledRetentionTick(f.coordinator);
  const window = (await f.store.recent())[0]!;
  assert.equal(
    await f.store.save(
      {
        ...window,
        revision: window.revision + 1,
        state: 'retaining',
        attempt: { id: 'interrupted', startedAt: base + 50 * minute, completed: false },
      },
      window.revision,
    ),
    true,
  );
  f.time(50);
  const restarted = f.restart();
  t.after(() => restarted.close());
  await settledRetentionTick(restarted);
  assert.equal(f.queries(), 0);
  assert.equal((await f.store.get(window.id))?.reason, 'interrupted_attempt_cost_unknown');
});
