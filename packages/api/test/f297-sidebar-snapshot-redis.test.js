import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe:f297-sidebar-snapshot-test:';

describe('F297 Redis-backed Sidebar snapshot identity', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let app;
  let createRedisClient;
  let RedisMessageStore;
  let RedisThreadReadStateStore;
  let RedisThreadStore;
  let redis;
  let threadsRoutes;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F297 Redis-backed Sidebar snapshot identity');
    [
      { createRedisClient },
      { RedisMessageStore },
      { RedisThreadReadStateStore },
      { RedisThreadStore },
      { threadsRoutes },
    ] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js'),
      import('../dist/routes/threads.js'),
    ]);
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (app) await app.close();
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (app) await app.close();
    app = undefined;
    await cleanupClientKeyspace(redis);
  });

  it('returns 304 for two unchanged compositions from real Redis stores', async () => {
    const threadStore = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const messageStore = new RedisMessageStore(redis, { ttlSeconds: null });
    const readStateStore = new RedisThreadReadStateStore(redis);
    // Start the measured window after the canonical default row's lazy creation;
    // the contract under test is byte stability while owner truth is unchanged.
    await threadStore.get('default');
    const firstThread = await threadStore.create('alice', 'Redis snapshot A', '/projects/cat-cafe');
    const secondThread = await threadStore.create('alice', 'Redis snapshot B', '/projects/cat-cafe');
    await threadStore.addParticipants(firstThread.id, ['codex-sol', 'opus5']);
    await threadStore.updateLabels(firstThread.id, ['needs-me', 'performance']);
    await threadStore.updatePin(firstThread.id, true);
    await threadStore.updatePreferredCats(secondThread.id, ['opus5']);

    const baseTimestamp = Date.now() - 10_000;
    await messageStore.append({
      userId: 'alice',
      catId: 'opus5',
      content: 'unread redis-backed message',
      mentions: ['codex-sol'],
      mentionsUser: true,
      timestamp: baseTimestamp,
      threadId: firstThread.id,
    });
    await messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      content: 'second redis-backed message',
      mentions: [],
      timestamp: baseTimestamp + 1,
      threadId: secondThread.id,
    });

    const presenceSource = {
      async getPresence(threadIds) {
        return new Map(
          threadIds.map((threadId) => [
            threadId,
            threadId === firstThread.id
              ? { status: 'working', cats: ['opus5'], activeSince: baseTimestamp }
              : { status: 'idle' },
          ]),
        );
      },
    };
    app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore, presenceSource });
    await app.ready();

    const request = (etag) =>
      app.inject({
        method: 'GET',
        url: '/api/threads?view=sidebar',
        headers: {
          'x-cat-cafe-user': 'alice',
          ...(etag ? { 'if-none-match': etag } : {}),
        },
      });

    const first = await request();
    assert.equal(first.statusCode, 200);
    assert.match(first.headers.etag, /^"[^"]+"$/);
    const firstPayload = JSON.parse(first.body);
    assert.ok(firstPayload.threads.some((thread) => thread.id === firstThread.id));
    assert.ok(firstPayload.threads.some((thread) => thread.id === secondThread.id));
    const hydratedFirst = firstPayload.threads.find((thread) => thread.id === firstThread.id);
    assert.ok(Object.hasOwn(hydratedFirst, 'unreadCount'));
    assert.ok(Object.hasOwn(hydratedFirst, 'hasUserMention'));
    assert.equal(hydratedFirst.presence.status, 'working');

    const unchanged = await request(first.headers.etag);
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, '');
    assert.equal(unchanged.headers.etag, first.headers.etag);

    const repeatedBody = await request();
    assert.equal(repeatedBody.statusCode, 200);
    assert.equal(repeatedBody.headers.etag, first.headers.etag);
    assert.equal(repeatedBody.body, first.body, 'unchanged Redis hydration must serialize to identical bytes');
  });
});
