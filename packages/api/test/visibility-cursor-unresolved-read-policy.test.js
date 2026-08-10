/**
 * #1224/#3444 unresolved read-anchor contracts.
 *
 * Generic pagination deliberately rescans from the visibility origin when a
 * legacy v1 anchor has lost both its message hash and ZSET membership (FM-3).
 * State-bearing consumers must opt out of that at-least-once fallback: treating
 * an unresolvable read/seen anchor as "no cursor" resurrects history as unread,
 * freshness, or a false operator reply.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const USER_ID = 'unresolved-read-policy-user';
const CAT_ID = 'codex-sol';
const UNRESOLVABLE_V1 = '0000000000000001-000001-fully-pruned';
const MALFORMED_V2 = 'v2:not-canonical:legacy-corruption';

describe('#3444 unresolved visibility read-anchor policy', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let messageStore;
  let RedisMessageStore;
  let RedisThreadReadStateStore;
  let DeliveryCursorStore;
  let SessionStore;
  let ThreadUnseenChecker;
  let ThreadStore;
  let collectDutyBriefingInput;
  let cursorFor;
  let threadsRoutes;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'visibility cursor unresolved read policy');
    const redisUtils = await import('@cat-cafe/shared/utils');
    ({ RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'));
    ({ RedisThreadReadStateStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'
    ));
    ({ DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js'));
    ({ ThreadUnseenChecker } = await import('../dist/domains/cats/services/freshness/ThreadUnseenChecker.js'));
    ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
    ({ collectDutyBriefingInput } = await import(
      '../dist/domains/cats/services/duty-briefing/collectDutyBriefingInput.js'
    ));
    ({ cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js'));
    ({ threadsRoutes } = await import('../dist/routes/threads.js'));
    SessionStore = redisUtils.SessionStore;
    redis = redisUtils.createRedisClient({
      url: REDIS_URL,
      keyPrefix: `test-unresolved-read-policy-${Date.now()}:`,
    });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    messageStore = new RedisMessageStore(redis, { ttlSeconds: null });
  });

  async function appendMessage({ threadId, catId, content, timestamp, mentionsUser = false }) {
    return messageStore.append({
      userId: USER_ID,
      catId,
      content,
      mentions: [],
      mentionsUser,
      timestamp,
      threadId,
    });
  }

  const durableCursorNamespaces = [
    {
      name: 'delivery',
      set: (store, threadId, cursor) => store.setDeliveryCursor(USER_ID, CAT_ID, threadId, cursor),
      get: (store, threadId) => store.getDeliveryCursor(USER_ID, CAT_ID, threadId),
      ack: (store, threadId, cursor) => store.ackCursor(USER_ID, CAT_ID, threadId, cursor),
    },
    {
      name: 'mention',
      set: (store, threadId, cursor) => store.setMentionAckCursor(USER_ID, CAT_ID, threadId, cursor),
      get: (store, threadId) => store.getMentionAckCursor(USER_ID, CAT_ID, threadId),
      ack: (store, threadId, cursor) => store.ackMentionCursor(USER_ID, CAT_ID, threadId, cursor),
    },
    {
      name: 'seen',
      set: (store, threadId, cursor) => store.setSeenCursor(USER_ID, CAT_ID, threadId, cursor),
      get: (store, threadId) => store.getSeenCursor(USER_ID, CAT_ID, threadId),
      ack: (store, threadId, cursor) => store.ackSeenCursor(USER_ID, CAT_ID, threadId, cursor),
    },
  ];

  for (const namespace of durableCursorNamespaces) {
    it(`${namespace.name}: canonicalizer failure fails closed without repairing or regressing durable state`, async () => {
      const threadId = `${namespace.name}-canonicalizer-failure-${Date.now()}`;
      const incoming = await appendMessage({
        threadId,
        catId: 'opus',
        content: 'older incoming boundary',
        timestamp: Date.now() - 2_000,
      });
      const storedAhead = await appendMessage({
        threadId,
        catId: 'sonnet',
        content: 'newer durable boundary',
        timestamp: Date.now() - 1_000,
      });
      assert.ok(storedAhead.id > incoming.id, 'test requires the durable v1 cursor to be ahead');

      const sessionStore = new SessionStore(redis);
      assert.equal(await namespace.set(sessionStore, threadId, storedAhead.id), true);
      const cursorStore = new DeliveryCursorStore(sessionStore, async () => {
        throw new Error('transient canonicalizer failure');
      });

      await assert.rejects(namespace.ack(cursorStore, threadId, cursorFor(incoming)), {
        code: 'UNRESOLVED_VISIBILITY_CURSOR',
      });

      assert.equal(await namespace.get(sessionStore, threadId), storedAhead.id);
    });

    it(`${namespace.name}: a proven-pruned durable cursor remains repairable by new canonical evidence`, async () => {
      const threadId = `${namespace.name}-proven-pruned-${Date.now()}`;
      const incoming = await appendMessage({
        threadId,
        catId: 'opus',
        content: 'new canonical evidence',
        timestamp: Date.now(),
      });
      const sessionStore = new SessionStore(redis);
      assert.equal(await namespace.set(sessionStore, threadId, UNRESOLVABLE_V1), true);
      const cursorStore = new DeliveryCursorStore(sessionStore, async (cursor) => cursor);

      await namespace.ack(cursorStore, threadId, cursorFor(incoming));

      const persisted = await namespace.get(sessionStore, threadId);
      assert.ok(persisted);
      assert.notEqual(persisted, UNRESOLVABLE_V1);
      assert.equal(await messageStore.canonicalizeCursor(persisted, threadId), cursorFor(incoming));
    });
  }

  it('Unread fallback: an unresolvable persisted read anchor does not resurrect thread history', async () => {
    const threadId = `unread-unresolved-${Date.now()}`;
    await appendMessage({ threadId, catId: 'opus', content: 'old cat message A', timestamp: Date.now() - 2_000 });
    await appendMessage({ threadId, catId: 'sonnet', content: 'old cat message B', timestamp: Date.now() - 1_000 });

    const readStateStore = new RedisThreadReadStateStore(redis);
    assert.equal(await readStateStore.ack(USER_ID, threadId, UNRESOLVABLE_V1), true);

    // Deliberately omit the Redis-native unread projection to exercise the
    // IMessageStore fallback contract accepted by RedisThreadReadStateStore.
    const fallbackMessageStore = {
      getByThreadAfter: messageStore.getByThreadAfter.bind(messageStore),
    };
    assert.deepEqual(await readStateStore.getUnreadSummaries(USER_ID, [threadId], fallbackMessageStore), [
      { threadId, unreadCount: 0, hasUserMention: false },
    ]);
  });

  it('Freshness: an unresolvable persisted seen anchor does not replay history as unseen', async () => {
    const threadId = `freshness-unresolved-${Date.now()}`;
    await appendMessage({ threadId, catId: null, content: 'old human message A', timestamp: Date.now() - 2_000 });
    await appendMessage({ threadId, catId: null, content: 'old human message B', timestamp: Date.now() - 1_000 });

    const sessionStore = new SessionStore(redis);
    assert.equal(await sessionStore.setSeenCursor(USER_ID, CAT_ID, threadId, UNRESOLVABLE_V1), true);
    const cursorStore = new DeliveryCursorStore(new SessionStore(redis), (messageId, tid) =>
      messageStore.canonicalizeCursor(messageId, tid),
    );
    const checker = new ThreadUnseenChecker({
      userId: USER_ID,
      cursorStore,
      messageStore,
      queueChecker: { getQueuedForThread: () => [] },
    });

    assert.equal(await checker.checkUnseen({ threadId, catId: CAT_ID }), null);
  });

  it('Freshness: a malformed persisted seen token is bounded as unresolved instead of throwing or replaying', async () => {
    const threadId = `freshness-malformed-${Date.now()}`;
    await appendMessage({ threadId, catId: null, content: 'old human history', timestamp: Date.now() - 1_000 });

    const sessionStore = new SessionStore(redis);
    assert.equal(await sessionStore.setSeenCursor(USER_ID, CAT_ID, threadId, MALFORMED_V2), true);
    const cursorStore = new DeliveryCursorStore(sessionStore, (messageId, tid) =>
      messageStore.canonicalizeCursor(messageId, tid),
    );
    const checker = new ThreadUnseenChecker({
      userId: USER_ID,
      cursorStore,
      messageStore,
      queueChecker: { getQueuedForThread: () => [] },
    });

    assert.equal(await checker.checkUnseen({ threadId, catId: CAT_ID }), null);
  });

  it('Freshness: new canonical read evidence repairs an unresolvable seen slot and exposes the next tail', async () => {
    const threadId = `freshness-repair-${Date.now()}`;
    const sessionStore = new SessionStore(redis);
    assert.equal(await sessionStore.setSeenCursor(USER_ID, CAT_ID, threadId, UNRESOLVABLE_V1), true);
    const cursorStore = new DeliveryCursorStore(sessionStore, (messageId, tid) =>
      messageStore.canonicalizeCursor(messageId, tid),
    );
    const readNow = await appendMessage({
      threadId,
      catId: null,
      content: 'canonical full-read frontier',
      timestamp: Date.now() - 1_000,
    });

    await cursorStore.ackSeenCursor(USER_ID, CAT_ID, threadId, cursorFor(readNow));

    const nextTail = await appendMessage({
      threadId,
      catId: null,
      content: 'new tail after repair',
      timestamp: Date.now(),
    });
    const checker = new ThreadUnseenChecker({
      userId: USER_ID,
      cursorStore,
      messageStore,
      queueChecker: { getQueuedForThread: () => [] },
    });
    const unseen = await checker.checkUnseen({ threadId, catId: CAT_ID });

    assert.equal(unseen?.count, 1);
    assert.equal(unseen?.maxMessageId, cursorFor(nextTail));
  });

  it('Unread: a new explicit read ACK atomically supersedes an unresolvable stored anchor', async () => {
    const threadStore = new ThreadStore();
    const thread = threadStore.create(USER_ID, 'Unread repair');
    const threadId = thread.id;
    const readStateStore = new RedisThreadReadStateStore(redis);
    assert.equal(await readStateStore.ack(USER_ID, threadId, UNRESOLVABLE_V1), true);
    const readNow = await appendMessage({
      threadId,
      catId: 'opus',
      content: 'explicitly read frontier',
      timestamp: Date.now(),
    });

    const app = Fastify();
    try {
      await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/read/latest`,
        headers: { 'x-cat-cafe-user': USER_ID },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        advanced: true,
        caughtUp: true,
        messageId: readNow.id,
        cursor: cursorFor(readNow),
      });
      const persisted = (await readStateStore.get(USER_ID, threadId))?.lastReadMessageId;
      assert.ok(persisted);
      assert.notEqual(persisted, UNRESOLVABLE_V1);
      assert.equal(await messageStore.canonicalizeCursor(persisted, threadId), cursorFor(readNow));
    } finally {
      await app.close();
    }
  });

  it('Mention ACK: accepted canonical evidence repairs an unresolvable durable slot', async () => {
    const threadId = `mention-repair-${Date.now()}`;
    const sessionStore = new SessionStore(redis);
    assert.equal(await sessionStore.setMentionAckCursor(USER_ID, CAT_ID, threadId, MALFORMED_V2), true);
    const cursorStore = new DeliveryCursorStore(sessionStore, (messageId, tid) =>
      messageStore.canonicalizeCursor(messageId, tid),
    );
    const mention = await appendMessage({
      threadId,
      catId: 'opus',
      content: '@codex-sol new mention evidence',
      mentionsUser: false,
      timestamp: Date.now(),
    });

    await cursorStore.ackMentionCursor(USER_ID, CAT_ID, threadId, cursorFor(mention));

    assert.notEqual(await sessionStore.getMentionAckCursor(USER_ID, CAT_ID, threadId), MALFORMED_V2);
    assert.equal(await cursorStore.getMentionAckCursor(USER_ID, CAT_ID, threadId), cursorFor(mention));
  });

  it('Duty Briefing: a pruned mention anchor does not let older operator history suppress the candidate', async () => {
    const now = Date.now();
    const threadId = `duty-unresolved-${now}`;
    await appendMessage({ threadId, catId: null, content: 'an older operator reply', timestamp: now - 2_000 });
    const mention = await appendMessage({
      threadId,
      catId: 'opus',
      content: '@co-creator pending decision',
      mentionsUser: true,
      timestamp: now - 1_000,
    });

    let pruned = false;
    const raceStore = {
      getByThread: async (...args) => {
        const tail = await messageStore.getByThread(...args);
        if (!pruned) {
          pruned = true;
          await redis.del(`msg:${mention.id}`);
          await redis.zrem(`msg:visibility:${threadId}`, mention.id);
        }
        return tail;
      },
      getByThreadAfter: messageStore.getByThreadAfter.bind(messageStore),
    };

    const input = await collectDutyBriefingInput({
      taskStore: { listByKind: async () => [] },
      invocationRecordStore: { scanAll: async () => [] },
      draftStore: { getByThread: async () => [] },
      dynamicTaskStore: { getAll: () => [] },
      threadStore: {
        list: async () => [{ id: threadId, title: 'Unresolved duty anchor', lastActiveAt: now - 500 }],
      },
      messageStore: raceStore,
      f167SnapshotProvider: async () => null,
      userId: USER_ID,
      now,
      bindingStatus: 'degraded',
    });

    assert.deepEqual(
      input.mentionCandidates.map((candidate) => candidate.messageId),
      [mention.id],
    );
  });

  it('Generic pagination keeps the FM-3 rescan default for an unresolvable v1 anchor', async () => {
    const threadId = `generic-rescan-${Date.now()}`;
    const first = await appendMessage({ threadId, catId: null, content: 'first', timestamp: Date.now() - 2_000 });
    const second = await appendMessage({ threadId, catId: null, content: 'second', timestamp: Date.now() - 1_000 });

    assert.deepEqual(
      (await messageStore.getByThreadAfter(threadId, UNRESOLVABLE_V1, undefined, USER_ID)).map((message) => message.id),
      [first.id, second.id],
    );
  });

  it('Malformed tokens remain strict for generic pagination but state projections fail closed to empty', async () => {
    const threadId = `malformed-policy-${Date.now()}`;
    await appendMessage({ threadId, catId: null, content: 'history', timestamp: Date.now() });

    await assert.rejects(messageStore.getByThreadAfter(threadId, MALFORMED_V2, undefined, USER_ID), /Malformed v2/);
    assert.deepEqual(
      await messageStore.getByThreadAfter(threadId, MALFORMED_V2, undefined, USER_ID, {
        unresolvedCursorPolicy: 'empty',
      }),
      [],
    );
  });
});
