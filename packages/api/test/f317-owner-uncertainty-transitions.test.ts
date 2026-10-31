import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Redis } from 'ioredis';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-source-accounting');

const options = {
  includeQueuedUserMessages: true,
  includeRecalledUserMessages: true,
  onlyUnpositionedOwnerMessages: true,
};
const input = {
  userId: 'owner',
  threadId: 'home',
  from: { kind: 'user', userId: 'owner' },
  content: 'input',
  mentions: [],
  timestamp: 100,
};
const index = 'msg:owner-uncertainty:home';

for (const scenario of [
  'legacy',
  'delivery',
  'cancel',
  'atomic-admission',
  'observed-frontier',
  'delete',
  'version',
  'corruption',
  'recall-corruption',
  'hydration',
  'short-hydration',
  'saturation',
  'reassign',
  'expired',
] as const)
  test(`Redis owner uncertainty: ${scenario}`, {}, async (t) => {
    const redis = owned.client(`f317-uncertainty-state-${randomUUID()}:`);
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const read = () => store.getByThread('home', 1, 'owner', options);
    const queued = () =>
      store.append({
        ...input,
        deliveryStatus: 'queued',
      });
    try {
      if (scenario === 'legacy') {
        const message = await queued();
        await redis.del(index, `${index}:version`);
        assert.deepEqual(
          (await read()).map((row) => row.id),
          [message.id],
        );
        assert.equal(await redis.get(`${index}:version`), '1');
        assert.equal(await redis.ttl(`msg:${message.id}`), -1);
      } else if (scenario === 'delivery' || scenario === 'cancel') {
        await read();
        const message = await queued();
        assert.deepEqual(
          (await read()).map((row) => row.id),
          [message.id],
        );
        if (scenario === 'delivery')
          assert.equal((await store.markDelivered(message.id, 200))?.deliveryTransitioned, true);
        else assert.equal((await store.markCanceled(message.id))?.deliveryTransitioned, true);
        assert.deepEqual(await read(), []);
        assert.equal(await redis.zcard(index), 0);
      } else if (scenario === 'atomic-admission' || scenario === 'observed-frontier') {
        await read();
        const message = { ...input, deliveryStatus: 'queued' as const };
        const result =
          scenario === 'atomic-admission'
            ? await new InvocationQueue(new RedisQueueLedgerStore(redis)).send(store, message, {
                threadId: 'home',
                userId: 'owner',
                from: input.from,
                content: input.content,
                kind: 'conversation_input',
                ownerAuthProvenance: 'strict',
                targetCats: ['opus'],
                intent: 'execute',
              })
            : await store.appendAndObservePriorFrontier(message);
        assert.equal(
          scenario === 'atomic-admission' ? result.outcome : result.kind,
          scenario === 'atomic-admission' ? 'enqueued' : 'committed',
        );
        assert.equal((await read()).length, 1);
      } else if (scenario === 'delete') {
        const message = await queued();
        await read();
        await store.softDelete(message.id, 'owner');
        assert.deepEqual(await read(), []);
        assert.equal(await redis.zcard(index), 0);
        await store.deleteByThread('home');
        assert.equal(await store.getById(message.id), null);
        assert.deepEqual(await read(), [], 'a retained index version cannot resurrect deleted History');
      } else if (scenario === 'reassign') {
        const message = await queued();
        await read();
        await store.reassignUserId(message.id, 'foreign');
        assert.deepEqual(await read(), []);
      } else if (scenario === 'expired') {
        const message = await queued();
        await read();
        await redis.del(`msg:${message.id}`);
        assert.deepEqual(await read(), []);
        assert.equal(await redis.zcard(index), 0);
      } else if (scenario === 'version') {
        await redis.set(`${index}:version`, 'unknown');
        await assert.rejects(read(), /VERSION_INVALID/);
      } else if (scenario === 'corruption') {
        await redis.set(index, 'damaged');
        await assert.rejects(queued(), /INDEX_INVALID/);
        assert.equal(await redis.zcard('msg:thread:home'), 0, 'index validation precedes the canonical write');
      } else if (scenario === 'recall-corruption') {
        const message = await queued();
        await redis.hset(
          `msg:${message.id}`,
          'recall',
          JSON.stringify({ version: 1, exposure: 'seen', recalledAt: -1 }),
        );
        await assert.rejects(store.markCanceled(message.id), /RECALL_INVALID/);
        assert.equal(
          await redis.hget(`msg:${message.id}`, 'deliveryStatus'),
          'queued',
          'corrupt source validation precedes canonical cancellation',
        );
      } else if (scenario === 'short-hydration') {
        await queued();
        await read();
        t.mock.method(redis, 'multi', () => ({
          hgetall() {
            return this;
          },
          async exec() {
            return [];
          },
        }));
        await assert.rejects(read(), /hydration incomplete/);
      } else if (scenario === 'hydration') {
        await queued();
        await read();
        t.mock.method(redis, 'multi', () => ({
          hgetall() {
            return this;
          },
          async exec() {
            return [[new Error('read failed'), null]];
          },
        }));
        await assert.rejects(read(), /hydration failed/);
      } else {
        await read();
        for (let i = 0; i < 257; i++)
          await store.append({
            ...input,
            userId: 'foreign',
            from: { kind: 'user', userId: 'foreign' },
            timestamp: i + 1,
            deliveryStatus: 'queued',
          });
        await assert.rejects(read(), /saturated/, 'bounded uncertainty cannot be mistaken for proven absence');
      }
    } finally {
      redis.disconnect();
    }
  });
