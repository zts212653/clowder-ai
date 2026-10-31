// Connector wait capabilities use common atomic admission. Legacy provisional
// custody/CAS/rollback tests are replaced by the resulting identity and authority contracts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { PersistedQueueDelivery } from '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const carrier = {
  v: 1,
  waitId: 'owned-wait',
  outcomeId: 'owned-wait:g2:matched',
  ownerFence: { kind: 'containing_task', generation: 2 },
};
function input(connector = 'deployment-wait') {
  return {
    ownerUserId: 'isolated-owner',
    threadId: 'isolated-wait',
    targetCatId: 'opus',
    idempotencyKey: 'owned-wait:g2:matched',
    content: 'the owned wait completed',
    source: { connector, label: 'Owned wait', meta: {} },
    ownerAuthProvenance: 'strict',
    sourceCategory: 'scheduled',
    waitContinuationCarrier: carrier,
  };
}
function fixture() {
  const messages = new MessageStore();
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  let progressed = 0;
  const delivery = new PersistedQueueDelivery({
    messages,
    queue,
    progress: async (entry) => {
      // Progress is notified only after both persistent identities are committed.
      assert.equal(messages.getById(entry.payload.messageId).content, entry.payload.content);
      assert.deepEqual(await ledger.get(entry.threadId, entry.id), entry);
      progressed++;
      return 'owned_deferred_busy';
    },
  });
  return {
    messages,
    ledger,
    queue,
    delivery,
    get progressed() {
      return progressed;
    },
  };
}
for (const connector of ['deployment-wait', 'github-wait']) {
  test(`${connector} atomically admits one source and exact typed wait authority`, async () => {
    const f = fixture();
    const envelope = input(connector);
    const [first, replay] = await Promise.all([f.delivery.deliver(envelope), f.delivery.deliver(envelope)]);
    assert.equal(first.message.id, replay.message.id);
    assert.equal(first.entryId, replay.entryId);
    const rows = await f.ledger.list(envelope.threadId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].targets, ['opus']);
    assert.deepEqual(rows[0].execution.waitContinuationCarrier, carrier);
    assert.equal(
      f.messages
        .getByThread(envelope.threadId, 100, envelope.ownerUserId, { includeQueuedUserMessages: true })
        .filter((m) => m.id === first.message.id).length,
      1,
    );
    assert.equal(Object.hasOwn(first.message, 'queueCustody'), false);
    assert.deepEqual(
      f.queue.getQueuedBodyMessagesForCat(envelope.threadId, envelope.ownerUserId, 'opus', 'reader-parent'),
      [],
    );
    assert.equal(
      await f.queue.claimExactExposureDurable(
        envelope.threadId,
        envelope.ownerUserId,
        first.entryId,
        'opus',
        first.message.id,
      ),
      null,
    );
  });
}

test('wait replay cannot acquire a different source, audience, category or owner generation', async () => {
  const f = fixture();
  const envelope = input();
  const first = await f.delivery.deliver(envelope);
  for (const changed of [
    { ...envelope, source: { ...envelope.source, connector: 'foreign' } },
    { ...envelope, visibility: 'whisper', whisperTo: ['opus'] },
  ])
    assert.equal((await f.delivery.deliver(changed)).state, 'conflict');
  for (const changed of [
    { ...envelope, sourceCategory: 'producer_return' },
    { ...envelope, waitContinuationCarrier: { ...carrier, ownerFence: { kind: 'containing_task', generation: 3 } } },
  ])
    await assert.rejects(f.delivery.deliver(changed), /identity conflict/);
  assert.equal((await f.ledger.list(envelope.threadId)).length, 1);
  assert.equal(f.messages.getById(first.message.id).id, first.message.id);
  assert.equal(f.progressed, 1);
});

test('invalid connector envelope cannot publish a source or leave a partial admission', async () => {
  const f = fixture();
  const envelope = input();
  await assert.rejects(f.delivery.deliver({ ...envelope, from: { kind: 'invalid' } }), /sender|from|MessageFrom/i);
  assert.equal(f.messages.getByIdempotencyKey(envelope.ownerUserId, envelope.threadId, envelope.idempotencyKey), null);
  assert.deepEqual(await f.ledger.list(envelope.threadId), []);
  assert.equal(f.progressed, 0);
  assert.equal((await f.delivery.deliver(envelope)).state, 'owned_deferred_busy');
});

test('wait source and authority survive Queue restart without exposing a second owner', async () => {
  const f = fixture();
  const envelope = input();
  const first = await f.delivery.deliver(envelope);
  const restarted = new InvocationQueue(f.ledger);
  await restarted.hydrateFromLedger(f.messages);
  const replay = await new PersistedQueueDelivery({
    messages: f.messages,
    queue: restarted,
    progress: async () => 'owned_deferred_busy',
  }).deliver(envelope);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.entryId, first.entryId);
  assert.deepEqual(
    (await restarted.getDurableEntry(envelope.threadId, replay.entryId)).execution.waitContinuationCarrier,
    carrier,
  );
  assert.deepEqual(
    restarted.getQueuedBodyMessagesForCat(envelope.threadId, envelope.ownerUserId, 'opus', 'reader-parent'),
    [],
  );
});
