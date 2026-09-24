import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InMemoryQueueLedgerStore } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function message(idempotencyKey, content = idempotencyKey) {
  return {
    from: { kind: 'user', userId: 'owner-1' },
    userId: 'owner-1',
    content,
    mentions: ['opus', 'codex'],
    timestamp: 100,
    threadId: 'thread-admission',
    idempotencyKey,
    deliveryStatus: 'queued',
  };
}

function queueInput(idempotencyKey, content = idempotencyKey) {
  return {
    from: { kind: 'user', userId: 'owner-1' },
    threadId: 'thread-admission',
    userId: 'owner-1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    idempotencyKey,
    content,
    targetCats: ['opus', 'codex'],
    intent: 'execute',
  };
}

describe('ADR-043 atomic memory message + Queue admission', () => {
  it('binds the single source row to the exact stored message and replays without duplication', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const messages = new MessageStore();

    const first = await queue.appendAndEnqueueDurable(messages, message('request-1'), queueInput('request-1'));
    assert.equal(first.outcome, 'enqueued');
    assert.equal(first.deduped, false);
    assert.equal(first.entries.length, 1);
    assert.ok(first.entries.every((entry) => entry.payload.messageId === first.message.id));
    assert.deepEqual(
      (await ledger.list('thread-admission')).map((entry) => [entry.payload.sourceRecordId, entry.payload.messageId]),
      [[first.message.id, first.message.id]],
    );

    const replay = await queue.appendAndEnqueueDurable(messages, message('request-1'), queueInput('request-1'));
    assert.equal(replay.outcome, 'enqueued');
    assert.equal(replay.deduped, true);
    assert.equal(replay.message.id, first.message.id);
    assert.equal((await ledger.list('thread-admission')).length, 1);
  });

  it('rejects capacity before persisting either the message or any fan-out row', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const messages = new MessageStore();

    for (let index = 0; index < 5; index += 1) {
      const id = `fill-${index}`;
      assert.equal((await queue.appendAndEnqueueDurable(messages, message(id), queueInput(id))).outcome, 'enqueued');
    }
    const rejected = await queue.appendAndEnqueueDurable(
      messages,
      message('over-capacity'),
      queueInput('over-capacity'),
    );
    assert.deepEqual(rejected, { outcome: 'full' });
    assert.equal(messages.getByIdempotencyKey('owner-1', 'thread-admission', 'over-capacity'), null);
    assert.equal((await ledger.list('thread-admission')).length, 5);
  });
});
