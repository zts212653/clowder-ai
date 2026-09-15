import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { ensurePersistedCarrierOwnedAndScheduled } from '../src/domains/cats/services/agents/invocation/PersistedQueueCarrier.js';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import {
  createInitialCrossThreadQueuedMessageCustody,
  createInitialQueuedMessageCustody,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';
import './helpers/setup-cat-registry.js';

const input = {
  ownerUserId: 'operator',
  threadId: 't-review',
  targetCatId: 'codex',
  idempotencyKey: 'review-return',
  content: 'continue the entrusted Task',
  source: { connector: 'content-review', label: 'Review', icon: 'cat-cafe', meta: { reviewReceiptRef: 'receipt:1' } },
};

function fixture(t: { after: (close: () => Promise<void>) => void }) {
  const f = createPersistedQueueFixture();
  t.after(f.close);
  return f;
}

function admitGroup(f: ReturnType<typeof fixture>, contents = [input.content]) {
  const queued = f.queue.enqueue({
    threadId: input.threadId,
    userId: input.ownerUserId,
    ownerAuthProvenance: 'strict',
    content: contents.join('\n'),
    source: 'connector',
    targetCats: [input.targetCatId],
    intent: 'execute',
    idempotencyKey: input.idempotencyKey,
  });
  assert.ok(queued.entry);
  const entry = queued.entry;
  const messages = contents.map((content, index) => {
    const message = f.messages.append({
      userId: input.ownerUserId,
      threadId: input.threadId,
      catId: null,
      content,
      mentions: [createCatId(input.targetCatId)],
      timestamp: entry.createdAt + index,
      deliveryStatus: 'queued',
      source: input.source,
      queueCustody: createInitialQueuedMessageCustody(entry),
      ...(index === 0 ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    f.queue.backfillMessageId(input.threadId, input.ownerUserId, entry.id, message.id);
    return message;
  });
  const ensure = () =>
    ensurePersistedCarrierOwnedAndScheduled(
      {
        messages: f.messages,
        queue: f.queue,
        progress: (carrier, target) => f.processor.progressOwnedCarrier(carrier, target),
      },
      { ...input, sourceMessageId: messages[0]!.id, expectedEntryId: entry.id },
    );
  return { entry, messages, ensure };
}

test('append survives failed backfill/rollback: retry restores the original carrier and one durable child', async (t) => {
  const f = fixture(t);
  const backfill = f.queue.backfillMessageId.bind(f.queue);
  f.queue.backfillMessageId = () => {
    throw new Error('backfill unavailable');
  };
  await assert.rejects(f.delivery.deliver(input), /backfill unavailable/);
  const saved = f.messages.getByIdempotencyKey(input.ownerUserId, input.threadId, input.idempotencyKey);
  assert.ok(saved?.queueCustody);
  assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 0);
  f.queue.backfillMessageId = backfill;
  const recovered = await f.delivery.deliver(input);
  assert.equal(recovered.state, 'started');
  assert.equal(recovered.message?.id, saved.id);
  assert.equal('entryId' in recovered && recovered.entryId, saved.queueCustody.entryId);
  const invocationId = await f.waitForAwakening(saved.id);
  assert.equal((await f.delivery.deliver(input)).state, 'already_processing');
  assert.equal(await f.waitForAwakening(saved.id), invocationId);
  assert.equal(f.records.size, 1);
});

test('append idempotency winning an admission race cannot leave a second process-local queue owner', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  f.queue.rollbackEnqueue(input.threadId, input.ownerUserId, group.entry.id);
  // Another admission committed after this caller's lookup: append still returns the canonical old carrier.
  const find = f.messages.getByIdempotencyKey.bind(f.messages);
  let first = true;
  f.messages.getByIdempotencyKey = (...args) => {
    if (first) {
      first = false;
      return null;
    }
    return find(...args);
  };
  await f.delivery.deliver(input);
  await f.waitForAwakening(group.messages[0]!.id);
  assert.deepEqual(
    f.queue.list(input.threadId, input.ownerUserId).map((entry) => entry.id),
    [group.entry.id],
  );
  assert.equal(f.records.size, 1);
});

test('an unrelated queue completion cannot start a producer reservation before durable message admission', async (t) => {
  const f = fixture(t);
  let entered!: () => void, release!: () => void;
  const appending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = new PersistedQueueDelivery({
    queue: f.queue,
    progress: (entry, catId) => f.processor.progressOwnedCarrier(entry, catId),
    messages: {
      getById: f.messages.getById.bind(f.messages),
      getByIdempotencyKey: f.messages.getByIdempotencyKey.bind(f.messages),
      getByThreadAfter: f.messages.getByThreadAfter.bind(f.messages),
      async append(message) {
        entered();
        await barrier;
        return f.messages.append(message);
      },
    },
  });
  const delivering = delivery.deliver(input);
  await appending;
  await f.processor.onInvocationComplete(input.threadId, input.targetCatId, 'succeeded');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const earlyStarts = f.records.size;
  release();
  const result = await delivering;
  assert.equal(earlyStarts, 0, 'Dispatch must not create an invocation before durable admission');
  assert.ok(result.message);
  await f.waitForAwakening(result.message.id);
  assert.equal(f.records.size, 1);
});

test('recovery uses the complete ordered merged group and keeps the exact entry identity', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f, ['first source', 'second source']);
  f.queue.rollbackEnqueue(input.threadId, input.ownerUserId, group.entry.id);
  assert.equal((await group.ensure()).state, 'started');
  const entry = f.queue.getEntrySnapshot(input.threadId, input.ownerUserId, group.entry.id);
  assert.equal(entry?.content, 'first source\nsecond source');
  assert.equal(entry?.messageId, group.messages[0]!.id);
  assert.deepEqual(entry?.mergedMessageIds, [group.messages[1]!.id]);
  const first = await f.waitForAwakening(group.messages[0]!.id);
  assert.equal(await f.waitForAwakening(group.messages[1]!.id), first);
  assert.equal(f.records.size, 1);
});

