import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { Redis } from 'ioredis';
import { type IMessageStore, MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { isLatestOwnerMessage } from '../src/domains/concierge/live/host/voice/live-owner-currentness.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-source-accounting');

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: createCatId('codex61-sol'),
  callId: 'call',
  invocationId: 'inv',
  generation: 1,
};
for (const backend of ['memory', 'redis'] as const)
  test(`${backend}: only recalls newer than the current source are uncertainty`, {}, async () => {
    let redis: Redis | undefined;
    if (backend === 'redis') {
      redis = owned.client(`f317-uncertainty-${randomUUID()}:`);
    }
    const store: IMessageStore = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
    try {
      const recalled = await store.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'user', userId: 'owner' },
        content: 'old input',
        mentions: [],
        timestamp: 1_000,
        deliveryStatus: 'queued',
      });
      assert.equal(
        (
          await store.recallMessageToComposerDraft(recalled.id, {
            ownerUserId: 'owner',
            threadId: 'home',
            expectedDraftRevision: 0,
            merge: 'replace',
            recalledAt: 1_500,
          })
        ).kind,
        'recalled',
      );
      for (let i = 0; i < 300; i++)
        await store.append({
          userId: 'owner',
          threadId: 'home',
          from: { kind: 'agent', catId: createCatId('sonnet') },
          content: 'history',
          mentions: [],
          timestamp: 2_000 + i,
        });
      const current = await store.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'user', userId: 'owner' },
        content: 'new source',
        mentions: [],
        timestamp: 9_000,
      });
      assert.equal(await isLatestOwnerMessage(store, scope, current), true, 'old recall cannot poison new owner input');
      const newer = await store.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'user', userId: 'owner' },
        content: 'newer recall',
        mentions: [],
        timestamp: 1,
        deliveryStatus: 'queued',
      });
      assert.equal(
        (
          await store.recallMessageToComposerDraft(newer.id, {
            ownerUserId: 'owner',
            threadId: 'home',
            expectedDraftRevision: 1,
            merge: 'replace',
            recalledAt: 9_002,
          })
        ).kind,
        'recalled',
      );
      assert.equal(
        await isLatestOwnerMessage(store, scope, current),
        true,
        'unread queued input recalled before delivery no longer fences the visible source',
      );
    } finally {
      if (redis) {
        redis.disconnect();
      }
    }
  });

test('Redis hot absence reads do not hydrate retained delivered history', {}, async (t) => {
  const redis = owned.client(`f317-uncertainty-hot-${randomUUID()}:`);
  const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  try {
    for (let i = 0; i < 500; i++)
      await store.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'agent', catId: createCatId('sonnet') },
        content: 'history',
        mentions: [],
        timestamp: i + 1,
      });
    const options = {
      includeQueuedUserMessages: true,
      includeRecalledUserMessages: true,
      onlyUnpositionedOwnerMessages: true,
    };
    await store.getByThread('home', 1, 'owner', options);
    let hydrated = 0;
    const original = redis.multi.bind(redis);
    t.mock.method(redis, 'multi', () => {
      const pipe = original();
      const read = pipe.hgetall.bind(pipe);
      t.mock.method(pipe, 'hgetall', (key: string) => {
        hydrated++;
        return read(key);
      });
      return pipe;
    });
    for (let i = 0; i < 3; i++) assert.deepEqual(await store.getByThread('home', 1, 'owner', options), []);
    assert.equal(hydrated, 0);
  } finally {
    redis.disconnect();
  }
});
