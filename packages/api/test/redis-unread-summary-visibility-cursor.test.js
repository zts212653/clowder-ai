import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe:unread-visibility-cursor-test:';

describe('Redis unread summary visibility cursor contract', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let RedisThreadReadStateStore;
  let createRedisClient;
  let createFreshnessClosure;
  let scanFreshnessClosurePreflight;
  let threadsRoutes;
  let ThreadStore;
  let redis;
  let messageStore;
  let readStateStore;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Redis unread summary visibility cursor contract');
    [
      { RedisMessageStore },
      { RedisThreadReadStateStore },
      { createRedisClient },
      { createFreshnessClosure },
      { scanFreshnessClosurePreflight },
      { threadsRoutes },
      { ThreadStore },
    ] = await Promise.all([
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'),
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/freshness/FreshnessClosureStateMachine.js'),
      import('../dist/domains/cats/services/freshness/FreshnessClosurePreflight.js'),
      import('../dist/routes/threads.js'),
      import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    ]);
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    messageStore = new RedisMessageStore(redis, { ttlSeconds: null });
    readStateStore = new RedisThreadReadStateStore(redis);
  });

  async function appendVisibilityInversion(threadId, userId) {
    const baseTs = Date.now() - 10_000;
    const c = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'C: visible first with the later raw id',
      mentions: [],
      timestamp: baseTs + 200,
      threadId,
    });
    const q = await messageStore.append({
      userId,
      catId: 'codex',
      content: 'Q: visible second with the earlier raw id',
      mentions: [],
      timestamp: baseTs + 100,
      threadId,
      deliveryStatus: 'queued',
    });

    assert.ok(q.id < c.id, 'fixture must invert raw-id order relative to visibility order');
    const latest = await messageStore.getLatestVisibleCursor(threadId);
    assert.equal(latest?.messageId, q.id, 'Q must be the visibility-domain latest message');
    return { baseTs, c, q, latest };
  }

  async function appendTerminalManagedHold(threadId, { ownerUserId, hiddenTrigger = false, suffix, timestamp }) {
    const custody = {
      version: 1,
      entryId: `entry-${suffix}`,
      revision: 1,
      ownerUserId,
      intent: 'managed command wake',
      status: 'queued',
      allTargetCats: ['opus5'],
      pendingTargetCats: ['opus5'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const message = await messageStore.append({
      userId: 'scheduler',
      catId: null,
      content: `managed command ${suffix}`,
      mentions: [],
      timestamp,
      threadId,
      deliveryStatus: 'queued',
      queueCustody: custody,
      ...(hiddenTrigger ? { extra: { scheduler: { hiddenTrigger: true } } } : {}),
      source: {
        connector: 'hold-ball',
        label: '持球结果',
        icon: '🏓',
        meta: { taskId: `task-${suffix}`, threadId, catId: 'opus5', wakeWhen: true },
      },
    });
    const transitioned = await messageStore.transitionQueueCustody(message.id, {
      expectedRevision: 1,
      next: {
        ...custody,
        revision: 2,
        status: 'terminal',
        pendingTargetCats: [],
        failedByCatIds: ['opus5'],
        updatedAt: timestamp + 1,
      },
      deliveredAt: timestamp + 1,
    });
    assert.equal(transitioned.kind, 'updated');
    return transitioned.message;
  }

  async function createInvalidAnchorFixture(kind, suffix) {
    const userId = 'alice';
    const threadStore = new ThreadStore();
    const thread = threadStore.create(userId, `managed-hold anchor ${suffix}`);
    const base = Date.now() - 20_000;
    const primary = await messageStore.append({
      userId,
      catId: 'opus',
      content: `valid primary ${suffix}`,
      mentions: [],
      timestamp: base,
      threadId: thread.id,
    });
    const incoming = await appendTerminalManagedHold(thread.id, {
      ownerUserId: userId,
      suffix: `${suffix}-incoming`,
      timestamp: base + 2_000,
    });
    const invalid = await appendTerminalManagedHold(thread.id, {
      ownerUserId: kind === 'foreign' ? 'bob' : kind === 'ownerless' ? undefined : userId,
      hiddenTrigger: kind === 'hidden',
      suffix: `${suffix}-${kind}`,
      timestamp: base + 4_000,
    });
    const invalidCursor = await messageStore.canonicalizeCursor(invalid.id, thread.id);
    const incomingCursor = await messageStore.canonicalizeCursor(incoming.id, thread.id);
    assert.ok(invalidCursor.startsWith('v2:'));
    assert.ok(incomingCursor.startsWith('v2:'));
    assert.equal(await readStateStore.ack(userId, thread.id, primary.id, invalidCursor), true);
    return { userId, threadStore, thread, primary, incoming, invalid, invalidCursor, incomingCursor };
  }

  async function createValidLaterAnchorFixture(suffix) {
    const userId = 'alice';
    const threadStore = new ThreadStore();
    const thread = threadStore.create(userId, `managed-hold valid anchor ${suffix}`);
    const base = Date.now() - 20_000;
    const primary = await messageStore.append({
      userId,
      catId: 'opus',
      content: `valid legacy primary ${suffix}`,
      mentions: [],
      timestamp: base,
      threadId: thread.id,
    });
    const incoming = await appendTerminalManagedHold(thread.id, {
      ownerUserId: userId,
      suffix: `${suffix}-incoming`,
      timestamp: base + 2_000,
    });
    const anchor = await appendTerminalManagedHold(thread.id, {
      ownerUserId: userId,
      suffix: `${suffix}-anchor`,
      timestamp: base + 4_000,
    });
    const primaryCursor = await messageStore.canonicalizeCursor(primary.id, thread.id);
    const incomingCursor = await messageStore.canonicalizeCursor(incoming.id, thread.id);
    const anchorCursor = await messageStore.canonicalizeCursor(anchor.id, thread.id);
    assert.ok(primaryCursor.startsWith('v2:'));
    assert.ok(incomingCursor.startsWith('v2:'));
    assert.ok(anchorCursor.startsWith('v2:'));
    assert.equal(await readStateStore.ack(userId, thread.id, primary.id, anchorCursor), true);
    return {
      userId,
      threadStore,
      thread,
      primary,
      primaryCursor,
      incoming,
      incomingCursor,
      anchor,
      anchorCursor,
    };
  }

  async function invokeReadProducer(routeKind, fixture) {
    const app = Fastify();
    await app.register(threadsRoutes, {
      threadStore: fixture.threadStore,
      messageStore,
      readStateStore,
    });
    await app.ready();
    try {
      if (routeKind === 'patch') {
        return await app.inject({
          method: 'PATCH',
          url: `/api/threads/${fixture.thread.id}/read`,
          headers: { 'x-cat-cafe-user': fixture.userId, 'content-type': 'application/json' },
          payload: { upToMessageId: fixture.incoming.id },
        });
      }
      if (routeKind === 'latest') {
        return await app.inject({
          method: 'POST',
          url: `/api/threads/${fixture.thread.id}/read/latest`,
          headers: { 'x-cat-cafe-user': fixture.userId },
        });
      }
      return await app.inject({
        method: 'POST',
        url: '/api/threads/read/mark-all',
        headers: { 'x-cat-cafe-user': fixture.userId },
      });
    } finally {
      await app.close();
    }
  }

  it('does not resurrect an older visible message after a v1 read cursor', async () => {
    const userId = 'user-v1';
    const threadId = 'thread-v1-visibility-inversion';
    const { q } = await appendVisibilityInversion(threadId, userId);

    assert.equal(await readStateStore.ack(userId, threadId, q.id), true);

    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 0, hasUserMention: false },
    ]);
  });

  it('counts messages appended after a v2 read cursor', async () => {
    const userId = 'user-v2';
    const threadId = 'thread-v2-visibility-inversion';
    const { baseTs, latest } = await appendVisibilityInversion(threadId, userId);
    assert.ok(latest?.cursor.startsWith('v2:'), 'fixture must expose a canonical v2 cursor');
    assert.equal(await readStateStore.ack(userId, threadId, latest.cursor), true);

    await messageStore.append({
      userId,
      catId: 'opus',
      content: 'D: genuinely unread after the v2 cursor',
      mentions: [],
      timestamp: baseTs + 300,
      threadId,
    });

    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);
  });

  it('includes a late-visible message when the raw closure frontier is unchanged', async () => {
    const userId = 'user-closure';
    const threadId = 'thread-closure-visibility-inversion';
    const origin = await messageStore.append({
      userId,
      catId: null,
      content: 'origin request',
      mentions: ['codex-sol'],
      timestamp: Date.now() - 20_000,
      threadId,
    });
    const { c, q } = await appendVisibilityInversion(threadId, userId);
    const closure = createFreshnessClosure({
      id: 'closure-redis-visibility-inversion',
      userId,
      threadId,
      catId: 'codex-sol',
      invocationId: 'invocation-redis-visibility-inversion',
      turnInvocationId: 'invocation-redis-visibility-inversion',
      originTriggerMessageId: origin.id,
      draftContent: 'answer before Q became visible',
      requiredMessageIds: [c.id],
      requiredFrontierMessageId: c.id,
      observedRawFrontierMessageId: c.id,
      now: Date.now(),
    });

    const result = await scanFreshnessClosurePreflight({ closure, messageStore });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(result.requiredMessageIds, [q.id, c.id]);
    assert.equal(result.observedRawFrontierMessageId, c.id);
  });

  // #1304 reopened: rollout-gated primary cursors can be pruned, but the
  // canonical visibility anchor must still preserve genuinely later unread.
  it('keeps later unread messages after the primary read cursor is pruned', async () => {
    const userId = 'user-stale-cursor';
    const threadId = 'thread-stale-cursor';

    const msg = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'message that will be pruned',
      mentions: [],
      timestamp: Date.now() - 5_000,
      threadId,
    });
    await messageStore.append({
      userId,
      catId: 'codex',
      content: 'later message still visible',
      mentions: [],
      timestamp: Date.now() - 1_000,
      threadId,
    });

    // Persist the rollout-gated v1 primary plus its durable v2 anchor.
    const canonicalCursor = await messageStore.canonicalizeCursor(msg.id, threadId);
    assert.ok(canonicalCursor.startsWith('v2:'));
    assert.equal(await readStateStore.ack(userId, threadId, msg.id, canonicalCursor), true);
    // Verify 0 unread before pruning
    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);

    // Prune the acked message: delete hash + ZREM from visibility ZSET
    await redis.del(`msg:${msg.id}`);
    await redis.zrem(`msg:visibility:${threadId}`, msg.id);

    // The pruned primary must not erase the position of the durable anchor.
    assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [threadId], messageStore), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);
  });

  it('advances from a pruned primary by comparing against its durable anchor', async () => {
    const userId = 'user-pruned-primary-advance';
    const threadId = 'thread-pruned-primary-advance';
    const first = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'first read message',
      mentions: [],
      timestamp: Date.now() - 2_000,
      threadId,
    });
    const firstCursor = await messageStore.canonicalizeCursor(first.id, threadId);
    assert.equal(await readStateStore.ack(userId, threadId, first.id, firstCursor), true);

    await redis.del(`msg:${first.id}`);
    await redis.zrem(`msg:visibility:${threadId}`, first.id);

    const later = await messageStore.append({
      userId,
      catId: 'codex-sol',
      content: 'later visible message',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const laterCursor = await messageStore.canonicalizeCursor(later.id, threadId);

    assert.equal(await readStateStore.ack(userId, threadId, later.id, laterCursor), true);
    const state = await readStateStore.get(userId, threadId);
    assert.equal(state.lastReadMessageId, later.id);
    assert.equal(state.lastReadVisibilityCursor, laterCursor);
  });

  it('read/latest repairs a legacy stale primary, then preserves a genuinely new unread message', async () => {
    const userId = 'user-read-latest-repair';
    const threadStore = new ThreadStore();
    const thread = threadStore.create(userId, 'Reopened #1304 integration');
    const latest = await messageStore.append({
      userId,
      catId: 'opus',
      content: 'latest message the user opens',
      mentions: [],
      timestamp: Date.now() - 1_000,
      threadId: thread.id,
    });
    assert.equal(await readStateStore.ack(userId, thread.id, '0000000000000001-pruned-legacy'), true);

    const app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${thread.id}/read/latest`,
        headers: { 'x-cat-cafe-user': userId },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().advanced, true);
      assert.equal(response.json().caughtUp, true);

      const repaired = await readStateStore.get(userId, thread.id);
      assert.equal(repaired.lastReadMessageId, latest.id);
      assert.ok(repaired.lastReadVisibilityCursor?.startsWith('v2:'));

      await messageStore.append({
        userId,
        catId: 'codex-sol',
        content: 'genuinely new unread message',
        mentions: [],
        timestamp: Date.now(),
        threadId: thread.id,
      });
      assert.deepEqual(await readStateStore.getUnreadSummaries(userId, [thread.id], messageStore), [
        { threadId: thread.id, unreadCount: 1, hasUserMention: false },
      ]);
    } finally {
      await app.close();
    }
  });

  it('unread projection ignores an ineligible anchor and falls back to the valid primary', async (t) => {
    for (const boundary of ['foreign', 'hidden', 'ownerless']) {
      await t.test(`${boundary} anchor`, async () => {
        await cleanupClientKeyspace(redis);
        messageStore = new RedisMessageStore(redis, { ttlSeconds: null });
        readStateStore = new RedisThreadReadStateStore(redis);
        const fixture = await createInvalidAnchorFixture(boundary, `unread-${boundary}`);

        assert.deepEqual(await readStateStore.getUnreadSummaries(fixture.userId, [fixture.thread.id], messageStore), [
          { threadId: fixture.thread.id, unreadCount: 1, hasUserMention: false },
        ]);
      });
    }
  });

  it('unread projection rejects a non-canonical anchor even when its message is owner-visible', async () => {
    const fixture = await createInvalidAnchorFixture('foreign', 'unread-non-canonical');
    await redis.hset(
      `read-state:${fixture.userId}:${fixture.thread.id}`,
      'lastReadVisibilityCursor',
      fixture.incoming.id,
    );

    assert.deepEqual(await readStateStore.getUnreadSummaries(fixture.userId, [fixture.thread.id], messageStore), [
      { threadId: fixture.thread.id, unreadCount: 1, hasUserMention: false },
    ]);
  });

  it('repairs foreign, hidden, and ownerless durable anchors across every route and activation mode', async (t) => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    try {
      for (const gate of ['on', 'off']) {
        for (const routeKind of ['patch', 'latest', 'mark-all']) {
          for (const boundary of ['foreign', 'hidden', 'ownerless']) {
            await t.test(`${gate} ${routeKind} ${boundary} anchor`, async () => {
              await cleanupClientKeyspace(redis);
              messageStore = new RedisMessageStore(redis, { ttlSeconds: null });
              readStateStore = new RedisThreadReadStateStore(redis);
              if (gate === 'on') process.env.VISIBILITY_CURSOR_V2 = 'on';
              else delete process.env.VISIBILITY_CURSOR_V2;

              const fixture = await createInvalidAnchorFixture(boundary, `${gate}-${routeKind}-${boundary}`);
              const response = await invokeReadProducer(routeKind, fixture);

              assert.equal(response.statusCode, 200);
              if (routeKind === 'mark-all') {
                assert.equal(response.json().advancedCount, 1);
              } else {
                assert.equal(response.json().advanced, true);
                assert.equal(response.json().caughtUp, true);
              }
              const repaired = await readStateStore.get(fixture.userId, fixture.thread.id);
              assert.ok(repaired.lastReadMessageId.includes(fixture.incoming.id));
              assert.equal(repaired.lastReadVisibilityCursor, fixture.incomingCursor);
              assert.ok(!repaired.lastReadVisibilityCursor.includes(fixture.invalid.id));
            });
          }
        }
      }
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
  });

  it('preserves a later valid durable anchor while normalizing a legacy primary', async (t) => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      for (const routeKind of ['patch', 'latest', 'mark-all']) {
        await t.test(routeKind, async () => {
          await cleanupClientKeyspace(redis);
          messageStore = new RedisMessageStore(redis, { ttlSeconds: null });
          readStateStore = new RedisThreadReadStateStore(redis);
          const fixture = await createValidLaterAnchorFixture(`valid-later-${routeKind}`);
          if (routeKind !== 'patch') {
            const deleted = await messageStore.softDelete(fixture.anchor.id, fixture.userId);
            assert.ok(deleted?.deletedAt, 'the later anchor must remain canonical but leave the live timeline');
          }

          const response = await invokeReadProducer(routeKind, fixture);

          assert.equal(response.statusCode, 200);
          if (routeKind === 'mark-all') {
            assert.equal(response.json().advancedCount, 0);
          } else {
            assert.equal(response.json().advanced, false);
            assert.equal(response.json().caughtUp, true);
          }
          const preserved = await readStateStore.get(fixture.userId, fixture.thread.id);
          assert.equal(preserved.lastReadMessageId, fixture.primaryCursor);
          assert.equal(preserved.lastReadVisibilityCursor, fixture.anchorCursor);
          assert.deepEqual(await readStateStore.getUnreadSummaries(fixture.userId, [fixture.thread.id], messageStore), [
            { threadId: fixture.thread.id, unreadCount: 0, hasUserMention: false },
          ]);
        });
      }
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
  });

  it('reloads after an anchor-only CAS race before repairing the whole coordinate', async () => {
    const savedGate = process.env.VISIBILITY_CURSOR_V2;
    process.env.VISIBILITY_CURSOR_V2 = 'on';
    try {
      const fixture = await createInvalidAnchorFixture('foreign', 'anchor-only-cas-race');
      const concurrent = await appendTerminalManagedHold(fixture.thread.id, {
        ownerUserId: fixture.userId,
        hiddenTrigger: true,
        suffix: 'anchor-only-cas-race-concurrent-hidden',
        timestamp: Date.now() - 5_000,
      });
      const concurrentCursor = await messageStore.canonicalizeCursor(concurrent.id, fixture.thread.id);
      const originalReplace = readStateStore.replaceReadCoordinateIfEqual.bind(readStateStore);
      let replaceCalls = 0;
      readStateStore.replaceReadCoordinateIfEqual = async (...args) => {
        replaceCalls++;
        if (replaceCalls === 1) {
          await readStateStore.ack(fixture.userId, fixture.thread.id, fixture.primary.id, concurrentCursor);
        }
        return originalReplace(...args);
      };

      const response = await invokeReadProducer('patch', fixture);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { advanced: true, caughtUp: true });
      assert.equal(replaceCalls, 2, 'anchor-only race must reject stale CAS and revalidate once');
      const repaired = await readStateStore.get(fixture.userId, fixture.thread.id);
      assert.ok(repaired.lastReadMessageId.includes(fixture.incoming.id));
      assert.equal(repaired.lastReadVisibilityCursor, fixture.incomingCursor);
    } finally {
      if (savedGate === undefined) delete process.env.VISIBILITY_CURSOR_V2;
      else process.env.VISIBILITY_CURSOR_V2 = savedGate;
    }
  });
});
