import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import { Redis } from 'ioredis';
import type { QueuedMessageCustody } from '../src/domains/cats/services/stores/ports/queued-message-custody.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';

const url = process.env.F317_INBOX_TEST_REDIS_URL;
const run = promisify(execFile);

test(
  'Redis TTL-0 sources survive ten-way idempotent arrival and a new process replays exact custody',
  {
    skip: !url,
    timeout: 30_000,
  },
  async () => {
    assert.ok(url);
    const address = new URL(url);
    assert.ok(['localhost', '127.0.0.1'].includes(address.hostname));
    assert.equal(address.port, '6398', 'this fixture is never allowed to connect to runtime Redis');
    assert.equal(address.pathname, '/15');
    const keyPrefix = `f317-inbox-${randomUUID()}:`;
    const redis = new Redis(url, { keyPrefix, maxRetriesPerRequest: 1 });
    const store = new RedisMessageStore(redis);
    const target = createCatId('codex-astra');
    const scope = {
      userId: 'owner',
      threadId: 'home',
      catId: target,
      invocationId: 'new-child',
      callId: 'new-call',
      generation: 2,
    };
    const ids: string[] = [];
    try {
      for (let page = 0; page < 13; page++) {
        await Promise.all(
          Array.from({ length: 10 }, async (_, producer) => {
            const index = page * 10 + producer;
            const queue: QueuedMessageCustody = {
              version: 1,
              entryId: `entry-${index}`,
              revision: 1,
              intent: 'coordinate',
              status: 'queued',
              allTargetCats: [target],
              pendingTargetCats: [target],
              notifiedByCatIds: [target],
              seenByCatIds: [target],
              seenInvocationIdByCatId: { [target]: 'dead-child' },
              bodyExposures: [{ targetCatId: target, invocationId: 'dead-child', seenAt: 500 }],
              failedByCatIds: [],
              handledByCatIds: [],
              priority: index % 3 ? 'normal' : 'urgent',
              createdAt: 1,
              updatedAt: 500,
            };
            const input = {
              userId: scope.userId,
              threadId: scope.threadId,
              catId: createCatId(`producer-${producer}`),
              content: 'canonical-source-body',
              mentions: [target],
              timestamp: 130 - index,
              deliveryStatus: 'queued' as const,
              queueCustody: queue,
              idempotencyKey: `arrival-${index}`,
              extra: { crossPost: { sourceThreadId: `producer-${producer}`, effectClass: 'coordinate' as const } },
            };
            const first = await store.appendIdempotent(input);
            const repeated = await store.appendIdempotent(input);
            assert.equal(repeated.message.id, first.message.id);
            ids.push(first.message.id);
          }),
        );
      }
      assert.equal(ids.length, 130);
      assert.equal(await redis.ttl(`msg:${ids[0]}`), -1);
      const source = new MessageLiveInboxSource({ store, authorize: async () => true });
      const first = await source.read(scope, ids[0]);
      assert.equal(first?.facts.notified, true);
      assert.deepEqual(first?.facts.readByInvocationIds, ['dead-child']);
      assert.equal(first?.facts.handled, false);
      await redis.quit();

      // A different Node process and Redis connection have no scheduler, cursor or receipt cache.
      const result = await run(process.execPath, ['--import', 'tsx', 'test/helpers/f317-inbox-redis-reader.ts'], {
        env: { ...process.env, F317_INBOX_TEST_PREFIX: keyPrefix, F317_INBOX_TEST_SCOPE: JSON.stringify(scope) },
        timeout: 15_000,
        maxBuffer: 1_000_000,
      });
      const restored = JSON.parse(result.stdout) as Array<{
        messageId: string;
        facts: { handled: boolean; playback: string };
      }>;
      assert.deepEqual(restored.map((item) => item.messageId).sort(), ids.sort());
      assert.ok(restored.every((item) => !item.facts.handled && item.facts.playback === 'unknown'));
      assert.equal(result.stdout.includes('canonical-source-body'), false);
    } finally {
      redis.disconnect();
      const cleanup = new Redis(url, { keyPrefix, maxRetriesPerRequest: 1 });
      try {
        const keys = await cleanup.keys(`${keyPrefix}*`);
        if (keys.length) await cleanup.del(...keys.map((key) => key.slice(keyPrefix.length)));
      } finally {
        await cleanup.quit();
      }
    }
  },
);
