import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Redis } from 'ioredis';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { isLatestOwnerMessage } from '../src/domains/concierge/live/host/voice/live-owner-currentness.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-source-accounting');

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: 'codex61-sol',
  callId: 'call',
  invocationId: 'inv',
  generation: 1,
};
const options = {
  includeQueuedUserMessages: true,
  includeRecalledUserMessages: true,
  onlyUnpositionedOwnerMessages: true,
};
const input = {
  userId: 'owner',
  threadId: 'home',
  from: { kind: 'user', userId: 'owner' },
  content: 'backdated queued correction',
  mentions: [],
  timestamp: 1,
  deliveryStatus: 'queued',
};
for (const scenario of ['restore', 'hard-tombstone', 'hard-delete-race'])
  test('source1453 ' + scenario, {}, async () => {
    const redis = owned.client('f317-restore-' + randomUUID() + ':');
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    try {
      const source = await store.append({
        ...input,
        timestamp: 9000,
        content: 'current source',
        deliveryStatus: undefined,
      });
      const queued = await store.append(input);
      await store.softDelete(queued.id, 'owner');
      assert.deepEqual(await store.getByThread('home', 1, 'owner', options), []);
      assert.equal(await isLatestOwnerMessage(store, scope, source), true);
      if (scenario === 'hard-tombstone') {
        await store.hardDelete(queued.id, 'owner');
        assert.equal(await store.restore(queued.id), null);
      } else if (scenario === 'hard-delete-race') {
        const read = store.getById.bind(store);
        let intercepted = false;
        store.getById = async (id) => {
          const value = await read(id);
          if (id === queued.id && !intercepted) {
            intercepted = true;
            await store.hardDelete(id, 'owner');
          }
          return value;
        };
        assert.equal(
          await store.restore(queued.id),
          null,
          'final restore cannot overwrite a newly hard-deleted tombstone',
        );
        assert.equal((await read(queued.id))._tombstone, true);
        assert.ok((await read(queued.id)).deletedAt);
      } else {
        const restored = await store.restore(queued.id);
        assert.equal(restored?.deletedAt, undefined);
        assert.equal((await store.getById(queued.id)).deliveryStatus, 'queued');
        assert.deepEqual(
          (await store.getByThread('home', 1, 'owner', options)).map((row) => row.id),
          [queued.id],
        );
        assert.equal(
          await isLatestOwnerMessage(store, scope, source),
          false,
          'restored pending input still fences the visible source',
        );
      }
    } finally {
      redis.disconnect();
    }
  });
