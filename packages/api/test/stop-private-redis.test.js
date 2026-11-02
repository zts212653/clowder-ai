import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

const owned = ownedRedisFixture('stop-private');

test('Redis Stop survives a reader restart without recreating notices, inputs, or invocation work', async (t) => {
  const prefix = `stop:${randomUUID()}:`;
  const client = owned.client(prefix);
  const h = await stopFixture(t, {
    ledger: new RedisQueueLedgerStore(client),
    messages: new RedisMessageStore(client, { ttlSeconds: 0 }),
  });
  const notice = await h.messages.append({
    from: { kind: 'system', service: 'worktree-lifecycle' },
    userId: 'owner',
    threadId: 'thread',
    content: 'A retained worktree requires owner action',
    mentions: [],
    timestamp: Date.now(),
  });
  const input = h.privateInput('persisted-hidden');
  await h.queue.enqueueDurable(input);
  assert.equal((await h.stop()).statusCode, 200);
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
  assert.deepEqual(h.starts, ['active']);
  const nextClient = owned.client(prefix);
  const queue = new InvocationQueue(new RedisQueueLedgerStore(nextClient));
  await queue.hydrateFromLedger();
  assert.deepEqual(queue.list('thread', 'owner'), []);
  assert.equal((await queue.enqueueDurable(input)).deduped, true);
  assert.deepEqual(queue.list('thread', 'owner'), []);
  const messages = new RedisMessageStore(nextClient, { ttlSeconds: 0 });
  assert.deepEqual(await messages.getById(notice.id), notice);
  const keys = await client.keys('*');
  const receipts = keys.filter((key) => key.includes('private-admissions'));
  assert.ok(receipts.length > 0);
  for (const key of [...receipts, `${prefix}msg:${notice.id}`])
    assert.equal(
      await client.ttl(key.slice(prefix.length)),
      -1,
      'user-visible history and replay receipts do not expire',
    );
});

test('Redis partial Stop compares producer replays against the original receipt, not the remaining targets', async (t) => {
  const client = owned.client(`partial:${randomUUID()}:`);
  const h = await stopFixture(t, { idle: true, ledger: new RedisQueueLedgerStore(client) });
  const input = h.privateInput('shared-original', { targetCats: ['opus', 'codex'] });
  const { entry } = await h.queue.enqueueDurable(input);
  await h.processor.retirePendingPrivateInputs('thread', 'owner', 'opus');
  const reopened = new InvocationQueue(new RedisQueueLedgerStore(client));
  await reopened.hydrateFromLedger();
  assert.equal((await reopened.enqueueDurable(input)).deduped, true);
  assert.deepEqual((await reopened.getDurableEntry('thread', entry.id)).targets, ['codex']);
  await assert.rejects(() => reopened.enqueueDurable({ ...input, content: 'changed payload' }), /identity conflict/i);
  await assert.rejects(() => reopened.enqueueDurable({ ...input, targetCats: ['codex'] }), /identity conflict/i);
});
