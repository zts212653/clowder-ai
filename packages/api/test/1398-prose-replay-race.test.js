import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('routing-prose-replay');
function request(mentions = [], extra = { routingTargetSource: 'prose' }) {
  const from = { kind: 'user', userId: 'owner' };
  return [
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      content: '@thread continue',
      mentions,
      extra,
      deliveryStatus: 'queued',
      timestamp: 100,
      idempotencyKey: 'same-request',
    },
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      content: '@thread continue',
      targetCats: mentions,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
    },
  ];
}

for (const backend of ['memory', 'redis']) {
  for (const retire of [false, true]) {
    test(`${backend}: commit after shared send lookup retains prose expansion${retire ? ' after retirement' : ''}`, async () => {
      const redis = backend === 'redis' ? owned.client(`${retire}:`) : undefined;
      const ledger = redis ? new RedisQueueLedgerStore(redis) : new InMemoryQueueLedgerStore();
      const messages = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
      const queue = new InvocationQueue(ledger, {
        resolveTargets: async (targets) => (targets.length ? targets : ['codex']),
      });
      const paused = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const append = messages.appendWithQueueLedgerAdmission.bind(messages);
      let appends = 0;
      messages.appendWithQueueLedgerAdmission = async (...args) => {
        if (++appends === 1) {
          paused.resolve();
          await resume.promise;
        }
        return append(...args);
      };
      // The loser has already passed shared send's idempotency lookup. A competing
      // writer commits while it waits at the real Memory/Redis transaction boundary.
      const [laterMessage, laterInput] = request(['codex', 'gemini']);
      const pending = queue.send(messages, laterMessage, { ...laterInput, intent: 'ideate' });
      await paused.promise;
      const first = await queue.send(messages, ...request());
      if (retire) {
        assert.equal((await ledger.claim('thread', first.entry.id, 'claim', 200, 'codex')).outcome, 'claimed');
        assert.equal((await ledger.commit('thread', first.entry.id, 'claim', 'processing', 201)).outcome, 'updated');
      }
      resume.resolve();
      const replay = await pending;
      assert.equal(replay.message.id, first.message.id);
      assert.deepEqual(replay.message.mentions, []);
      assert.equal(replay.deduped, true);
      const rows = await ledger.list('thread');
      assert.equal(rows.length, retire ? 0 : 1);
      if (!retire) {
        assert.deepEqual(rows[0].targets, ['codex']);
        assert.deepEqual(rows[0].payload.requestedTargetCats, []);
        assert.equal(rows[0].execution.intent, 'execute');
      }
      for (const [messagePatch, inputPatch] of [
        [{ content: 'changed' }, { content: 'changed' }],
        [{ mentions: ['gemini'], extra: { routingTargetSource: 'explicit' } }, { targetCats: ['gemini'] }],
        [{ visibility: 'whisper', whisperTo: ['codex'], extra: {} }, { targetCats: ['codex'] }],
      ]) {
        const [message, input] = request();
        await assert.rejects(
          queue.send(messages, { ...message, ...messagePatch }, { ...input, ...inputPatch }),
          /identity conflict/,
        );
        assert.equal((await ledger.list('thread')).length, retire ? 0 : 1);
      }
    });
  }
  test(`${backend}: an explicit selection cannot be replaced by prose expansion`, async () => {
    const redis = backend === 'redis' ? owned.client('explicit:') : undefined;
    const ledger = redis ? new RedisQueueLedgerStore(redis) : new InMemoryQueueLedgerStore();
    const messages = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
    const queue = new InvocationQueue(ledger);
    await queue.send(messages, ...request(['codex'], { routingTargetSource: 'explicit' }));
    await assert.rejects(queue.send(messages, ...request(['codex'])), /identity conflict/);
    assert.equal((await ledger.list('thread')).length, 1);
  });
}
