import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveQueueTurnCustodyWake } from '../src/domains/ball-custody/turn-custody-wake-provenance.js';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { ensurePersistedCarrierOwnedAndScheduled } from '../src/domains/cats/services/agents/invocation/PersistedQueueCarrier.js';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';
import './helpers/setup-cat-registry.js';

const input = {
  ownerAuthProvenance: 'strict' as const,
  ownerUserId: 'operator',
  threadId: 't-review',
  targetCatId: 'codex',
  idempotencyKey: 'review-return',
  content: 'continue the entrusted Task',
  source: { connector: 'content-review', label: 'Review', icon: 'cat-cafe', meta: { reviewReceiptRef: 'receipt:1' } },
};

function fixture(progress: 'started' | 'owned_deferred_busy' = 'started') {
  const messages = new MessageStore();
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const progressed: string[] = [];
  const delivery = new PersistedQueueDelivery({
    messages,
    queue,
    progress: async (entry) => {
      progressed.push(entry.id);
      return progress;
    },
  });
  return { messages, ledger, queue, delivery, progressed };
}
function consumerFixture(t: { after: (close: () => Promise<void>) => void }) {
  const f = createPersistedQueueFixture();
  t.after(f.close);
  return f;
}

test('producer delivery atomically persists one Message and canonical Queue row', async () => {
  const f = fixture();
  const delivered = await f.delivery.deliver(input);
  assert.equal(delivered.state, 'started');
  assert.ok(delivered.message);
  assert.equal(delivered.message.deliveryStatus, 'queued');
  assert.equal(Object.hasOwn(delivered.message, 'queueCustody'), false, 'History must not mirror Queue ledger state');
  assert.ok('entryId' in delivered);
  const entry = await f.queue.getDurableEntry(input.threadId, delivered.entryId);
  assert.equal(entry?.payload.messageId, delivered.message.id);
  assert.deepEqual(entry?.targets, [input.targetCatId]);
  assert.deepEqual(f.progressed, [delivered.entryId]);
});

test('idempotent producer replay reuses the same Message and Queue identity', async () => {
  const f = fixture('owned_deferred_busy');
  const first = await f.delivery.deliver(input);
  const replay = await f.delivery.deliver(input);
  assert.equal(first.message?.id, replay.message?.id);
  assert.ok('entryId' in first && 'entryId' in replay);
  assert.equal(first.entryId, replay.entryId);
  assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 1);
});

test('an idempotency collision with a different immutable envelope fails closed', async () => {
  const f = fixture();
  await f.delivery.deliver(input);
  const conflict = await f.delivery.deliver({ ...input, content: 'different content' });
  assert.equal(conflict.state, 'conflict');
  assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 1);
});

test('recovery schedules only exact persisted source and Queue coordinates', async () => {
  const f = fixture();
  const admitted = await f.delivery.deliver(input);
  assert.ok(admitted.message && 'entryId' in admitted);
  const progress = async () => 'owned_deferred_busy' as const;
  const exact = await ensurePersistedCarrierOwnedAndScheduled(
    { messages: f.messages, queue: f.queue, progress },
    { ...input, sourceMessageId: admitted.message.id, expectedEntryId: admitted.entryId },
  );
  assert.deepEqual(exact, { state: 'owned_deferred_busy', entryId: admitted.entryId });

  const missingIdentity = await ensurePersistedCarrierOwnedAndScheduled(
    { messages: f.messages, queue: f.queue, progress },
    { ...input, sourceMessageId: admitted.message.id },
  );
  assert.equal(missingIdentity.state, 'conflict');

  const wrongTarget = await ensurePersistedCarrierOwnedAndScheduled(
    { messages: f.messages, queue: f.queue, progress },
    { ...input, targetCatId: 'opus', sourceMessageId: admitted.message.id, expectedEntryId: admitted.entryId },
  );
  assert.equal(wrongTarget.state, 'conflict');
});

