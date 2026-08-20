/**
 * #1224/#3444 consumer contracts (Group A3/A4).
 *
 * A3 pins the durable-boundary rule: unresolved raw IDs and mixed-format
 * invocation boundaries must fail loudly instead of being mistaken for
 * equality by compareCursors().
 *
 * A4 exercises the three user-visible sinks against the real cursor stores:
 * Context Briefing tail-only continuation, Freshness no-new/thread isolation,
 * and /read/latest caughtUp truth under visibility inversion.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const { assembleIncrementalContext, upsertMaxBoundary } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { ThreadUnseenChecker } = await import('../dist/domains/cats/services/freshness/ThreadUnseenChecker.js');
const { cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { visibilityCursorUnresolvedMutation } = await import('../dist/infrastructure/telemetry/instruments.js');

const USER_ID = 'visibility-contract-user';
const CAT_ID = 'opus';

function withActivation(value) {
  const saved = process.env.VISIBILITY_CURSOR_V2;
  if (value === undefined) delete process.env.VISIBILITY_CURSOR_V2;
  else process.env.VISIBILITY_CURSOR_V2 = value;
  return () => {
    if (saved === undefined) delete process.env.VISIBILITY_CURSOR_V2;
    else process.env.VISIBILITY_CURSOR_V2 = saved;
  };
}

describe('#3444 A3 durable cursor guards', () => {
  it('rejects a raw ID entering the deferred visibility-boundary slot', () => {
    const boundaries = new Map();
    assert.throws(
      () => upsertMaxBoundary(boundaries, CAT_ID, '0000000000000001-000001-legacy'),
      /CANONICAL_VISIBILITY_CURSOR_REQUIRED/,
    );
    assert.equal(boundaries.size, 0, 'invalid boundary must not be retained');
  });

  it('rejects malformed v2 ingress before it can become durable state', async () => {
    const store = new DeliveryCursorStore(undefined, async (messageId) => messageId);
    await assert.rejects(
      store.ackCursor(USER_ID, CAT_ID, 'thread-a3-malformed', 'v2:not-a-canonical-sequence:message-id'),
      /Malformed v2 cursor/,
    );
  });

  for (const slot of [
    { name: 'delivery', ack: (store, id) => store.ackCursor(USER_ID, CAT_ID, 'thread-a3', id) },
    { name: 'mention', ack: (store, id) => store.ackMentionCursor(USER_ID, CAT_ID, 'thread-a3', id) },
    { name: 'seen', ack: (store, id) => store.ackSeenCursor(USER_ID, CAT_ID, 'thread-a3', id) },
  ]) {
    it(`${slot.name}: unresolved raw ingress fails loudly instead of creating a cursor slot`, async () => {
      const unresolvedCanonicalizer = async (messageId) => messageId;
      const store = new DeliveryCursorStore(undefined, unresolvedCanonicalizer);

      await assert.rejects(slot.ack(store, 'fully-pruned-or-foreign-message-id'), /UNRESOLVED_VISIBILITY_CURSOR/);
    });
  }

  it('exports an operational counter for unresolved durable cursor mutations', () => {
    assert.equal(typeof visibilityCursorUnresolvedMutation?.add, 'function');
    assert.doesNotThrow(() => visibilityCursorUnresolvedMutation.add(1));
  });
});

const REDIS_URL = process.env.REDIS_URL;

describe('#3444 A4 source-to-sink contracts (requires Redis)', () => {
  let redis;
  let redisAvailable = false;
  let SessionStore;
  let RedisMessageStore;
  let RedisThreadReadStateStore;
  let ThreadStore;
  let threadsRoutes;
  let VISIBILITY_RESOLVE_SEQ_LUA;

  before(async () => {
    if (redisIsolationSkipReason(REDIS_URL)) return;
    assertRedisIsolationOrThrow(REDIS_URL, 'visibility-cursor-consumer-contracts');

    const redisUtils = await import('@cat-cafe/shared/utils');
    const redisMessages = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const redisReadState = await import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js');
    const threadPorts = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadRoutes = await import('../dist/routes/threads.js');

    SessionStore = redisUtils.SessionStore;
    VISIBILITY_RESOLVE_SEQ_LUA = redisUtils.VISIBILITY_RESOLVE_SEQ_LUA;
    RedisMessageStore = redisMessages.RedisMessageStore;
    RedisThreadReadStateStore = redisReadState.RedisThreadReadStateStore;
    ThreadStore = threadPorts.ThreadStore;
    threadsRoutes = threadRoutes.threadsRoutes;

    redis = redisUtils.createRedisClient({
      url: REDIS_URL,
      keyPrefix: `test-visibility-consumer-${Date.now()}:`,
    });
    await redis.ping();
    redisAvailable = true;
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  async function appendUserMessage(messageStore, threadId, content, timestamp) {
    return messageStore.append({
      userId: USER_ID,
      catId: null,
      content,
      mentions: [],
      timestamp,
      threadId,
    });
  }

  function makeCursorStore(messageStore) {
    return new DeliveryCursorStore(new SessionStore(redis), (messageId, threadId) =>
      messageStore.canonicalizeCursor(messageId, threadId),
    );
  }

  async function commitDeferredDeliveryBoundary(cursorStore, threadId, incremental) {
    const boundaries = new Map();
    if (incremental.boundaryId) {
      upsertMaxBoundary(boundaries, CAT_ID, incremental.boundaryId);
    }
    for (const [catId, boundaryId] of boundaries) {
      await cursorStore.ackCursor(USER_ID, catId, threadId, boundaryId);
    }
    return boundaries;
  }

  it('shared Lua cursor resolver owns its ARGV contract instead of host-script locals', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }

    const threadId = `lua-fragment-${Date.now()}`;
    const messageStore = new RedisMessageStore(redis);
    const message = await appendUserMessage(messageStore, threadId, 'self-contained Lua resolver', Date.now());
    const script = `
${VISIBILITY_RESOLVE_SEQ_LUA}
local seq, id = resolveSeq(ARGV[1])
return { seq or -1, id }
`;

    const [resolvedSeq, resolvedId] = await redis.eval(
      script,
      0,
      message.id,
      '0',
      redis.options?.keyPrefix ?? '',
      threadId,
    );
    assert.equal(Number(resolvedSeq), message.visibilitySeq);
    assert.equal(resolvedId, message.id);
  });

  it('Context Briefing: after delivery ACK, the next warm continuation contains only the new tail', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const restore = withActivation(undefined);
    t.after(restore);

    const threadId = `context-tail-${Date.now()}`;
    const messageStore = new RedisMessageStore(redis);
    const cursorStore = makeCursorStore(messageStore);
    const base = Date.now() - 20_000;
    const legacy = await appendUserMessage(messageStore, threadId, 'legacy anchor', base + 1);
    const oldTailA = await appendUserMessage(messageStore, threadId, 'old batch A', base + 2);
    const oldTailB = await appendUserMessage(messageStore, threadId, 'old batch B', base + 3);

    // Exact migration shape: detail hash remains live, visibilitySeq moved to
    // canonical ZSET truth only.
    await redis.hdel(`msg:${legacy.id}`, 'visibilitySeq');
    await cursorStore.ackCursor(USER_ID, CAT_ID, threadId, legacy.id);

    const deps = {
      services: {},
      invocationDeps: { threadStore: null },
      messageStore,
      deliveryCursorStore: cursorStore,
    };
    const first = await assembleIncrementalContext(deps, USER_ID, threadId, CAT_ID);
    assert.ok(first.contextText.includes(oldTailA.id));
    assert.ok(first.contextText.includes(oldTailB.id));
    assert.ok(first.boundaryId?.startsWith('v2:'), 'delivery boundary must be canonical v2');

    const firstBoundaries = await commitDeferredDeliveryBoundary(cursorStore, threadId, first);
    assert.equal(firstBoundaries.get(CAT_ID), first.boundaryId, 'real deferred boundary must be collected');
    const newTail = await appendUserMessage(messageStore, threadId, 'the only new tail', base + 4);

    const second = await assembleIncrementalContext(deps, USER_ID, threadId, CAT_ID);
    assert.ok(second.contextText.includes(newTail.id), 'new tail must be delivered');
    assert.ok(!second.contextText.includes(oldTailA.id), 'old batch A must not replay');
    assert.ok(!second.contextText.includes(oldTailB.id), 'old batch B must not replay');
    assert.deepEqual(second.exposedMessageIds, [newTail.id]);
  });

  it('Context Briefing: an unresolved legacy cursor with no new tail does not abort deferred routing', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const restore = withActivation(undefined);
    t.after(restore);

    const threadId = `context-unresolved-empty-${Date.now()}`;
    const messageStore = new RedisMessageStore(redis);
    const sessionStore = new SessionStore(redis);
    const cursorStore = makeCursorStore(messageStore);
    const unresolvedLegacyCursor = '0000000000000001-000001-fully-pruned';
    assert.equal(
      await sessionStore.setDeliveryCursor(USER_ID, CAT_ID, threadId, unresolvedLegacyCursor),
      true,
      'fixture must seed the reachable legacy durable shape',
    );

    const incremental = await assembleIncrementalContext(
      {
        services: {},
        invocationDeps: { threadStore: null },
        messageStore,
        deliveryCursorStore: cursorStore,
      },
      USER_ID,
      threadId,
      CAT_ID,
    );

    assert.equal(incremental.exposedMessageIds.length, 0);
    assert.equal(incremental.boundaryId, undefined, 'unresolved producer value must not enter deferred canonical slot');
    const boundaries = await commitDeferredDeliveryBoundary(cursorStore, threadId, incremental);
    assert.equal(boundaries.size, 0, 'no canonical evidence means no deferred mutation, not a route-level throw');
  });

  it('Context Briefing: accepted canonical context repairs an unresolved legacy slot exactly once', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const restore = withActivation(undefined);
    t.after(restore);

    const threadId = `context-unresolved-repair-${Date.now()}`;
    const messageStore = new RedisMessageStore(redis);
    const sessionStore = new SessionStore(redis);
    const cursorStore = makeCursorStore(messageStore);
    const unresolvedLegacyCursor = '0000000000000001-000001-fully-pruned';
    assert.equal(await sessionStore.setDeliveryCursor(USER_ID, CAT_ID, threadId, unresolvedLegacyCursor), true);
    const newTail = await appendUserMessage(messageStore, threadId, 'new canonical tail', Date.now());

    const deps = {
      services: {},
      invocationDeps: { threadStore: null },
      messageStore,
      deliveryCursorStore: cursorStore,
    };
    const first = await assembleIncrementalContext(deps, USER_ID, threadId, CAT_ID);
    assert.deepEqual(first.exposedMessageIds, [newTail.id]);
    assert.ok(first.boundaryId?.startsWith('v2:'));
    await commitDeferredDeliveryBoundary(cursorStore, threadId, first);

    const second = await assembleIncrementalContext(deps, USER_ID, threadId, CAT_ID);
    assert.deepEqual(second.exposedMessageIds, [], 'accepted tail must not replay after evidence repair');
  });

  it('Freshness: full read leaves no notice for A and does not consume B', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const restore = withActivation(undefined);
    t.after(restore);

    const messageStore = new RedisMessageStore(redis);
    const cursorStore = makeCursorStore(messageStore);
    const threadA = `freshness-a-${Date.now()}`;
    const threadB = `freshness-b-${Date.now()}`;
    const base = Date.now() - 10_000;
    const a1 = await appendUserMessage(messageStore, threadA, 'A initial', base + 1);
    const b1 = await appendUserMessage(messageStore, threadB, 'B initial', base + 2);
    await cursorStore.ackSeenCursor(USER_ID, CAT_ID, threadA, cursorFor(a1));
    await cursorStore.ackSeenCursor(USER_ID, CAT_ID, threadB, cursorFor(b1));

    const a2 = await appendUserMessage(messageStore, threadA, 'A unread then fully read', base + 3);
    const b2 = await appendUserMessage(messageStore, threadB, 'B remains unread', base + 4);

    // Model a complete, unfiltered thread read: consume the full delivered tail
    // and persist canonical seen evidence at its final visibility boundary.
    const fullA = await messageStore.getByThreadAfter(
      threadA,
      await cursorStore.getSeenCursor(USER_ID, CAT_ID, threadA),
      undefined,
      USER_ID,
    );
    assert.deepEqual(
      fullA.map((message) => message.id),
      [a2.id],
    );
    await cursorStore.ackSeenCursor(USER_ID, CAT_ID, threadA, cursorFor(fullA.at(-1)));

    const checker = new ThreadUnseenChecker({
      userId: USER_ID,
      cursorStore,
      messageStore,
      queueChecker: { getQueuedForThread: () => [] },
    });

    assert.equal(
      await checker.checkUnseen({ threadId: threadA, catId: CAT_ID }),
      null,
      'no newer A message means no freshness notice',
    );
    const unseenB = await checker.checkUnseen({ threadId: threadB, catId: CAT_ID });
    assert.equal(unseenB?.count, 1, 'reading A must not consume B');
    assert.ok(unseenB?.maxMessageId.includes(b2.id));
  });

  it('/read/latest reports caughtUp=true after a gate-OFF visibility inversion ACK', async (t) => {
    if (!redisAvailable) {
      t.skip('Redis not available');
      return;
    }
    const restore = withActivation(undefined);
    t.after(restore);

    const threadStore = new ThreadStore();
    const messageStore = new RedisMessageStore(redis);
    const readStateStore = new RedisThreadReadStateStore(redis);
    const thread = threadStore.create(USER_ID, 'read/latest inversion contract');
    const base = Date.now() - 5_000;

    // C is created later (higher raw ID) but visible first. Q is created
    // earlier (lower raw ID) but appended/visible later.
    const c = await appendUserMessage(messageStore, thread.id, 'C visible first', base + 200);
    const q = await appendUserMessage(messageStore, thread.id, 'Q visible later', base + 100);
    assert.ok(q.id < c.id, 'fixture must invert raw-ID and visibility order');
    assert.equal(await readStateStore.ack(USER_ID, thread.id, c.id), true);

    const app = Fastify();
    t.after(() => app.close());
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messageId, q.id, 'visibility-latest message must be Q');
    assert.equal(body.advanced, true, 'visibility-forward ACK must advance despite raw inversion');
    assert.equal(body.caughtUp, true, 'caughtUp must truthfully reflect the persisted cursor');
    assert.equal((await readStateStore.get(USER_ID, thread.id))?.lastReadMessageId, q.id);
  });
});
