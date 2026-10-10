import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { authRecordFromRedisHash } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const publicInput = {
  userId: 'owner',
  threadId: 'thread',
  content: 'Public request',
  targetCats: ['codex-astra'],
  from: { kind: 'external', connectorId: 'collective' },
  kind: 'conversation_input',
  sourceId: 'public:A',
  intent: 'execute',
  ownerAuthProvenance: 'unknown',
  executionScope: 'collective-participation',
};

test('Queue rejects owner escalation on external participation and private Work producers before persistence', async () => {
  const queue = new InvocationQueue();
  await assert.rejects(queue.enqueueDurable({ ...publicInput, ownerAuthProvenance: 'strict' }), /scope/i);
  await assert.rejects(
    queue.enqueueDurable({ ...publicInput, executionScope: 'collective-work', ownerAuthProvenance: 'strict' }),
    /scope/i,
  );
  await assert.rejects(queue.enqueueDurable({ ...publicInput, targetCats: ['codex-astra', 'opus'] }), /scope/i);
});

test('Queue restart retains singleton origin and scope; adjacent Channel requests never coalesce', async () => {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const messages = new MessageStore();
  const admit = (sourceId, content) =>
    queue.send(
      messages,
      {
        userId: publicInput.userId,
        threadId: publicInput.threadId,
        from: publicInput.from,
        source: {
          connector: 'collective',
          label: 'Collective',
          meta: {
            participation: {
              serviceInstanceId: 'svc_fixture000',
              collectiveId: 'col_fixture000',
              connectionId: 'con_fixture000',
              eventId: 'evt_fixture000',
              catId: publicInput.targetCats[0],
              location: { channelId: 'general' },
              participationRevision: 1,
              actor: { kind: 'human', humanId: 'human_fixture000', displayName: 'Fixture Owner' },
            },
          },
        },
        content,
        mentions: publicInput.targetCats,
        timestamp: Date.now(),
        deliveryStatus: 'queued',
        idempotencyKey: sourceId,
      },
      { ...publicInput, sourceId, idempotencyKey: sourceId, content },
    );
  const a = await admit('public:A', 'Only A');
  const b = await admit('public:B', 'B private to another public scope');
  assert.notEqual(a.entry.id, b.entry.id);
  const restarted = new InvocationQueue(ledger);
  assert.equal(await restarted.hydrateFromLedger(messages), 2);
  const entries = restarted.list('thread', 'owner');
  assert.deepEqual(
    entries.map((e) => e.payload.content),
    ['Only A', 'B private to another public scope'],
  );
  assert.deepEqual(
    entries.map((e) => e.payload.messageId),
    [a.message.id, b.message.id],
  );
  for (const entry of entries) {
    assert.equal(entry.execution.executionScope, 'collective-participation');
    assert.equal(entry.execution.ownerAuthProvenance, 'unknown');
    assert.deepEqual(entry.targets, ['codex-astra']);
  }
  assert.equal(messages.getById(a.message.id).queueCustody, undefined);
});

test('persisted auth corruption cannot detach a public tool policy from its grant', () => {
  const fields = {
    invocationId: 'inv',
    callbackToken: 'token',
    userId: 'owner',
    catId: 'codex-astra',
    threadId: 'thread',
    ownerAuthProvenance: 'strict',
    toolExecutionPolicy: '{"mode":"collective_participation"}',
  };
  assert.equal(authRecordFromRedisHash(fields, new Set()), null);
});