test('claimed carrier is recognized as already processing without another progress request', async () => {
  const f = fixture();
  const admitted = await f.delivery.deliver(input);
  assert.ok(admitted.message && 'entryId' in admitted);
  const claimed = await f.queue.claimExactSteerEntryDurable(
    input.threadId,
    input.ownerUserId,
    admitted.entryId,
    input.targetCatId,
  );
  assert.equal(claimed.outcome, 'claimed');
  let progressed = false;
  const result = await ensurePersistedCarrierOwnedAndScheduled(
    {
      messages: f.messages,
      queue: f.queue,
      progress: async () => {
        progressed = true;
        return 'started';
      },
    },
    { ...input, sourceMessageId: admitted.message.id, expectedEntryId: admitted.entryId },
  );
  assert.deepEqual(result, { state: 'already_processing', entryId: admitted.entryId });
  assert.equal(progressed, false);
});

test('a producer that states no provenance fails closed as unknown, never strict', async () => {
  const f = fixture();
  const delivered = await f.delivery.deliver({ ...input, ownerAuthProvenance: undefined });
  assert.ok('entryId' in delivered);
  const entry = await f.queue.getDurableEntry(input.threadId, delivered.entryId);
  assert.equal(
    entry?.execution.ownerAuthProvenance,
    'unknown',
    'strict is what grants a ManagedWorkBinding, so it must never be inherited by default',
  );
});

test('a producer that owns an authenticated continuation states strict explicitly', async () => {
  const f = fixture();
  const delivered = await f.delivery.deliver({ ...input, ownerAuthProvenance: 'strict' });
  assert.ok('entryId' in delivered);
  const entry = await f.queue.getDurableEntry(input.threadId, delivered.entryId);
  assert.equal(entry?.execution.ownerAuthProvenance, 'strict');
});

test('producer delivery preserves explicit unknown owner proof in the canonical execution', async (t) => {
  const f = consumerFixture(t);
  const result = await f.delivery.deliver({ ...input, ownerAuthProvenance: 'unknown' });
  assert.ok(result.message);
  const child = await f.waitForAwakening(result.message.id);
  const turn = f.turns.get(child);
  assert.ok(turn);
  assert.equal(f.starts.find((start) => start.invocationId === child)?.ownerAuthProvenance, 'unknown');
  assert.equal(Object.hasOwn(result.message, 'queueCustody'), false);
});

test('lost atomic admission acknowledgement recovers one original source, row and exact child', async (t) => {
  const f = consumerFixture(t);
  const append = f.messages.appendWithQueueLedgerAdmission.bind(f.messages);
  f.messages.appendWithQueueLedgerAdmission = (...args) => {
    append(...args);
    throw new Error('fixture lost atomic admission acknowledgement');
  };
  await assert.rejects(f.delivery.deliver(input), /lost atomic admission acknowledgement/);
  const saved = f.messages.getByIdempotencyKey(input.ownerUserId, input.threadId, input.idempotencyKey);
  assert.ok(saved);
  assert.equal(Object.hasOwn(saved, 'queueCustody'), false);
  const [row] = await f.ledger.list(input.threadId);
  assert.equal(row?.payload.messageId, saved.id);
  assert.equal(f.starts.length, 0);
  f.messages.appendWithQueueLedgerAdmission = append;
  assert.equal(await f.queue.hydrateFromLedger(f.messages), 1);
  const recovered = await f.delivery.deliver(input);
  assert.ok(
    ['started', 'already_processing'].includes(recovered.state),
    'normal drain must own the exact restored reservation',
  );
  const child = await f.waitForAwakening(saved.id);
  assert.equal(recovered.message?.id, saved.id);
  assert.equal('entryId' in recovered && recovered.entryId, row.id);
  assert.equal((await f.delivery.deliver(input)).state, 'already_processing');
  assert.equal(await f.waitForAwakening(saved.id), child);
  assert.equal(f.records.size, 1);
  assert.equal(f.starts.length, 1);
});

