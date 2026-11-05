import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

for (const queueWake of [false, true]) {
  test(`a stale dot input snapshot cannot terminalize or enqueue: wake=${queueWake}`, async () => {
    const messages = new MessageStore();
    const response = await appendTestLifecycleResponseSource(messages, {
      userId: 'owner',
      threadId: 'thread',
      catId: createCatId('codex'),
      invocationId: 'child',
      timestamp: 100,
    });
    assert.equal(response.lifecycle?.kind, 'response');
    response.lifecycle!.inputMessageIds = ['initial', 'late-ask'];
    const patch = {
      invocationId: 'child',
      status: 'completed' as const,
      completedAt: 200,
      content: 'answer',
      mentions: [createCatId('gpt-dot')],
      expectedInputMessageIds: ['initial'],
    };
    const queue = new InvocationQueue(new InMemoryQueueLedgerStore());
    const input = {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'agent' as const, catId: createCatId('codex') },
      content: 'answer',
      kind: 'message_wake' as const,
      ownerAuthProvenance: 'strict' as const,
      targetCats: [createCatId('gpt-dot')],
      intent: 'execute' as const,
    };
    if (queueWake) {
      await assert.rejects(
        queue.terminalizeResponseAndEnqueueDurable(messages, response.id, patch, input),
        /inputs_changed/,
      );
      assert.equal(queue.list('thread', 'owner').length, 0, 'no partial Queue wake');
    } else {
      const stale = messages.commitLifecycleResponseTerminal(response.id, patch);
      assert.equal(stale.kind, 'conflict');
      assert.equal(stale.kind === 'conflict' && stale.reason, 'inputs_changed');
    }
    assert.equal(messages.getById(response.id)?.lifecycle?.status, 'processing');
    assert.equal(messages.getById(response.id)?.content, response.content);
    patch.expectedInputMessageIds = ['initial', 'late-ask'];
    if (queueWake) {
      assert.equal(
        (await queue.terminalizeResponseAndEnqueueDurable(messages, response.id, patch, input)).outcome,
        'enqueued',
      );
      assert.equal(queue.list('thread', 'owner').length, 1);
    } else assert.equal(messages.commitLifecycleResponseTerminal(response.id, patch).kind, 'applied');
    const completed = messages.getById(response.id);
    assert.equal(completed?.lifecycle?.status, 'completed');
    assert.equal(
      JSON.stringify(completed).includes('expectedInputMessageIds'),
      false,
      'the snapshot fence is not persisted',
    );
  });
}
