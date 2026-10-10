import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { CollectiveWorkDispatcher } from '../src/domains/plugin/builtin-runtime/collective-work-dispatcher.ts';

// Real Work writer + atomic Queue/Message seam; current-context permission is a
// deterministic domain port, not a claim about a real Collective grant/provider.
function fixture() {
  const messages = new MessageStore();
  const state = { available: true, notifications: 0 };
  const queue = new InvocationQueue(undefined, {
    onAdmitted: () => {
      state.notifications++;
    },
  });
  const dispatcher = new CollectiveWorkDispatcher({
    messageStore: messages,
    invocationQueue: queue,
    threadStore: { get: async () => ({ createdBy: 'isolated-owner', participants: ['codex'] }) },
    context: () => ({ resolvePrivate: async () => (state.available ? { admitted: true } : null) }),
  });
  const task = {
    id: 'isolated-task',
    threadId: 'isolated-work',
    userId: 'isolated-owner',
    ownerCatId: 'codex',
    entrustedWork: { revision: 1, intendedOutcome: 'owned work' },
  };
  return { messages, queue, state, dispatcher, task };
}
test('real Work producer writes narrow unknown scope, immutable receipt and one pending source on replay', async () => {
  const f = fixture();
  const first = await f.dispatcher.dispatch(f.task, f.task.userId, 1, { kind: 'admission' });
  const repeated = await f.dispatcher.dispatch(f.task, f.task.userId, 1, { kind: 'admission' });
  assert.equal(repeated.messageId, first.messageId);
  const [entry] = f.queue.list(f.task.threadId, f.task.userId);
  assert.equal(entry.execution.ownerAuthProvenance, 'unknown');
  assert.equal(entry.execution.executionScope, 'collective-work');
  assert.deepEqual(entry.from, { kind: 'system', service: 'collective-work' });
  assert.equal(f.messages.getById(first.messageId).extra.collectiveWorkInvocationV1.taskId, f.task.id);
  assert.deepEqual(f.queue.getQueuedBodyMessagesForCat(f.task.threadId, f.task.userId, 'codex'), []);
  assert.equal(f.state.notifications, 1);
});
test('idempotent Work retry rechecks domain authority without relabeling or starting again', async () => {
  const f = fixture();
  const first = await f.dispatcher.dispatch(f.task, f.task.userId, 1, { kind: 'admission' });
  f.state.available = false;
  await assert.rejects(f.dispatcher.dispatch(f.task, f.task.userId, 1, { kind: 'admission' }), {
    code: 'OWNER_ADMISSION_UNAVAILABLE',
  });
  assert.equal(f.state.notifications, 1);
  assert.equal(f.queue.list(f.task.threadId, f.task.userId).length, 1);
  assert.equal(f.messages.getById(first.messageId).deliveryStatus, 'queued');
});
