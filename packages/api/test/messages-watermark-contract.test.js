import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function browserApp(t, store) {
  const app = Fastify();
  t.after(() => app.close());
  const threads = new ThreadStore();
  threads.ensureThread('thread', 'Owned').createdBy = 'owner';
  threads.ensureThread('default', 'Shared');
  await app.register(messagesRoutes, {
    messageStore: store,
    threadStore: threads,
    router: {},
    registry: {},
    socketManager: {},
  });
  return (url) => app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } });
}

async function assertBrowserFrontier(t, store, markSeenRecall, markInvalidLegacySource) {
  const get = await browserApp(t, store);
  const append = (content, patch = {}) =>
    store.append({
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      threadId: 'thread',
      content,
      mentions: [],
      timestamp: Date.now(),
      ...patch,
    });
  const frontier = () =>
    store.getLatestVisibleCursor('thread', { evidence: 'browser_timeline', viewerUserId: 'owner' });
  const first = await append('visible');
  await append('private', { userId: 'another', from: { kind: 'user', userId: 'another' } });
  await append('queued input', { deliveryStatus: 'queued' });
  await append('internal', {
    userId: 'system',
    from: { kind: 'system', service: 'routing-guard-failure' },
    source: { connector: 'routing-guard-failure', label: 'internal', icon: 'alert-triangle' },
  });
  assert.equal((await frontier()).messageId, first.id);
  const speech = await append('queued speech', {
    from: { kind: 'agent', catId: 'opus' },
    origin: 'callback',
    deliveryStatus: 'queued',
  });
  assert.equal((await frontier()).messageId, speech.id);
  const seen = await append('seen legacy recall');
  await markSeenRecall(seen);
  assert.equal((await frontier()).messageId, seen.id);
  await store.softDelete(seen.id, 'owner');
  assert.equal((await frontier()).messageId, speech.id);
  const response = await store.appendAndObservePriorFrontier({
    userId: 'owner',
    from: { kind: 'agent', catId: 'opus' },
    threadId: 'thread',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: 1100,
    lifecycle: {
      kind: 'response',
      orderKey: 'response-order',
      invocationId: 'child',
      targetId: 'opus',
      inputEntryIds: ['entry'],
      inputMessageIds: [first.id],
      status: 'processing',
      startedAt: Date.now(),
    },
  });
  assert.equal((await frontier()).messageId, speech.id);
  await Promise.all(Array.from({ length: 60 }, (_, n) => append(`newer ${n}`)));
  const baseline = (await get('/api/messages?threadId=thread&limit=50')).json().historyWatermark;
  await store.commitLifecycleResponseTerminal(response.message.id, {
    invocationId: 'child',
    status: 'completed',
    completedAt: Date.now(),
    content: 'complete',
    mentions: [],
  });
  assert.equal((await frontier()).messageId, response.message.id);
  const recovery = (
    await get(`/api/messages?threadId=thread&limit=50&afterVisibility=${encodeURIComponent(baseline)}`)
  ).json();
  assert.ok(recovery.messages.some((message) => message.id === response.message.id && message.content === 'complete'));
  assert.equal(recovery.historyWatermark, (await frontier()).cursor);
  const invalid = await append('private legacy source', { userId: 'other', from: { kind: 'user', userId: 'other' } });
  await markInvalidLegacySource(invalid);
  assert.equal((await frontier()).messageId, response.message.id);
  const page = (await get('/api/messages?threadId=thread')).json();
  assert.equal(
    page.messages.some((message) => message.id === invalid.id),
    false,
  );
  const published = await store.getByThreadAfter('thread', undefined, 1000, 'owner', {
    includeQueuedCatMessages: true,
  });
  const positions = published.map((message) => message.visibilitySeq);
  assert.equal(new Set(positions).size, positions.length);
  assert.ok(positions.every((seq, index) => index === 0 || seq > positions[index - 1]));
}

const recallFields = {
  content: '',
  deliveryStatus: 'canceled',
  _tombstone: true,
  recall: { version: 1, exposure: 'seen', recalledAt: 1000 },
};

test('Memory browser frontier contract', async (t) => {
  await assertBrowserFrontier(
    t,
    new MessageStore(),
    (message) => Object.assign(message, recallFields),
    (message) => Object.assign(message, { from: undefined, source: undefined, sourceParseFailure: true }),
  );
});