for (const failure of ['missing sibling', 'timeline unavailable'])
  test(`${failure} cannot restore or start a partial carrier`, async (t) => {
    const f = fixture(t);
    const group = admitGroup(f, ['first', 'second']);
    f.queue.rollbackEnqueue(input.threadId, input.ownerUserId, group.entry.id);
    if (failure === 'missing sibling') {
      const get = f.messages.getById.bind(f.messages);
      f.messages.getById = (id) => (id === group.messages[1]!.id ? null : get(id));
    } else
      f.messages.getByThreadAfter = () => {
        throw new Error('store unavailable');
      };
    assert.equal((await group.ensure()).state, 'unavailable');
    assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 0);
    assert.equal(f.records.size, 0);
  });

test('an existing live row must match its complete durable scheduling projection', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  f.queue.setPosition(input.threadId, input.ownerUserId, group.entry.id, -10);
  assert.equal((await group.ensure()).state, 'conflict');
  assert.equal(f.records.size, 0);
  assert.equal(f.queue.getEntrySnapshot(input.threadId, input.ownerUserId, group.entry.id)?.position, -10);
  f.queue.rollbackEnqueue(input.threadId, input.ownerUserId, group.entry.id);
  f.queue.restoreDurableEntry({
    ...group.entry,
    messageId: group.messages[0]!.id,
    queuedAttemptIdByCatId: { [input.targetCatId]: 'a-different-retry-attempt' },
  });
  assert.equal((await group.ensure()).state, 'conflict', 'a different attempt id cannot inherit durable custody');
  assert.equal(f.records.size, 0);
});

test('manual pause and its epoch survive producer recovery; explicit resume runs the same carrier', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  await f.processor.onInvocationComplete(input.threadId, input.targetCatId, 'canceled_by_user', undefined, [], true);
  assert.equal(f.processor.isPaused(input.threadId, input.targetCatId), true);
  const epoch = new Map(Reflect.get(f.processor, 'pauseEpoch') as Map<string, number>);
  assert.equal((await group.ensure()).state, 'owned_deferred_paused');
  assert.deepEqual(Reflect.get(f.processor, 'pauseEpoch'), epoch);
  assert.equal(f.records.size, 0);
  const resumed = await f.processor.processNext(input.threadId, input.ownerUserId);
  assert.equal(resumed.entry?.id, group.entry.id);
  await f.waitForAwakening(group.messages[0]!.id);
  assert.equal(f.records.size, 1);
});

test('force-reset suppression survives producer recovery until explicit canonical resume', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  f.processor.suppressAutoResume(input.threadId, input.targetCatId, ['reset-owner']);
  assert.equal((await group.ensure()).state, 'owned_deferred_suppressed');
  assert.equal(f.processor.isAutoResumeSuppressed(input.threadId, input.targetCatId), true);
  assert.equal(f.records.size, 0);
  assert.equal((await f.processor.processNext(input.threadId, input.ownerUserId)).entry?.id, group.entry.id);
  await f.waitForAwakening(group.messages[0]!.id);
});

test('busy ownership defers without forking, and normal slot completion progresses the original carrier', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  const controller = f.tracker.start(input.threadId, input.targetCatId);
  assert.equal((await group.ensure()).state, 'owned_deferred_busy');
  assert.equal(f.records.size, 0);
  f.tracker.complete(input.threadId, input.targetCatId, controller);
  await f.processor.onInvocationComplete(input.threadId, input.targetCatId, 'succeeded');
  await f.waitForAwakening(group.messages[0]!.id);
  assert.equal(f.records.size, 1);
});

