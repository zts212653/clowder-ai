/**
 * RedisThreadStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisThreadStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisThreadStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;
  const threadDetailKey = (threadId) => `thread:${threadId}`;
  const threadParticipantsKey = (threadId) => `thread:${threadId}:participants`;
  const threadActivityKey = (threadId) => `thread:${threadId}:activity`;
  const userListKey = (userId) => `threads:user:${userId}`;
  const messageDetailKey = (messageId) => `msg:${messageId}`;
  const messageThreadKey = (threadId) => `msg:thread:${threadId}`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisThreadStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js');
    RedisThreadStore = storeModule.RedisThreadStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-thread-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisThreadStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['thread:*', 'threads:*', 'msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['thread:*', 'threads:*', 'msg:*']);
  });

  it('create() stores thread and returns it', async () => {
    const thread = await store.create('user1', 'Test Thread', '/home/user/project');
    assert.ok(thread.id);
    assert.equal(thread.title, 'Test Thread');
    assert.equal(thread.createdBy, 'user1');
    assert.equal(thread.projectPath, '/home/user/project');
    assert.deepEqual(thread.participants, []);
  });

  it('get() returns stored thread', async () => {
    const created = await store.create('user1', 'My Thread');
    const fetched = await store.get(created.id);
    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.title, 'My Thread');
    assert.equal(fetched.createdBy, 'user1');
  });

  it('get("default") auto-creates default thread', async () => {
    const thread = await store.get('default');
    assert.ok(thread);
    assert.equal(thread.id, 'default');
    assert.equal(thread.createdBy, 'system');
  });

  it('get() returns null for nonexistent thread', async () => {
    const result = await store.get('nonexistent-id');
    assert.equal(result, null);
  });

  it('addParticipants() stores and getParticipants() retrieves', async () => {
    const thread = await store.create('user1', 'Chat');
    await store.addParticipants(thread.id, ['opus', 'codex']);
    const participants = await store.getParticipants(thread.id);
    assert.ok(participants.includes('opus'));
    assert.ok(participants.includes('codex'));
    assert.equal(participants.length, 2);
  });

  it('addParticipants() deduplicates', async () => {
    const thread = await store.create('user1', 'Chat');
    await store.addParticipants(thread.id, ['opus']);
    await store.addParticipants(thread.id, ['opus', 'codex']);
    const participants = await store.getParticipants(thread.id);
    assert.equal(participants.length, 2);
  });

  it('addParticipants() persists default thread participants even before default detail exists', async () => {
    await store.addParticipants('default', ['opus', 'codex']);
    const participants = await store.getParticipants('default');
    assert.ok(participants.includes('opus'));
    assert.ok(participants.includes('codex'));
    assert.equal(participants.length, 2);
  });

  it('addParticipants() does not recreate participants for deleted thread (delete race)', async () => {
    const thread = await store.create('user1', 'Deleted Chat');
    const deleted = await store.delete(thread.id);
    assert.equal(deleted, true);

    await store.addParticipants(thread.id, ['opus']);
    const participants = await store.getParticipants(thread.id);
    assert.deepEqual(participants, []);
  });

  it('list() returns user threads sorted by lastActiveAt', async () => {
    const t1 = await store.create('user1', 'First');
    // Small delay for ordering
    await new Promise((r) => setTimeout(r, 10));
    const t2 = await store.create('user1', 'Second');

    const threads = await store.list('user1');
    // Most recent first
    assert.ok(threads.length >= 2);
    const ids = threads.map((t) => t.id);
    assert.ok(ids.indexOf(t2.id) < ids.indexOf(t1.id));
  });

  it('updateTitle() updates the title', async () => {
    const thread = await store.create('user1', 'Old Title');
    await store.updateTitle(thread.id, 'New Title');
    const updated = await store.get(thread.id);
    assert.equal(updated.title, 'New Title');
  });

  it('updatePin(true) sets pinned and pinnedAt', async () => {
    const thread = await store.create('user1', 'Pin Test');
    await store.updatePin(thread.id, true);
    const updated = await store.get(thread.id);
    assert.equal(updated.pinned, true);
    assert.ok(updated.pinnedAt > 0);
  });

  it('updatePin(false) clears pinned and sets pinnedAt to null', async () => {
    const thread = await store.create('user1', 'Unpin Test');
    await store.updatePin(thread.id, true);
    await store.updatePin(thread.id, false);
    const updated = await store.get(thread.id);
    assert.equal(updated.pinned, false);
    assert.equal(updated.pinnedAt, null);
  });

  it('updateFavorite(true) sets favorited and favoritedAt', async () => {
    const thread = await store.create('user1', 'Fav Test');
    await store.updateFavorite(thread.id, true);
    const updated = await store.get(thread.id);
    assert.equal(updated.favorited, true);
    assert.ok(updated.favoritedAt > 0);
  });

  it('updateFavorite(false) clears favorited and sets favoritedAt to null', async () => {
    const thread = await store.create('user1', 'Unfav Test');
    await store.updateFavorite(thread.id, true);
    await store.updateFavorite(thread.id, false);
    const updated = await store.get(thread.id);
    assert.equal(updated.favorited, false);
    assert.equal(updated.favoritedAt, null);
  });

  it('linkBacklogItem() persists reverse backlog reference', async () => {
    const thread = await store.create('user1', 'Backlog link');
    await store.linkBacklogItem(thread.id, 'blg_123');

    const updated = await store.get(thread.id);
    assert.equal(updated?.backlogItemId, 'blg_123');
  });

  it('set/consumeMentionRoutingFeedback() returns one-shot payload', async () => {
    const thread = await store.create('user1', 'Feedback');
    await store.setMentionRoutingFeedback(thread.id, 'codex', {
      sourceMessageId: 'msg-1',
      sourceTimestamp: 1700000000000,
      items: [{ targetCatId: 'opus', reason: 'cross_paragraph' }],
    });

    const first = await store.consumeMentionRoutingFeedback(thread.id, 'codex');
    assert.ok(first);
    assert.equal(first?.sourceMessageId, 'msg-1');
    assert.deepEqual(first?.items, [{ targetCatId: 'opus', reason: 'cross_paragraph' }]);

    const second = await store.consumeMentionRoutingFeedback(thread.id, 'codex');
    assert.equal(second, null, 'feedback should be consumed once');
  });

  it('updateRoutingPolicy() stores and hydrates routingPolicy', async () => {
    const thread = await store.create('user1', 'Routing Policy');
    const policy = { v: 1, scopes: { review: { avoidCats: ['opus'], reason: 'budget' } } };
    await store.updateRoutingPolicy(thread.id, policy);
    const updated = await store.get(thread.id);
    assert.deepEqual(updated.routingPolicy, policy);

    // null clears
    await store.updateRoutingPolicy(thread.id, null);
    const cleared = await store.get(thread.id);
    assert.equal(cleared.routingPolicy, undefined);
  });

  it('updateMentionActionabilityMode() stores relaxed and clears on strict', async () => {
    const thread = await store.create('user1', 'Mention Actionability');

    await store.updateMentionActionabilityMode(thread.id, 'relaxed');
    const updated = await store.get(thread.id);
    assert.equal(updated?.mentionActionabilityMode, 'relaxed');

    await store.updateMentionActionabilityMode(thread.id, 'strict');
    const cleared = await store.get(thread.id);
    assert.equal(cleared?.mentionActionabilityMode, undefined);
  });

  it('delete() removes thread', async () => {
    const thread = await store.create('user1', 'To Delete');
    const result = await store.delete(thread.id);
    assert.equal(result, true);
    const fetched = await store.get(thread.id);
    assert.equal(fetched, null);
  });

  it('delete() cannot remove default thread', async () => {
    await store.get('default'); // ensure it exists
    const result = await store.delete('default');
    assert.equal(result, false);
  });

  // Cloud Codex P2: updateParticipantActivity should check thread existence
  it('updateParticipantActivity() does not write orphaned data for deleted thread', async () => {
    const thread = await store.create('user1', 'Test Activity');
    const threadId = thread.id;

    // First update activity while thread exists
    await store.updateParticipantActivity(threadId, 'opus');
    let activity = await store.getParticipantsWithActivity(threadId);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].messageCount, 1);

    // Delete the thread
    await store.delete(threadId);
    assert.equal(await store.get(threadId), null);

    // updateParticipantActivity should NOT create orphaned activity data
    await store.updateParticipantActivity(threadId, 'opus');

    // After thread deletion, getParticipantsWithActivity should return empty
    // (no orphaned activity data should exist)
    activity = await store.getParticipantsWithActivity(threadId);
    assert.equal(activity.length, 0, 'Should not have orphaned activity data for deleted thread');
  });

  it('get() self-heals orphaned thread metadata from surviving message timeline', async () => {
    const recoveredTitleSource = 'F100 Self-Evolution discussion kickoff';
    const recoveredTitle =
      recoveredTitleSource.length > 30 ? `${recoveredTitleSource.slice(0, 30)}...` : recoveredTitleSource;
    const threadId = 'thread_recover_test';
    const createdAt = 1710000000000;
    const lastActiveAt = createdAt + 5000;
    const firstMessageId = 'msg_recover_first';
    const lastMessageId = 'msg_recover_last';

    await redis.hset(threadDetailKey(threadId), {
      id: threadId,
      projectPath: 'default',
      title: 'Original Title',
      createdBy: 'user1',
      lastActiveAt: String(lastActiveAt),
      createdAt: String(createdAt),
      pinned: 'false',
      pinnedAt: '0',
      favorited: 'false',
      favoritedAt: '0',
      thinkingMode: 'debug',
    });
    await redis.zadd(userListKey('user1'), String(lastActiveAt), threadId);
    await redis.hset(messageDetailKey(firstMessageId), {
      id: firstMessageId,
      threadId,
      userId: 'user1',
      catId: '',
      content: recoveredTitleSource,
      mentions: '[]',
      timestamp: String(createdAt),
    });
    await redis.hset(messageDetailKey(lastMessageId), {
      id: lastMessageId,
      threadId,
      userId: 'user1',
      catId: 'opus',
      content: 'Final reply',
      mentions: '[]',
      timestamp: String(lastActiveAt),
    });
    await redis.zadd(messageThreadKey(threadId), String(createdAt), firstMessageId);
    await redis.zadd(messageThreadKey(threadId), String(lastActiveAt), lastMessageId);
    await redis.hset(threadActivityKey(threadId), {
      'opus:lastMessageAt': String(lastActiveAt),
      'opus:messageCount': '1',
      'opus:healthy': '1',
    });

    await redis.del(threadDetailKey(threadId));
    await redis.del(threadParticipantsKey(threadId));

    const recovered = await store.get(threadId);

    assert.ok(recovered);
    assert.equal(recovered?.id, threadId);
    assert.equal(recovered?.title, recoveredTitle);
    assert.equal(recovered?.createdBy, 'user1');
    assert.equal(recovered?.createdAt, createdAt);
    assert.equal(recovered?.lastActiveAt, lastActiveAt);
    assert.deepEqual(recovered?.participants, ['opus']);

    const persisted = await redis.hgetall(threadDetailKey(threadId));
    assert.equal(persisted.id, threadId);
    assert.equal(persisted.title, recoveredTitle);
    assert.equal(await redis.smembers(threadParticipantsKey(threadId)).then((members) => members[0]), 'opus');
    assert.notEqual(await redis.zscore(userListKey('user1'), threadId), null);
  });

  it('delete() leaves tombstone that prevents self-healing resurrection', async () => {
    const thread = await store.create('user1', 'Will be deleted');
    const threadId = thread.id;

    // Add a message so self-healing would have data to recover from
    const msgId = 'msg-tombstone-test';
    await redis.hset(messageDetailKey(msgId), {
      id: msgId,
      threadId,
      userId: 'user1',
      catId: 'opus',
      content: 'Hello',
      mentions: '[]',
      timestamp: String(Date.now()),
    });
    await redis.zadd(messageThreadKey(threadId), String(Date.now()), msgId);

    // Hard-delete the thread
    const deleted = await store.delete(threadId);
    assert.equal(deleted, true);

    // get() should NOT resurrect the deleted thread
    const result = await store.get(threadId);
    assert.equal(result, null, 'Tombstone should prevent self-healing resurrection');

    // Tombstone key should exist
    assert.equal(await redis.get(`thread:${threadId}:tombstone`), '1');
  });

  it('delete() on nonexistent thread does not write tombstone (phantom ID)', async () => {
    const phantomId = 'thread_phantom_ghost';

    // delete() on a thread that never existed should return false
    const deleted = await store.delete(phantomId);
    assert.equal(deleted, false);

    // No tombstone should exist — self-healing must remain possible
    assert.equal(await redis.get(`thread:${phantomId}:tombstone`), null, 'Phantom delete must not write tombstone');

    // Verify self-healing still works for this ID if messages appear later
    const msgId = 'msg-phantom-test';
    await redis.hset(messageDetailKey(msgId), {
      id: msgId,
      threadId: phantomId,
      userId: 'user1',
      catId: 'opus',
      content: 'Post-phantom message',
      mentions: '[]',
      timestamp: String(Date.now()),
    });
    await redis.zadd(messageThreadKey(phantomId), String(Date.now()), msgId);

    const recovered = await store.get(phantomId);
    assert.ok(recovered, 'Self-healing should work after phantom delete');
    assert.equal(recovered?.id, phantomId);
  });

  it('persistent mode clears legacy TTL from live thread keys on activity updates', async () => {
    const expiringStore = new RedisThreadStore(redis, { ttlSeconds: 60 });
    const persistentStore = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const thread = await expiringStore.create('user1', 'Legacy TTL');

    await expiringStore.addParticipants(thread.id, ['opus']);
    await expiringStore.updateParticipantActivity(thread.id, 'opus');

    assert.ok((await redis.ttl(threadDetailKey(thread.id))) > 0);
    assert.ok((await redis.ttl(userListKey('user1'))) > 0);
    assert.ok((await redis.ttl(threadParticipantsKey(thread.id))) > 0);
    assert.ok((await redis.ttl(threadActivityKey(thread.id))) > 0);

    await persistentStore.updateLastActive(thread.id);
    await persistentStore.updateParticipantActivity(thread.id, 'opus');

    assert.equal(await redis.ttl(threadDetailKey(thread.id)), -1);
    assert.equal(await redis.ttl(userListKey('user1')), -1);
    assert.equal(await redis.ttl(threadParticipantsKey(thread.id)), -1);
    assert.equal(await redis.ttl(threadActivityKey(thread.id)), -1);
  });

  it('persistent mode also clears legacy TTL on detail-only mutations', async () => {
    const expiringStore = new RedisThreadStore(redis, { ttlSeconds: 60 });
    const persistentStore = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const thread = await expiringStore.create('user1', 'Legacy Detail TTL');

    assert.ok((await redis.ttl(threadDetailKey(thread.id))) > 0);

    await persistentStore.updateTitle(thread.id, 'Recovered Title');
    assert.equal(await redis.ttl(threadDetailKey(thread.id)), -1);

    await expiringStore.updateMentionActionabilityMode(thread.id, 'relaxed');
    assert.ok((await redis.ttl(threadDetailKey(thread.id))) > 0);

    await persistentStore.updateMentionActionabilityMode(thread.id, 'strict');
    assert.equal(await redis.ttl(threadDetailKey(thread.id)), -1);
  });

  // --- ZSet self-heal tests ---

  it('list() recovers threads when ZSet index is lost', async () => {
    // Create 3 threads for user1
    const t1 = await store.create('user1', 'Thread A');
    const t2 = await store.create('user1', 'Thread B');
    const t3 = await store.create('user1', 'Thread C');

    // Simulate ZSet index loss: delete all entries from user1's ZSet
    const zsetKey = 'threads:user:user1';
    await redis.del(zsetKey);

    // Verify ZSet is empty
    const ids = await redis.zrange(zsetKey, 0, -1);
    assert.equal(ids.length, 0, 'ZSet should be empty after deletion');

    // list() should trigger self-heal and recover the threads
    const threads = await store.list('user1');
    const threadIds = threads.map((t) => t.id);

    // Should include all 3 threads (default is added by list() but doesn't have hash)
    assert.ok(threadIds.includes(t1.id), 'Thread A should be recovered');
    assert.ok(threadIds.includes(t2.id), 'Thread B should be recovered');
    assert.ok(threadIds.includes(t3.id), 'Thread C should be recovered');
  });

  it('list() self-heal is gated by cooldown', async () => {
    // Create a thread
    await store.create('user2', 'Cooldown Test');

    // Delete ZSet
    await redis.del('threads:user:user2');

    // First list() triggers rebuild
    const first = await store.list('user2');
    assert.ok(first.length >= 1, 'First list should recover threads');

    // Delete ZSet again (simulate another loss)
    await redis.del('threads:user:user2');

    // Second list() within cooldown should NOT rebuild (still returns results from stale cache)
    // The ZSet remains empty because cooldown blocks rebuild
    const second = await store.list('user2');
    // After cooldown-blocked list(), ZSet is still empty so only default thread appears
    assert.equal(second.length, 1, 'Second list within cooldown returns only default thread');
    assert.equal(second[0].id, 'default', 'Only default thread without rebuild');
  });

  it('list() self-heal does not cross users', async () => {
    // Create threads for user3 and user4
    await store.create('user3', 'User3 Thread');
    await store.create('user4', 'User4 Thread');

    // Delete user3's ZSet
    await redis.del('threads:user:user3');

    // Calling list for user4 should NOT rebuild user3's index
    const user4Threads = await store.list('user4');
    assert.ok(
      user4Threads.some((t) => t.title === 'User4 Thread'),
      'User4 sees own threads',
    );

    // user3's ZSet should still be empty (user4's list doesn't trigger user3 repair)
    const user3Ids = await redis.zrange('threads:user:user3', 0, -1);
    assert.equal(user3Ids.length, 0, 'User3 ZSet should remain empty');
  });

  it('repairIndex() rebuilds sparse user indexes', async () => {
    // Create threads for a repair user
    await store.create('repair-user', 'Repair Thread 1');
    await store.create('repair-user', 'Repair Thread 2');

    // Delete the ZSet
    await redis.del('threads:user:repair-user');

    // Run repairIndex
    const result = await store.repairIndex();
    assert.equal(result.repairedUsers, 1);
    assert.equal(result.repairedMembers, 2);

    // Verify the ZSet is restored
    const ids = await redis.zrange('threads:user:repair-user', 0, -1);
    assert.ok(ids.length >= 2, `Expected at least 2 entries in ZSet, got ${ids.length}`);
  });

  it('repairIndex() detects partial ZSet loss (not just full loss)', async () => {
    // Create 3 threads for partial-user
    const t1 = await store.create('partial-user', 'Partial A');
    const t2 = await store.create('partial-user', 'Partial B');
    const t3 = await store.create('partial-user', 'Partial C');

    // Remove only t2 from the ZSet (simulate partial index loss)
    await redis.zrem('threads:user:partial-user', t2.id);

    // Verify ZSet now has 2 entries (missing t2)
    const idsBefore = await redis.zrange('threads:user:partial-user', 0, -1);
    assert.equal(idsBefore.length, 2, 'ZSet should have 2 entries after partial loss');

    // repairIndex should detect the missing member and rebuild
    const result = await store.repairIndex();
    assert.equal(result.repairedUsers, 1);
    assert.equal(result.repairedMembers, 1);

    // Verify t2 is back in the ZSet
    const idsAfter = await redis.zrange('threads:user:partial-user', 0, -1);
    assert.ok(idsAfter.includes(t2.id), 'Missing thread should be restored in ZSet');
    assert.equal(idsAfter.length, 3, 'All 3 threads should be in ZSet after repair');
  });
});

describe('ThreadStoreFactory', () => {
  it('returns ThreadStore when no redis', async () => {
    const { createThreadStore } = await import('../dist/domains/cats/services/stores/factories/ThreadStoreFactory.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = createThreadStore();
    assert.ok(store instanceof ThreadStore);
  });

  it(
    'returns RedisThreadStore when redis provided',
    {
      skip: redisIsolationSkipReason(REDIS_URL),
    },
    async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'ThreadStoreFactory');

      const { createThreadStore } = await import(
        '../dist/domains/cats/services/stores/factories/ThreadStoreFactory.js'
      );
      const { RedisThreadStore } = await import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const redis = createRedisClient({ url: REDIS_URL });
      try {
        const store = createThreadStore(redis);
        assert.ok(store instanceof RedisThreadStore);
      } finally {
        await redis.quit().catch(() => {});
      }
    },
  );
});