test('validation failure rolls back atomic work: no orphan Message, Queue row or provider start', async (t) => {
  const f = consumerFixture(t);
  await assert.rejects(
    f.delivery.deliver({ ...input, from: { kind: 'invalid' } as never }),
    /sender|MessageFrom|from/i,
  );
  assert.equal(f.messages.getByIdempotencyKey(input.ownerUserId, input.threadId, input.idempotencyKey), null);
  assert.deepEqual(await f.ledger.list(input.threadId), []);
  assert.equal(f.starts.length, 0);
  const recovered = await f.delivery.deliver(input);
  assert.ok(recovered.message);
  await f.waitForAwakening(recovered.message.id);
  assert.equal(f.records.size, 1);
});

test('concurrent idempotent admission leaves one canonical source and child, never a cache-only second owner', async (t) => {
  const f = consumerFixture(t);
  const [first, replay] = await Promise.all([f.delivery.deliver(input), f.delivery.deliver(input)]);
  assert.ok(first.message && replay.message);
  assert.equal(first.message.id, replay.message.id);
  assert.ok('entryId' in first && 'entryId' in replay);
  assert.equal(first.entryId, replay.entryId);
  await f.waitForAwakening(first.message.id);
  assert.equal(f.records.size, 1);
  assert.equal(f.starts.length, 1);
  assert.equal((await f.messages.getByThread(input.threadId)).filter((m) => m.id === first.message?.id).length, 1);
});

test('unrelated Queue completion cannot start a reservation before the atomic Message admission', async (t) => {
  const f = consumerFixture(t);
  const append = f.queue.send.bind(f.queue);
  let entered!: () => void, release!: () => void;
  const appending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.queue.send = async (...args) => {
    entered();
    await barrier;
    return append(...args);
  };
  const delivering = f.delivery.deliver(input);
  try {
    await appending;
    await f.processor.onInvocationComplete(input.threadId, input.targetCatId, 'failed', undefined, []);
    assert.deepEqual(await f.ledger.list(input.threadId), []);
    assert.equal(f.starts.length, 0);
    assert.equal(f.messages.getByIdempotencyKey(input.ownerUserId, input.threadId, input.idempotencyKey), null);
  } finally {
    release();
  }
  const result = await delivering;
  assert.ok(result.message);
  await f.waitForAwakening(result.message.id);
  assert.equal(f.starts.length, 1);
});

for (const sourceCategory of ['producer_return', undefined] as const) {
  test(`category ${sourceCategory ?? 'absent'} survives ledger serialization/hydration without inferred authority`, async () => {
    const f = fixture('owned_deferred_busy');
    const delivered = await f.delivery.deliver({ ...input, sourceCategory });
    assert.ok(delivered.message && 'entryId' in delivered);
    const [row] = await f.ledger.list(input.threadId);
    assert.ok(row);
    const persisted = JSON.parse(JSON.stringify(row));
    const restoredLedger = new InMemoryQueueLedgerStore();
    assert.equal((await restoredLedger.enqueue([persisted])).outcome, 'enqueued');
    const restored = new InvocationQueue(restoredLedger);
    assert.equal(await restored.hydrateFromLedger(f.messages), 1);
    const [rebuilt] = restored.list(input.threadId, input.ownerUserId);
    assert.equal(rebuilt?.sourceCategory, sourceCategory);
    assert.equal(rebuilt?.payload.messageId, delivered.message.id);
    assert.equal(rebuilt?.execution.waitContinuationCarrier, undefined);
    assert.equal(Object.hasOwn(delivered.message, 'queueCustody'), false);
    const wake = await resolveQueueTurnCustodyWake(rebuilt, { getById: async () => null } as never);
    assert.equal(wake.kind, sourceCategory ? 'unstructured' : 'legacy');
  });
}