test('withdrawn custody is accepted as terminal ownership without a substitute carrier', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  await f.coordinator.withdrawEntry(f.queue.getEntrySnapshot(input.threadId, input.ownerUserId, group.entry.id)!);
  f.queue.rollbackEnqueue(input.threadId, input.ownerUserId, group.entry.id);
  assert.equal((await group.ensure()).state, 'terminal_owned');
  assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 0);
  assert.equal(f.records.size, 0);
});

test('same-id live custody in another user scope is a conflict, never an existing-owner success', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  f.queue.rollbackEnqueue(input.threadId, input.ownerUserId, group.entry.id);
  f.queue.restoreDurableEntry({ ...group.entry, userId: 'another-owner' });
  assert.equal((await group.ensure()).state, 'conflict');
  assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 0);
  assert.equal(f.records.size, 0);
});

test('failed custody keeps its existing retry authority without automatic producer replay', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  const entry = f.queue.getEntrySnapshot(input.threadId, input.ownerUserId, group.entry.id)!;
  await f.coordinator.persistEntry({ ...entry, queuedFailedByCatIds: [input.targetCatId] });
  assert.equal((await group.ensure()).state, 'terminal_owned');
  assert.equal(f.records.size, 0);
});

test('producer recovery keeps F175 priority across users instead of jumping to its own return', async (t) => {
  const f = fixture(t);
  const group = admitGroup(f);
  const older = f.queue.enqueue({
    threadId: input.threadId,
    userId: 'another-owner',
    ownerAuthProvenance: 'strict',
    content: 'earlier urgent work',
    source: 'connector',
    targetCats: [input.targetCatId],
    intent: 'execute',
    priority: 'urgent',
  });
  assert.ok(older.entry);
  const message = f.messages.append({
    userId: 'another-owner',
    threadId: input.threadId,
    catId: null,
    content: older.entry.content,
    mentions: [createCatId(input.targetCatId)],
    timestamp: older.entry.createdAt,
    deliveryStatus: 'queued',
    source: input.source,
    queueCustody: createInitialQueuedMessageCustody(older.entry),
  });
  f.queue.backfillMessageId(input.threadId, 'another-owner', older.entry.id, message.id);
  assert.equal((await group.ensure()).state, 'owned_deferred_busy');
  await f.waitForAwakening(message.id);
  assert.equal(f.messages.getById(group.messages[0]!.id)?.queueCustody?.awakenedInvocationIdByCatId, undefined);
  assert.equal(f.records.size, 1);
});

test('fanout recovery derives the target carrier from custody and retains the other target ownership', async (t) => {
  const f = fixture(t);
  const source = f.messages.append({
    userId: input.ownerUserId,
    threadId: input.threadId,
    catId: createCatId('opus'),
    content: 'shared fanout source',
    mentions: [createCatId('codex'), createCatId('opus')],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  const entries = ['codex', 'opus'].map((catId) => {
    const result = f.queue.enqueue({
      threadId: input.threadId,
      userId: input.ownerUserId,
      ownerAuthProvenance: 'strict',
      content: source.content,
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aTriggerMessageId: source.id,
    });
    assert.ok(result.entry);
    f.queue.backfillMessageId(input.threadId, input.ownerUserId, result.entry.id, source.id);
    return f.queue.getEntrySnapshot(input.threadId, input.ownerUserId, result.entry.id)!;
  });
  f.messages.initializeQueueCustody(source.id, createInitialCrossThreadQueuedMessageCustody(source.id, entries));
  f.queue.rollbackEnqueue(input.threadId, input.ownerUserId, entries[0]!.id);
  f.tracker.start(input.threadId, 'codex');
  const result = await ensurePersistedCarrierOwnedAndScheduled(
    {
      messages: f.messages,
      queue: f.queue,
      progress: (entry, catId) => f.processor.progressOwnedCarrier(entry, catId),
    },
    { ...input, sourceMessageId: source.id },
  );
  assert.equal(result.state, 'owned_deferred_busy');
  assert.equal('entryId' in result && result.entryId, entries[0]!.id);
  assert.equal(f.queue.getEntrySnapshot(input.threadId, input.ownerUserId, entries[0]!.id)?.sourceCategory, 'a2a');
  assert.deepEqual(f.queue.getEntrySnapshot(input.threadId, input.ownerUserId, entries[1]!.id), entries[1]);
  assert.equal(f.records.size, 0);
});
