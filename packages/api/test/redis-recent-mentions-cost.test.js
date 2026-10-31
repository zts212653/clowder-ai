import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

function fixture(foreignCount) {
  const mentionKey = MessageKeys.mentions('codex61-sol');
  const userKey = MessageKeys.user('owner');
  const threadKey = MessageKeys.thread('local');
  const ids = Array.from({ length: foreignCount }, (_, i) => `foreign-${String(i).padStart(5, '0')}`);
  ids.splice(0, 0, 'local-old');
  ids.push('local-new', 'local-other-owner');
  const members = new Map([
    [mentionKey, ids],
    [userKey, ids.filter((id) => id !== 'local-other-owner')],
    [threadKey, ['local-new', 'local-old', 'local-other-owner']],
  ]);
  let commands = 0;
  const hydrated = [];
  const redis = {
    options: {},
    async zrevrange(key, start, stop) {
      commands++;
      return [...members.get(key)].reverse().slice(start, stop + 1);
    },
    async zscore(key, id) {
      commands++;
      return members.get(key)?.includes(id) ? '1' : null;
    },
    async zinter(count, ...args) {
      commands++;
      const keys = args.slice(0, count);
      assert.deepEqual(args.slice(count), ['WEIGHTS', 1, ...keys.slice(1).map(() => 0), 'AGGREGATE', 'SUM']);
      return members.get(keys[0]).filter((id) => keys.slice(1).every((key) => members.get(key).includes(id)));
    },
    multi() {
      const selected = [];
      return {
        hgetall(key) {
          selected.push(key.slice('msg:'.length));
          return this;
        },
        async exec() {
          commands++;
          hydrated.push(...selected);
          return selected.map((id) => [
            null,
            {
              id,
              userId: id === 'local-other-owner' ? 'other' : 'owner',
              threadId: id.startsWith('local') ? 'local' : 'foreign',
              content: id,
              catId: '',
              mentions: '["codex61-sol"]',
              timestamp: '1000',
            },
          ]);
        },
      };
    },
  };
  return { store: new RedisMessageStore(redis), hydrated, commands: () => commands };
}

test('recent thread mentions do not scan the global cat index when fewer than the limit exist', async () => {
  const f = fixture(2000);
  const result = await f.store.getRecentMentionsFor('codex61-sol', 20, 'owner', 'local');
  assert.deepEqual(
    result.map((message) => message.id),
    ['local-old', 'local-new'],
  );
  assert.deepEqual(f.hydrated, ['local-old', 'local-new']);
  assert.ok(f.commands() <= 2, `local two-message read made ${f.commands()} Redis commands`);
});

test('thread membership does not change mention ordering and foreign owners remain excluded', async () => {
  const f = fixture(20);
  const result = await f.store.getRecentMentionsFor('codex61-sol', 1, 'owner', 'local');
  assert.deepEqual(
    result.map((message) => message.id),
    ['local-new'],
  );
  assert.ok(f.commands() <= 2);
});

test(
  'real Redis preserves mention scores and ties while intersecting owner and thread membership',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'recent-mention-cost');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'recent-mention-cost:' });
    const rows = [
      { id: 'mention-low', score: 100, owner: true, thread: true },
      { id: 'a-tie', score: 150, owner: true, thread: true },
      { id: 'z-tie', score: 150, owner: true, thread: true },
      { id: 'mention-high', score: 200, owner: true, thread: true },
      { id: 'foreign-thread', score: 250, owner: true, thread: false },
      { id: 'foreign-owner', score: 300, owner: false, thread: true },
    ];
    try {
      const pipeline = redis.multi();
      for (const [index, row] of rows.entries()) {
        pipeline.zadd(MessageKeys.mentions('codex61-sol'), row.score, row.id);
        if (row.owner) pipeline.zadd(MessageKeys.user('owner'), 1000 - index, row.id);
        if (row.thread) pipeline.zadd(MessageKeys.thread('local'), 2000 - index, row.id);
        pipeline.hset(MessageKeys.detail(row.id), {
          id: row.id,
          threadId: row.thread ? 'local' : 'foreign',
          userId: row.owner ? 'owner' : 'foreign',
          content: row.id,
          catId: '',
          mentions: '["codex61-sol"]',
          timestamp: String(1000 + index),
        });
      }
      await pipeline.exec();
      const store = new RedisMessageStore(redis);
      const ids = async (limit, userId, threadId) =>
        (await store.getRecentMentionsFor('codex61-sol', limit, userId, threadId)).map((message) => message.id);
      assert.deepEqual(await ids(20, 'owner', 'local'), ['mention-low', 'a-tie', 'z-tie', 'mention-high']);
      assert.deepEqual(await ids(2, 'owner', 'local'), ['z-tie', 'mention-high']);
      assert.deepEqual(await ids(2, 'owner'), ['mention-high', 'foreign-thread']);
      assert.deepEqual(await ids(2, undefined, 'local'), ['mention-high', 'foreign-owner']);
      assert.deepEqual(await ids(2), ['foreign-thread', 'foreign-owner']);
      assert.deepEqual(await ids(0, 'owner', 'local'), []);
      assert.deepEqual(await ids(Number.NaN, 'owner', 'local'), []);
      assert.deepEqual(await ids(1.5, 'owner', 'local'), ['z-tie', 'mention-high']);
      assert.deepEqual(
        await ids(Infinity),
        rows.map((row) => row.id),
      );
    } finally {
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      await redis.quit();
    }
  },
);
