import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { buildQueueEntry } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import { authRecordFromRedisHash } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';

const publicInput = {
  userId: 'owner',
  threadId: 'thread',
  content: 'Public request',
  targetCats: ['codex-astra'],
  source: 'connector',
  intent: 'execute',
  ownerAuthProvenance: 'unknown',
  executionScope: 'collective-participation',
};

test('Queue rejects public owner escalation and unowned private Work before persistence', () => {
  const queue = new InvocationQueue();
  assert.throws(() => queue.enqueue({ ...publicInput, ownerAuthProvenance: 'strict' }), /scope/i);
  assert.throws(() => queue.enqueue({ ...publicInput, executionScope: 'collective-work' }), /scope/i);
  assert.throws(() => queue.enqueue({ ...publicInput, targetCats: ['codex-astra', 'opus'] }), /scope/i);
});

test('Queue restart retains singleton origin and scope; adjacent Channel requests never coalesce', () => {
  const queue = new InvocationQueue();
  const a = queue.enqueue({ ...publicInput, idempotencyKey: 'public:A' });
  const b = queue.enqueue({ ...publicInput, idempotencyKey: 'public:B', content: 'B private to another public scope' });
  assert.notEqual(a.entry.id, b.entry.id);
  const custody = createInitialQueuedMessageCustody(a.entry);
  const message = {
    id: 'message:A',
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    content: 'Only A',
    timestamp: 1,
    queueCustody: custody,
  };
  const restored = buildQueueEntry([structuredClone(message)], a.entry.id);
  assert.equal(restored.executionScope, 'collective-participation');
  assert.equal(restored.ownerAuthProvenance, 'unknown');
  assert.equal(restored.source, 'connector');
  assert.equal(restored.messageId, message.id);
  assert.throws(
    () => buildQueueEntry([message, { ...message, id: 'message:B', content: 'B' }], a.entry.id),
    /scope|singleton/i,
  );
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
