import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-retired-source-replay');
const senders = [
  { kind: 'user', userId: 'owner' },
  { kind: 'agent', catId: 'opus' },
  { kind: 'external', connectorId: 'test-connector' },
  { kind: 'system', service: 'test-notification' },
];

for (const backend of ['memory', 'redis']) {
  for (const from of senders) {
    test(`${backend} ${from.kind} repeated send retains History owner after Queue retirement`, async () => {
      const redis = backend === 'redis' ? owned.client(`${backend}:${from.kind}:`) : undefined;
      const ledger = redis ? new RedisQueueLedgerStore(redis) : new InMemoryQueueLedgerStore();
      const messages = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
      let resolvable = true;
      let notifications = 0;
      const policy = {
        resolveTargets: async (targets) => {
          assert.equal(resolvable, true, 'a retired source must not resolve a new route');
          return targets;
        },
        onAdmitted: () => {
          notifications++;
        },
      };
      const queue = new InvocationQueue(ledger, policy);
      const message = {
        from,
        userId: 'owner',
        threadId: 'thread',
        content: 'same input',
        mentions: ['codex'],
        timestamp: 100,
        idempotencyKey: 'original-request',
        deliveryStatus: 'queued',
      };
      const input = {
        from,
        userId: 'owner',
        threadId: 'thread',
        content: message.content,
        kind: 'conversation_input',
        targetCats: ['codex'],
        intent: 'execute',
        ownerAuthProvenance: 'strict',
      };
      const first = await queue.send(messages, message, input);
      const response = await messages.append({
        from: { kind: 'agent', catId: 'codex' },
        userId: 'owner',
        threadId: 'thread',
        content: '',
        mentions: [],
        timestamp: 200,
        lifecycle: {
          kind: 'response',
          orderKey: '200:receiver',
          invocationId: 'receiver',
          targetId: 'codex',
          inputEntryIds: [first.entry.id],
          inputMessageIds: [first.message.id],
          startedAt: 200,
          status: 'processing',
        },
      });
      assert.equal((await ledger.claim('thread', first.entry.id, 'claim', 201, 'codex')).outcome, 'claimed');
      assert.equal((await ledger.commit('thread', first.entry.id, 'claim', 'processing', 202)).outcome, 'updated');
      await messages.markDelivered(first.message.id, 202);
      assert.equal(await ledger.get('thread', first.entry.id), null);
      resolvable = false;
      const reloaded = new InvocationQueue(redis ? new RedisQueueLedgerStore(redis) : ledger, policy);
      const reader = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : messages;
      const replays = await Promise.all(Array.from({ length: 8 }, () => reloaded.send(reader, message, input)));
      for (const replay of replays) {
        assert.equal(replay.message.id, first.message.id);
        assert.equal(replay.deduped, true);
        assert.deepEqual(replay.entries, []);
        assert.equal(replay.entry, undefined);
      }
      assert.equal(notifications, 1, 'replays do not notify a second admission/drain');
      assert.deepEqual(await ledger.list('thread'), []);
      assert.equal((await reader.getById(response.id)).lifecycle.status, 'processing', 'original receiver continues');
      await assert.rejects(
        reloaded.send(reader, { ...message, content: 'changed body' }, { ...input, content: 'changed body' }),
        /identity conflict/,
      );
    });
  }
}

test('retired whisper source cannot be replayed as a public envelope', async () => {
  const messages = new MessageStore();
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const from = { kind: 'user', userId: 'owner' };
  const message = {
    from,
    userId: 'owner',
    threadId: 'thread',
    content: 'private',
    mentions: ['codex'],
    visibility: 'whisper',
    whisperTo: ['codex'],
    deliveryStatus: 'queued',
    timestamp: 100,
    idempotencyKey: 'private',
  };
  const input = {
    from,
    userId: 'owner',
    threadId: 'thread',
    content: message.content,
    kind: 'conversation_input',
    targetCats: ['codex'],
    intent: 'execute',
    ownerAuthProvenance: 'strict',
  };
  const first = await queue.send(messages, message, input);
  await ledger.claim('thread', first.entry.id, 'claim', 200, 'codex');
  await ledger.commit('thread', first.entry.id, 'claim', 'processing', 201);
  const { visibility, whisperTo, ...publicReplay } = message;
  void visibility;
  void whisperTo;
  await assert.rejects(queue.send(messages, publicReplay, input), /identity conflict/);
  assert.deepEqual(await ledger.list('thread'), []);
});

for (const backend of ['memory', 'redis']) {
  test(`${backend} receiver can retire the pending row during send replay`, async () => {
    const redis = backend === 'redis' ? owned.client(`${backend}:retirement-race:`) : undefined;
    const ledger = redis ? new RedisQueueLedgerStore(redis) : new InMemoryQueueLedgerStore();
    const messages = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
    let notifications = 0;
    const queue = new InvocationQueue(ledger, {
      onAdmitted: () => {
        notifications++;
      },
    });
    const from = { kind: 'user', userId: 'owner' };
    const message = {
      from,
      userId: 'owner',
      threadId: 'race',
      content: 'already accepted',
      mentions: ['codex'],
      deliveryStatus: 'queued',
      timestamp: 100,
      idempotencyKey: 'retirement-race',
    };
    const input = {
      from,
      userId: 'owner',
      threadId: 'race',
      content: message.content,
      kind: 'conversation_input',
      targetCats: ['codex'],
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    };
    const first = await queue.send(messages, message, input);
    const append = messages.appendWithQueueLedgerAdmission.bind(messages);
    messages.appendWithQueueLedgerAdmission = async (...args) => {
      // Force retirement after send has read the live row but before storage
      // resolves the winning idempotency key; the real store still handles replay.
      await ledger.claim('race', first.entry.id, 'receiver', 200, 'codex');
      await ledger.commit('race', first.entry.id, 'receiver', 'processing', 201);
      return append(...args);
    };
    const replay = await queue.send(messages, message, input);
    assert.equal(replay.message.id, first.message.id);
    assert.equal(replay.deduped, true);
    assert.deepEqual(replay.entries, []);
    assert.equal(replay.entry, undefined);
    assert.equal(notifications, 1);
    assert.deepEqual(await ledger.list('race'), []);
  });
}
