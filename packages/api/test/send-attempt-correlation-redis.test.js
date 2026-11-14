import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createQueueLedgerAdmission } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { projectPublicQueueEntry } from '../dist/utils/queue-enrichment.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const url = process.env.REDIS_URL;
assertRedisIsolationOrThrow(url, 'send-attempt-correlation');
test(
  'Redis atomic admission survives reopening and old messages replay without a correlation migration',
  { skip: redisIsolationSkipReason(url) },
  async () => {
    const redis = new Redis(url, { keyPrefix: `test:issue1973:${randomUUID()}:`, maxRetriesPerRequest: 0 });
    try {
      const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
      const ledger = new RedisQueueLedgerStore(redis);
      const queue = new InvocationQueue(ledger);
      const from = { kind: 'user', userId: 'owner' };
      const source = {
        from,
        userId: 'owner',
        threadId: 'thread',
        content: 'durable input',
        mentions: ['opus'],
        deliveryStatus: 'queued',
        idempotencyKey: 'client-key',
        clientMessageId: 'client-key',
        timestamp: 100,
      };
      const input = {
        from,
        userId: 'owner',
        threadId: 'thread',
        content: source.content,
        kind: 'conversation_input',
        intent: 'execute',
        targetCats: ['opus'],
        ownerAuthProvenance: 'strict',
        idempotencyKey: source.idempotencyKey,
      };
      const first = await queue.send(messages, source, input);
      assert.equal(first.outcome, 'enqueued');
      const reopened = new RedisMessageStore(redis, { ttlSeconds: 0 });
      const restored = await reopened.getByIdempotencyKey('owner', 'thread', source.idempotencyKey);
      assert.equal(restored.id, first.message.id);
      assert.equal(restored.clientMessageId, source.idempotencyKey);
      assert.notEqual(restored.clientMessageId, restored.id);
      assert.equal(restored.extra?.clientMessageId, undefined);
      const rows = await new RedisQueueLedgerStore(redis).list('thread');
      assert.equal(projectPublicQueueEntry(rows[0]).clientMessageId, source.idempotencyKey);
      await reopened.markDelivered(restored.id, 200);
      assert.equal((await reopened.getById(restored.id)).clientMessageId, source.idempotencyKey);

      const { clientMessageId: _correlation, ...legacySource } = { ...source, idempotencyKey: 'legacy-key' };
      const legacy = await messages.appendWithQueueLedgerAdmission(
        legacySource,
        (sourceId) =>
          createQueueLedgerAdmission({
            sourceId,
            messageId: sourceId,
            threadId: source.threadId,
            owner: { kind: 'user', userId: 'owner' },
            kind: 'conversation_input',
            from,
            targetCatIds: ['opus'],
            requestedTargetCats: ['opus'],
            content: source.content,
            intent: 'execute',
            ownerAuthProvenance: 'strict',
            enqueuedAt: 100,
          }),
        ledger,
      );
      assert.equal(
        (await ledger.list('thread')).find((row) => row.payload.messageId === legacy.message.id)?.payload
          .clientMessageId,
        undefined,
      );
      const replay = await queue.send(
        reopened,
        { ...legacySource, clientMessageId: 'legacy-key' },
        { ...input, idempotencyKey: 'legacy-key' },
      );
      assert.equal(replay.deduped, true);
      assert.equal(replay.message.id, legacy.message.id);
      assert.equal(replay.message.clientMessageId, undefined, 'old rows need no rewrite');
      assert.equal((await ledger.list('thread')).length, 2);
    } finally {
      await redis.quit(); // Leave this test's persistent namespace for inspection; never flush another store.
    }
  },
);
