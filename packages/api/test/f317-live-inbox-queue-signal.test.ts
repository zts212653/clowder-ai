import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';

test('Live inbox wakes only after a Queue source is body-addressable and admitted', () => {
  const queue = new InvocationQueue();
  const signals: string[] = [];
  queue.onSourceChanged((threadId, userId) => signals.push(`${threadId}:${userId}`));
  const first = queue.enqueue({
    threadId: 'home',
    userId: 'owner',
    ownerAuthProvenance: 'strict',
    content: 'body',
    source: 'agent',
    targetCats: ['codex-astra'],
    intent: 'execute',
  }).entry;
  assert.ok(first);
  assert.deepEqual(signals, []);
  queue.backfillMessageId('home', 'owner', first.id, 'message-1');
  assert.deepEqual(signals, ['home:owner']);
  const second = queue.enqueue({
    threadId: 'home',
    userId: 'owner',
    ownerAuthProvenance: 'strict',
    content: 'fenced',
    source: 'agent',
    targetCats: ['codex-astra'],
    intent: 'execute',
    messageId: 'message-2',
    queueCustodyAdmissionId: 'admission-2',
  }).entry;
  assert.ok(second);
  assert.equal(signals.length, 1);
  assert.equal(queue.commitQueueCustodyAdmission('home', 'owner', 'admission-2', [second.id]), true);
  assert.deepEqual(signals, ['home:owner', 'home:owner']);
});