test('Redis browser frontier matches Memory', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, async (t) => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'browser frontier');
  const redis = new Redis(process.env.REDIS_URL, { keyPrefix: `issue1287-watermark:${Date.now()}:` });
  t.after(() => redis.disconnect());
  await assertBrowserFrontier(
    t,
    new RedisMessageStore(redis),
    (message) =>
      redis.hset(MessageKeys.detail(message.id), {
        content: '',
        deliveryStatus: 'canceled',
        _tombstone: '1',
        recall: JSON.stringify(recallFields.recall),
      }),
    (message) => redis.hset(MessageKeys.detail(message.id), { from: '', source: 'malformed legacy source' }),
  );
});

test(
  'Redis periodic browser cursor reads visibility metadata instead of hidden message bodies',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'browser frontier cost');
    const redis = new Redis(process.env.REDIS_URL, { keyPrefix: `issue1287-cost:${Date.now()}:` });
    t.after(() => redis.disconnect());
    const store = new RedisMessageStore(redis);
    const get = await browserApp(t, store);
    await store.append({
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      threadId: 'default',
      content: 'visible',
      mentions: [],
      timestamp: Date.now(),
    });
    await Promise.all(
      Array.from({ length: 500 }, () =>
        store.append({
          userId: 'other',
          from: { kind: 'user', userId: 'other' },
          threadId: 'default',
          content: 'x'.repeat(4096),
          mentions: [],
          timestamp: Date.now(),
        }),
      ),
    );
    const baseline = (await get('/api/messages?threadId=default&limit=50')).json().historyWatermark;
    const probe = `/api/threads/default/watermark?afterVisibility=${encodeURIComponent(baseline)}`;
    const commands = [];
    const send = redis.sendCommand.bind(redis);
    redis.sendCommand = (command, ...args) => {
      commands.push(command);
      return send(command, ...args);
    };
    for (const _ of [1, 2]) {
      commands.length = 0;
      assert.deepEqual((await get(probe)).json(), { watermark: baseline });
      assert.equal(commands.filter((command) => command.name === 'hgetall').length, 0);
      assert.equal(commands.filter((command) => command.name === 'hmget').length, 0);
      assert.equal(commands.filter((command) => command.name === 'zrevrange').length, 1);
      assert.equal(
        commands.some((command) => command.args.includes('content')),
        false,
      );
    }
    await Promise.all(
      Array.from({ length: 100 }, () =>
        store.append({
          userId: 'other',
          from: { kind: 'user', userId: 'other' },
          threadId: 'default',
          content: 'y'.repeat(4096),
          mentions: [],
          timestamp: Date.now(),
        }),
      ),
    );
    for (const _ of [1, 2]) {
      commands.length = 0;
      assert.deepEqual((await get(probe)).json(), { watermark: baseline });
      assert.equal(commands.filter((command) => command.name === 'hmget').length, 50);
      assert.equal(commands.filter((command) => command.name === 'hgetall').length, 0);
    }
    commands.length = 0;
    assert.deepEqual((await get(probe)).json(), { watermark: baseline });
    assert.equal(commands.filter((command) => command.name === 'hmget').length, 0);
    assert.equal(commands.filter((command) => command.name === 'hgetall').length, 0);
  },
);

test(
  'legacy equal timeline scores migrate to unique publication positions',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'browser cursor migration');
    const redis = new Redis(process.env.REDIS_URL, { keyPrefix: `issue1287-migration:${Date.now()}:` });
    t.after(() => redis.disconnect());
    await Promise.all(
      ['legacy-c', 'legacy-a', 'legacy-b'].map(async (id) => {
        await redis.hset(MessageKeys.detail(id), {
          id,
          threadId: 'legacy',
          userId: 'owner',
          timestamp: '100',
          content: id,
          mentions: '[]',
        });
        await redis.zadd(MessageKeys.thread('legacy'), 100, id);
      }),
    );
    const store = new RedisMessageStore(redis);
    const page = await store.getBrowserHistoryChanges('legacy', 'owner', 0);
    assert.deepEqual(
      page.messages.map((message) => message.id),
      ['legacy-a', 'legacy-b', 'legacy-c'],
    );
    assert.deepEqual(
      page.messages.map((message) => message.visibilitySeq),
      [1, 2, 3],
    );
    assert.equal(page.scannedThrough, 3);
    assert.equal(page.exhausted, true);
  },
);
