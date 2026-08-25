import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `m0c-snapshot-test-${process.pid}:`;

async function stageAndCommit(store, pluginInstanceId, subscriptionId, snapshot, chunkSize = 16) {
  const { items, nextOffset, traversalComplete, ...candidate } = snapshot;
  const started = await store.beginSnapshotCapture(pluginInstanceId, subscriptionId, {
    ...candidate,
    expiresAt: Date.now() + 60_000,
  });
  if (started?.status === 'existing') return started.snapshot;
  assert.equal(started?.status, 'started');
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(
      await store.appendSnapshotCapture(
        pluginInstanceId,
        subscriptionId,
        snapshot.snapshotId,
        offset,
        items.slice(offset, offset + chunkSize),
      ),
      true,
    );
  }
  return store.commitSnapshotCapture(pluginInstanceId, subscriptionId, {
    snapshotId: snapshot.snapshotId,
    expectedItemCount: items.length,
    nextOffset,
    traversalComplete,
  });
}

describe('M0-C Redis snapshot cursor', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'M0CRedisSnapshot');
    const [{ RedisCursorStore }, { createRedisClient }] = await Promise.all([
      import('../dist/domains/messaging/stores/redis.js'),
      import('@cat-cafe/shared/utils'),
    ]);
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    store = new RedisCursorStore(redis);
  });

  after(async () => {
    if (redis) await redis.quit();
  });

  it('freezes one view and atomically advances both cursor watermarks on final ack', async () => {
    const subscriptionId = `sub-${Date.now()}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId: `handle-${Date.now()}`,
      threadId: 'thread-1',
      ackedSequence: 3,
      lastDeliveredSequence: 4,
    });
    const first = {
      snapshotId: `snap-${Date.now()}`,
      headSequence: 11,
      items: [],
      createdAt: 1,
      nextOffset: 0,
      traversalComplete: false,
    };
    const competing = { ...first, snapshotId: `${first.snapshotId}-competing`, headSequence: 12 };
    const firstMetadata = {
      snapshotId: first.snapshotId,
      headSequence: first.headSequence,
      itemCount: 0,
      createdAt: first.createdAt,
      nextOffset: first.nextOffset,
      traversalComplete: first.traversalComplete,
    };

    assert.deepEqual(await stageAndCommit(store, 'inst-a', subscriptionId, first), firstMetadata);
    assert.deepEqual(await stageAndCommit(store, 'inst-a', subscriptionId, competing), firstMetadata);
    assert.equal(await store.ackSnapshot('inst-a', subscriptionId, competing.snapshotId, 12), 'rejected');
    const unchanged = await store.get('inst-a', subscriptionId);
    assert.deepEqual(
      { ackedSequence: unchanged.ackedSequence, lastDeliveredSequence: unchanged.lastDeliveredSequence },
      { ackedSequence: 3, lastDeliveredSequence: 4 },
    );

    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0, tokenId: 'forged' },
        { offset: 0, traversalComplete: true },
      ),
      false,
    );
    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0 },
        { offset: 0, tokenId: 'page-2', traversalComplete: false },
      ),
      true,
    );
    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0 },
        { offset: 0, traversalComplete: true },
      ),
      false,
    );
    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0, tokenId: 'page-2' },
        { offset: 0, traversalComplete: true },
      ),
      true,
    );
    assert.equal(await store.ackSnapshot('inst-a', subscriptionId, first.snapshotId, 11), 'applied');
    const settled = await store.get('inst-a', subscriptionId);
    assert.equal(settled.ackedSequence, 11);
    assert.equal(settled.lastDeliveredSequence, 11);
    assert.equal(settled.snapshotView, undefined);
    assert.deepEqual(settled.lastSnapshotCompletion, { snapshotId: first.snapshotId, headSequence: 11 });
    assert.deepEqual(
      await redis.lrange(
        `plugmsg:subsnapitems:${encodeURIComponent('inst-a')}:${encodeURIComponent(subscriptionId)}`,
        0,
        -1,
      ),
      [],
      'final ack must reclaim the frozen item list',
    );
    assert.equal(await store.ackSnapshot('inst-a', subscriptionId, first.snapshotId, 11), 'replayed');
  });

  it('keeps snapshot projections out of the durable subscription identity during revocation', async () => {
    const subscriptionId = `sub-revoke-${Date.now()}`;
    const handleId = `handle-revoke-${Date.now()}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId,
      threadId: 'thread-1',
      ackedSequence: 3,
      lastDeliveredSequence: 4,
    });
    await stageAndCommit(store, 'inst-a', subscriptionId, {
      snapshotId: `snap-revoke-${Date.now()}`,
      headSequence: 11,
      items: [],
      createdAt: 1,
      nextOffset: 0,
      traversalComplete: false,
    });

    assert.equal(await store.revokeByHandle(handleId, 12), 1);
    const raw = await redis.get(`plugmsg:sub:${encodeURIComponent('inst-a')}:${encodeURIComponent(subscriptionId)}`);
    const persisted = JSON.parse(raw);
    assert.equal(persisted.snapshotView, undefined);
    assert.equal(persisted.lastSnapshotCompletion, undefined);
    assert.equal(persisted.revokedAt, 12);
  });

  it('stores frozen snapshot items outside the cursor state and reads only the requested page', async () => {
    const subscriptionId = `sub-items-${Date.now()}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId: `handle-items-${Date.now()}`,
      threadId: 'thread-1',
      ackedSequence: 0,
      lastDeliveredSequence: 0,
    });
    const items = [
      {
        messageId: 'message-1',
        revision: 1,
        threadId: 'thread-1',
        actor: { kind: 'plugin', id: 'inst-a' },
        audience: { kind: 'public' },
        occurredAt: '2026-08-21T01:00:00.000Z',
        payload: {
          provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
          elements: [{ elementId: 'element-1', kind: 'text', payload: { text: 'hello' } }],
        },
      },
    ];
    const snapshot = {
      snapshotId: `snap-items-${Date.now()}`,
      headSequence: 1,
      items,
      createdAt: 1,
      nextOffset: 0,
      traversalComplete: false,
    };

    const created = await stageAndCommit(store, 'inst-a', subscriptionId, snapshot);
    assert.equal(created.itemCount, 1);
    assert.equal(created.items, undefined);
    const rawState = await redis.get(
      `plugmsg:subsnap:${encodeURIComponent('inst-a')}:${encodeURIComponent(subscriptionId)}`,
    );
    assert.equal(
      Object.hasOwn(JSON.parse(rawState), 'items'),
      false,
      'cursor Lua must not decode the entire frozen view',
    );
    assert.deepEqual(await store.readSnapshotPage('inst-a', subscriptionId, snapshot.snapshotId, 0, 1), items);
    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        snapshot.snapshotId,
        { offset: 0 },
        { offset: 1, traversalComplete: true },
      ),
      true,
    );
    assert.equal(await store.ackSnapshot('inst-a', subscriptionId, snapshot.snapshotId, 1), 'applied');
    assert.deepEqual(
      await redis.lrange(
        `plugmsg:subsnapitems:${encodeURIComponent('inst-a')}:${encodeURIComponent(subscriptionId)}`,
        0,
        -1,
      ),
      [],
      'final ack must reclaim a non-empty frozen item list',
    );
  });

  it('keeps partial staging invisible and replaces an expired capture after restart', async () => {
    const subscriptionId = `sub-restart-${Date.now()}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId: `handle-restart-${Date.now()}`,
      threadId: 'thread-1',
      ackedSequence: 0,
      lastDeliveredSequence: 0,
    });
    const item = {
      messageId: 'message-restart',
      revision: 1,
      threadId: 'thread-1',
      actor: { kind: 'plugin', id: 'inst-a' },
      audience: { kind: 'public' },
      occurredAt: '2026-08-21T01:00:00.000Z',
      payload: {
        provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
        elements: [{ elementId: 'element-restart', kind: 'text', payload: { text: 'hello' } }],
      },
    };
    const firstId = `snap-abandoned-${Date.now()}`;
    assert.deepEqual(
      await store.beginSnapshotCapture('inst-a', subscriptionId, {
        snapshotId: firstId,
        headSequence: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      { status: 'started' },
    );
    assert.equal(await store.appendSnapshotCapture('inst-a', subscriptionId, firstId, 0, [item]), true);
    assert.equal((await store.get('inst-a', subscriptionId)).snapshotView, undefined);
    const captureKey = `plugmsg:subsnapcapture:${encodeURIComponent('inst-a')}:${encodeURIComponent(subscriptionId)}`;
    const abandoned = JSON.parse(await redis.get(captureKey));
    await redis.set(captureKey, JSON.stringify({ ...abandoned, expiresAt: 2 }));

    const replacementId = `snap-replacement-${Date.now()}`;
    assert.deepEqual(
      await store.beginSnapshotCapture('inst-a', subscriptionId, {
        snapshotId: replacementId,
        headSequence: 2,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      { status: 'started' },
    );
    assert.equal(await store.appendSnapshotCapture('inst-a', subscriptionId, replacementId, 0, [item]), true);
    assert.equal((await store.get('inst-a', subscriptionId)).snapshotView, undefined);
    const committed = await store.commitSnapshotCapture('inst-a', subscriptionId, {
      snapshotId: replacementId,
      expectedItemCount: 1,
      nextOffset: 0,
      traversalComplete: false,
    });
    assert.equal(committed.snapshotId, replacementId);
    assert.equal(committed.itemCount, 1);
  });

  it('maxItems=1 persists a large history through bounded Lua chunks', async () => {
    const appendEvalItemCounts = [];
    const instrumentedRedis = new Proxy(redis, {
      get(target, property) {
        if (property === 'eval') {
          return async (script, ...args) => {
            if (script.includes('capture.itemCount = expected')) {
              appendEvalItemCounts.push(args.length - 7);
            }
            return target.eval(script, ...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const [{ MessageStore }, { createMessagingDomain }] = await Promise.all([
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../dist/domains/messaging/messaging-service.js'),
    ]);
    const service = createMessagingDomain({ messageStore: new MessageStore(), redis: instrumentedRedis });
    const ctx = { pluginInstanceId: `inst-bounded-${Date.now()}` };
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: ctx.pluginInstanceId,
      threadId: `thread-bounded-${Date.now()}`,
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true },
    });
    const { subscriptionId } = await service.subscribe(ctx, handleId);
    for (let index = 0; index < 40; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.send(ctx, {
        address: { kind: 'thread_handle', handle: handleId },
        idempotencyKey: `bounded-redis-${index}`,
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [{ elementId: `el-${index}`, kind: 'text', payload: { text: `message ${index}` } }],
        },
      });
    }

    const first = await service.snapshotPage(ctx, { subscriptionId, maxItems: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(appendEvalItemCounts.length > 1, 'frozen rows must not cross Redis in one all-items Lua call');
    assert.ok(appendEvalItemCounts.every((count) => count > 0 && count <= 16));
    assert.equal(
      appendEvalItemCounts.reduce((sum, count) => sum + count, 0),
      40,
      'every source row must be staged without truncation',
    );
  });
});
