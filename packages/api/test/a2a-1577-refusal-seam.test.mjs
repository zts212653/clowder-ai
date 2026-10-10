import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollectivePrivateWorkRefusalError } from '../src/domains/cats/services/agents/invocation/collective-private-refusal.ts';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { retireRefusedCollectiveQueueCarrier } from '../src/domains/cats/services/agents/invocation/queue-private-refusal-disposition.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { CollectiveWorkDispatcher } from '../src/domains/plugin/builtin-runtime/collective-work-dispatcher.ts';

// Actual Host producer, canonical Message and owned in-memory pending ledger.
// This does not exercise a real grant, Redis or provider execution.
async function fixture() {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const messages = new MessageStore();
  const dispatcher = new CollectiveWorkDispatcher({
    messageStore: messages,
    invocationQueue: queue,
    threadStore: { get: async () => ({ createdBy: 'isolated-owner', participants: ['codex'] }) },
    context: () => ({ resolvePrivate: async () => ({ admitted: true }) }),
  });
  const task = {
    id: 'refusal-task',
    threadId: 'refusal-thread',
    userId: 'isolated-owner',
    ownerCatId: 'codex',
    entrustedWork: { revision: 1, intendedOutcome: 'isolated refusal' },
  };
  const receipt = await dispatcher.dispatch(task, task.userId, 1, { kind: 'admission' });
  const [pending] = queue.list(task.threadId, task.userId);
  const entry = await queue.claimQueuedEntryForWithdrawal(task.threadId, task.userId, pending.id);
  assert.equal(entry.status, 'claimed');
  let evidenceWrites = 0;
  const input = {
    entry,
    queue,
    messages,
    refusal: new CollectivePrivateWorkRefusalError('work_execution_not_current', 'isolated stale authority'),
    persistRefusal: async () => {
      evidenceWrites++;
    },
  };
  return { ...input, input, ledger, receipt, evidenceWrites: () => evidenceWrites };
}

test('proven pre-provider refusal retires only the claimed canonical source after durable evidence', async () => {
  const f = await fixture();
  assert.equal(await retireRefusedCollectiveQueueCarrier(f.input), true);
  assert.equal(f.evidenceWrites(), 1);
  assert.equal(f.messages.getById(f.receipt.messageId).deliveryStatus, 'canceled');
  assert.deepEqual(await f.ledger.list(f.entry.threadId), []);
  const restarted = new InvocationQueue(f.ledger);
  await restarted.hydrateFromLedger(f.messages);
  assert.deepEqual(restarted.list(f.entry.threadId, 'isolated-owner'), []);
});
test('refusal evidence failure retains the exact pending claim and does not cancel the source', async () => {
  const f = await fixture();
  await assert.rejects(
    retireRefusedCollectiveQueueCarrier({
      ...f.input,
      persistRefusal: async () => {
        throw new Error('isolated evidence failure');
      },
    }),
    /isolated evidence failure/,
  );
  assert.equal(f.messages.getById(f.receipt.messageId).deliveryStatus, 'queued');
  assert.equal((await f.ledger.get(f.entry.threadId, f.entry.id)).status, 'claimed');
});
test('failed source cancellation does not retire pending work', async () => {
  const f = await fixture();
  await assert.rejects(
    retireRefusedCollectiveQueueCarrier({
      ...f.input,
      messages: {
        getById: (id) => f.messages.getById(id),
        getByIdempotencyKey: (...args) => f.messages.getByIdempotencyKey(...args),
        markCanceled: async () => null,
      },
    }),
    /cancellation did not commit/,
  );
  assert.equal((await f.ledger.get(f.entry.threadId, f.entry.id)).status, 'claimed');
  assert.equal(f.evidenceWrites(), 1);
});
test('changed claim cannot borrow a stale refusal snapshot or publish refusal evidence', async () => {
  const f = await fixture();
  assert.equal(await f.queue.restoreClaimedEntries(f.entry.threadId, [f.entry.id]), true);
  await assert.rejects(retireRefusedCollectiveQueueCarrier(f.input), /exact.*claim|claim.*changed/);
  assert.equal(f.evidenceWrites(), 0);
  assert.equal(f.messages.getById(f.receipt.messageId).deliveryStatus, 'queued');
});
for (const [label, mutate] of [
  [
    'different sender',
    (e) => {
      e.from = { kind: 'system', service: 'other' };
    },
  ],
  [
    'ordinary input',
    (e) => {
      delete e.execution.executionScope;
    },
  ],
])
  test(`refusal cannot retire ${label}`, async () => {
    const f = await fixture();
    const entry = structuredClone(f.entry);
    mutate(entry);
    await assert.rejects(retireRefusedCollectiveQueueCarrier({ ...f.input, entry }));
    assert.equal(f.evidenceWrites(), 0);
    assert.equal(f.messages.getById(f.receipt.messageId).deliveryStatus, 'queued');
  });
