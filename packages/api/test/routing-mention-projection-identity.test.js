import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLastUserMentions } from '../dist/domains/cats/services/agents/routing/last-user-mentions.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MESSAGE_RECIPIENT_FIELDS } from '../dist/domains/cats/services/stores/redis/redis-message-recipient-fields.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('routing-mention-identity');
const human = (id, timestamp, mentions) => ({
  id,
  threadId: 'T',
  userId: 'owner',
  timestamp: String(timestamp),
  mentions: JSON.stringify(mentions),
});

test('a real dangling latest index member rejects instead of restoring the older Human choice', async () => {
  const redis = owned.client('dangling:');
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  await redis.hset('msg:older', human('older', 50, ['opus']));
  await redis.zadd('msg:thread:T', 50, 'older', 100, 'latest');
  assert.equal(await redis.exists('msg:latest'), 0);
  assert.deepEqual(
    await redis.hmget('msg:latest', ...MESSAGE_RECIPIENT_FIELDS),
    MESSAGE_RECIPIENT_FIELDS.map(() => null),
  );
  await assert.rejects(findLastUserMentions(messages, 'T'), /Recipient source hydration/);
  await redis.hset('msg:latest', human('latest', 100, ['codex']));
  assert.deepEqual(await findLastUserMentions(messages, 'T'), ['codex'], 'a repaired hash is read afresh');
});

for (const [label, id] of [
  ['missing', undefined],
  ['empty', ''],
  ['different', 'other-message'],
]) {
  test(`a ${label} projected id rejects instead of adopting an unbound Human choice`, async () => {
    const redis = owned.client(`identity-${label}:`);
    const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const latest = human('latest', 100, ['codex']);
    delete latest.id;
    if (id !== undefined) latest.id = id;
    await redis.hset('msg:older', human('older', 50, ['opus']));
    await redis.hset('msg:latest', latest);
    await redis.zadd('msg:thread:T', 50, 'older', 100, 'latest');
    await assert.rejects(findLastUserMentions(messages, 'T'), /Recipient source hydration/);
    await redis.hset('msg:latest', 'id', 'latest');
    assert.deepEqual(await findLastUserMentions(messages, 'T'), ['codex']);
  });
}

test('a hash lost between range selection and HMGET rejects before an older choice can escape', async () => {
  const redis = owned.client('range-race:');
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  await redis.hset('msg:older', human('older', 50, ['opus']));
  await redis.hset('msg:latest', human('latest', 100, ['codex']));
  await redis.zadd('msg:thread:T', 50, 'older', 100, 'latest');
  const multi = redis.multi.bind(redis);
  let removed = false;
  redis.multi = (...args) => {
    const transaction = multi(...args);
    const exec = transaction.exec.bind(transaction);
    transaction.exec = async () => {
      if (!removed) {
        removed = true;
        assert.equal(await redis.del('msg:latest'), 1);
      }
      return exec();
    };
    return transaction;
  };
  try {
    await assert.rejects(findLastUserMentions(messages, 'T'), /Recipient source hydration/);
    assert.equal(removed, true);
  } finally {
    redis.multi = multi;
  }
  await redis.hset('msg:latest', human('latest', 100, ['codex']));
  assert.deepEqual(await findLastUserMentions(messages, 'T'), ['codex']);
});
