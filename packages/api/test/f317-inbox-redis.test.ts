import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('a2a-live-inbox');
const run = promisify(execFile);
test(
  'TTL-0 pending sources survive ten-way arrival and a separate process without a custody shadow',
  { timeout: 30000 },
  async () => {
    const prefix = 'f317-inbox-' + randomUUID() + ':';
    const redis = owned.client(prefix);
    const store = new RedisMessageStore(redis);
    const queue = new InvocationQueue(new RedisQueueLedgerStore(redis));
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
            const from = { kind: 'agent' as const, catId: createCatId('producer-' + producer) };
            const messageInput = {
              userId: scope.userId,
              threadId: scope.threadId,
              from,
              content: 'canonical-source-body',
              mentions: [target],
              timestamp: 130 - index,
              deliveryStatus: 'queued' as const,
              idempotencyKey: 'arrival-' + index,
              extra: { crossPost: { sourceThreadId: 'producer-' + producer, effectClass: 'coordinate' as const } },
            };
            const queueInput = {
              kind: 'conversation_input' as const,
              threadId: scope.threadId,
              userId: scope.userId,
              from,
              ownerAuthProvenance: 'strict' as const,
              content: messageInput.content,
              targetCats: [target],
              intent: 'execute',
            };
            const first = await queue.send(store, messageInput, queueInput);
            const repeated = await queue.send(store, messageInput, queueInput);
            assert.ok(first.message && repeated.message);
            assert.equal(repeated.message.id, first.message.id);
            ids.push(first.message.id);
          }),
        );
      }
      assert.equal(ids.length, 130);
      assert.equal(await redis.ttl('msg:' + ids[0]), -1);
      const source = new MessageLiveInboxSource({ store, queue, authorize: async () => true });
      const first = await source.read(scope, ids[0]!);
      assert.equal(first?.facts.notified, false);
      assert.deepEqual(first?.facts.readByInvocationIds, []);
      assert.equal(first?.facts.handled, false);
      const result = await run(process.execPath, ['--import', 'tsx', 'test/helpers/f317-inbox-redis-reader.ts'], {
        env: {
          ...process.env,
          F317_INBOX_TEST_REDIS_SOCKET: redis.options.path,
          F317_INBOX_TEST_PREFIX: prefix,
          F317_INBOX_TEST_SCOPE: JSON.stringify(scope),
        },
        timeout: 15000,
        maxBuffer: 1000000,
      });
      const restored = JSON.parse(result.stdout);
      assert.deepEqual(restored.map((item: { messageId: string }) => item.messageId).sort(), ids.sort());
      assert.ok(
        restored.every(
          (item: { facts: { handled: boolean; playback: string } }) =>
            !item.facts.handled && item.facts.playback === 'unknown',
        ),
      );
      assert.equal(result.stdout.includes('canonical-source-body'), false);
      for (const id of ids) assert.equal(Object.hasOwn((await store.getById(id))!, 'queueCustody'), false);
    } finally {
      await redis.quit();
    }
  },
);
