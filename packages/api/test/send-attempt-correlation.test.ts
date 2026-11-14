import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { projectPublicQueueEntry } from '../src/utils/queue-enrichment.js';

test('HTTP atomic Queue admission echoes the client key, independently of its server source id and cache restart', async () => {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const messages = new MessageStore();
  const from = { kind: 'user' as const, userId: 'owner' };
  const key = 'browser-attempt-key';
  const message = {
    from,
    userId: 'owner',
    threadId: 'thread',
    content: 'queued input',
    mentions: ['opus'],
    deliveryStatus: 'queued' as const,
    idempotencyKey: key,
    timestamp: 100,
  };
  const input = {
    from,
    userId: 'owner',
    threadId: 'thread',
    content: message.content,
    kind: 'conversation_input' as const,
    intent: 'execute',
    targetCats: ['opus'],
    ownerAuthProvenance: 'strict' as const,
    idempotencyKey: key,
  };
  const admitted = await queue.send(messages, message, input);
  assert.equal(admitted.outcome, 'enqueued');
  assert.ok(admitted.message);
  const rows = await ledger.list('thread');
  assert.equal(rows[0]?.payload.sourceRecordId, admitted.message.id, 'canonical ledger source retains server identity');
  const dto = projectPublicQueueEntry(rows[0]!);
  assert.equal(dto.clientMessageId, key, 'queue-first must echo the key the browser already knows');
  assert.notEqual(dto.clientMessageId, dto.messageId);
  const replay = await queue.send(messages, message, input);
  assert.equal(replay.deduped, true);
  assert.equal((await ledger.list('thread')).length, 1);
  assert.equal(projectPublicQueueEntry((await ledger.list('thread'))[0]!).clientMessageId, key);
});
