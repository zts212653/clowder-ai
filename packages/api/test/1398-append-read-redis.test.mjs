import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('a2a-append-read');
test('optional Append read evidence survives Redis reload and a terminal write race without sibling changes', async () => {
  const redis = owned.client('append-read-' + randomUUID() + ':');
  try {
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const input = await store.append({
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      content: 'append',
      mentions: [],
      timestamp: 11,
    });
    const patch = {
      orderKey: `11:${input.id}`,
      targetId: 'opus',
      statusMessageId: 'response',
      phase: 'dispatched',
      dispatchedAt: 12,
    };
    assert.equal(
      (await store.advanceLifecycleInputDispatch(input.id, { ...patch, inputRead: { status: 'pending' } })).kind,
      'applied',
    );
    assert.equal(
      (await store.advanceLifecycleInputDispatch(input.id, { ...patch, targetId: 'kimi', statusMessageId: 'sibling' }))
        .kind,
      'applied',
    );
    const reloaded = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const before = await reloaded.getById(input.id);
    assert.deepEqual(before.lifecycle.dispatchRefs[0].inputRead, { status: 'pending' });
    await reloaded.advanceLifecycleInputDispatch(input.id, { ...patch, phase: 'settled' });
    // The observer took its snapshot before settlement and therefore echoes the old phase.
    assert.equal(
      (await store.advanceLifecycleInputDispatch(input.id, { ...patch, inputRead: { status: 'read', at: 15 } })).kind,
      'applied',
    );
    const restored = await new RedisMessageStore(redis, { ttlSeconds: 0 }).getById(input.id);
    assert.equal(restored.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.deepEqual(restored.lifecycle.dispatchRefs[0].inputRead, { status: 'read', at: 15 });
    assert.deepEqual(restored.lifecycle.dispatchRefs[1], before.lifecycle.dispatchRefs[1]);
    assert.equal(
      (await store.advanceLifecycleInputDispatch(input.id, { ...patch, inputRead: { status: 'read', at: 16 } })).kind,
      'replayed',
    );
    assert.equal(await redis.ttl('msg:' + input.id), -1);
  } finally {
    await redis.quit();
  }
});
